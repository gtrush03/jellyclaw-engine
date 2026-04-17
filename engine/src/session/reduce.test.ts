import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AgentEvent } from "../events.js";
import { projectHash } from "./paths.js";
import { reduceEvents } from "./reduce.js";
import { replayJsonl } from "./replay.js";

// ---------------------------------------------------------------------------
// Event builders — keep tests declarative. seq/ts monotonically increasing.
// ---------------------------------------------------------------------------

class EventStream {
  private seq = 0;
  private ts = 1_700_000_000_000;
  readonly events: AgentEvent[] = [];

  private next(): { seq: number; ts: number } {
    const out = { seq: this.seq, ts: this.ts };
    this.seq += 1;
    this.ts += 10;
    return out;
  }

  sessionStarted(overrides: Partial<{ wish: string; cwd: string; model: string }> = {}): this {
    const { seq, ts } = this.next();
    this.events.push({
      type: "session.started",
      session_id: "sess-1",
      seq,
      ts,
      wish: overrides.wish ?? "do the thing",
      agent: "default",
      model: overrides.model ?? "claude-opus-4",
      provider: "anthropic",
      cwd: overrides.cwd ?? "/tmp/project",
    });
    return this;
  }

  assistantChunk(delta: string, final = false): this {
    const { seq, ts } = this.next();
    this.events.push({ type: "agent.message", session_id: "sess-1", seq, ts, delta, final });
    return this;
  }

  thinking(delta: string): this {
    const { seq, ts } = this.next();
    this.events.push({ type: "agent.thinking", session_id: "sess-1", seq, ts, delta });
    return this;
  }

  toolCalled(toolId: string, toolName = "Read", input: unknown = { path: "/a" }): this {
    const { seq, ts } = this.next();
    this.events.push({
      type: "tool.called",
      session_id: "sess-1",
      seq,
      ts,
      tool_id: toolId,
      tool_name: toolName,
      input,
    });
    return this;
  }

  toolResult(toolId: string, toolName = "Read", output: unknown = "ok", durationMs = 42): this {
    const { seq, ts } = this.next();
    this.events.push({
      type: "tool.result",
      session_id: "sess-1",
      seq,
      ts,
      tool_id: toolId,
      tool_name: toolName,
      output,
      duration_ms: durationMs,
    });
    return this;
  }

  toolError(toolId: string, toolName = "Read", code = "EIO", message = "boom"): this {
    const { seq, ts } = this.next();
    this.events.push({
      type: "tool.error",
      session_id: "sess-1",
      seq,
      ts,
      tool_id: toolId,
      tool_name: toolName,
      code,
      message,
    });
    return this;
  }

  permissionRequested(requestId: string, toolName = "Write"): this {
    const { seq, ts } = this.next();
    this.events.push({
      type: "permission.requested",
      session_id: "sess-1",
      seq,
      ts,
      request_id: requestId,
      tool_name: toolName,
      reason: "needs write",
      input_preview: null,
    });
    return this;
  }

  permissionGranted(requestId: string): this {
    const { seq, ts } = this.next();
    this.events.push({
      type: "permission.granted",
      session_id: "sess-1",
      seq,
      ts,
      request_id: requestId,
      scope: "once",
      granted_by: "user",
    });
    return this;
  }

  permissionDenied(requestId: string): this {
    const { seq, ts } = this.next();
    this.events.push({
      type: "permission.denied",
      session_id: "sess-1",
      seq,
      ts,
      request_id: requestId,
      denied_by: "user",
    });
    return this;
  }

  usage(input: number, output: number, costUsd?: number): this {
    const { seq, ts } = this.next();
    this.events.push({
      type: "usage.updated",
      session_id: "sess-1",
      seq,
      ts,
      input_tokens: input,
      output_tokens: output,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      ...(costUsd !== undefined ? { cost_usd: costUsd } : {}),
    });
    return this;
  }

  sessionCompleted(): this {
    const { seq, ts } = this.next();
    this.events.push({
      type: "session.completed",
      session_id: "sess-1",
      seq,
      ts,
      turns: 1,
      duration_ms: 500,
    });
    return this;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("reduceEvents", () => {
  it("empty events → initial state", () => {
    const state = reduceEvents([], { truncatedTail: false });
    expect(state.messages).toEqual([]);
    expect(state.toolCalls).toEqual([]);
    expect(state.permissions).toEqual([]);
    expect(state.lastSeq).toBe(-1);
    expect(state.lastTs).toBe(0);
    expect(state.ended).toBe(false);
    expect(state.truncatedTail).toBe(false);
    expect(state.turns).toBe(0);
    expect(state.projectHash).toBeNull();
  });

  it("session.started seeds sessionId, cwd, model, provider, projectHash + synthetic user message", () => {
    const s = new EventStream().sessionStarted({ wish: "hello", cwd: "/tmp/x", model: "m" });
    const state = reduceEvents(s.events, { truncatedTail: false });
    expect(state.sessionId).toBe("sess-1");
    expect(state.cwd).toBe("/tmp/x");
    expect(state.model).toBe("m");
    expect(state.provider).toBe("anthropic");
    expect(state.projectHash).toBe(projectHash("/tmp/x"));
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({ role: "user", content: "hello", firstSeq: 0 });
  });

  it("agent.message delta chunks flush on final:true; firstSeq = first chunk", () => {
    const s = new EventStream()
      .sessionStarted()
      .assistantChunk("Hel", false)
      .assistantChunk("lo, ", false)
      .assistantChunk("world!", true);
    const state = reduceEvents(s.events, { truncatedTail: false });
    const assistant = state.messages.filter((m) => m.role === "assistant");
    expect(assistant).toHaveLength(1);
    expect(assistant[0]?.content).toBe("Hello, world!");
    // seq 0 was session.started; first assistant chunk is seq 1.
    expect(assistant[0]?.firstSeq).toBe(1);
  });

  it("tool.called then tool.result populates result, durationMs, finishedAt", () => {
    const s = new EventStream()
      .sessionStarted()
      .toolCalled("t1")
      .toolResult("t1", "Read", { ok: true }, 99);
    const state = reduceEvents(s.events, { truncatedTail: false });
    expect(state.toolCalls).toHaveLength(1);
    const tc = state.toolCalls[0];
    expect(tc?.result).toEqual({ ok: true });
    expect(tc?.durationMs).toBe(99);
    expect(tc?.finishedAt).not.toBeNull();
    expect(tc?.error).toBeNull();
  });

  it("tool.error populates error field but leaves result null", () => {
    const s = new EventStream()
      .sessionStarted()
      .toolCalled("t1")
      .toolError("t1", "Read", "EIO", "broken");
    const state = reduceEvents(s.events, { truncatedTail: false });
    const tc = state.toolCalls[0];
    expect(tc?.error).toEqual({ code: "EIO", message: "broken" });
    expect(tc?.result).toBeNull();
  });

  it("permission.requested + permission.granted → 1 decision with outcome=granted", () => {
    const s = new EventStream()
      .sessionStarted()
      .permissionRequested("p1", "Write")
      .permissionGranted("p1");
    const state = reduceEvents(s.events, { truncatedTail: false });
    expect(state.permissions).toHaveLength(1);
    expect(state.permissions[0]).toMatchObject({
      requestId: "p1",
      toolName: "Write",
      outcome: "granted",
      grantedBy: "user",
    });
  });

  it("permission.denied path produces outcome=denied", () => {
    const s = new EventStream().sessionStarted().permissionRequested("p2").permissionDenied("p2");
    const state = reduceEvents(s.events, { truncatedTail: false });
    expect(state.permissions[0]).toMatchObject({ outcome: "denied", deniedBy: "user" });
  });

  it("usage.updated takes last-seen cumulative values + rounds cost_usd to cents", () => {
    // Events carry cumulative totals (adapter accumulates per-turn deltas).
    // Reducer takes last-seen, NOT sum.
    const s = new EventStream().sessionStarted().usage(100, 50, 0.012).usage(110, 55, 0.013);
    const state = reduceEvents(s.events, { truncatedTail: false });
    // Final state matches last event, not sum of both.
    expect(state.usage.inputTokens).toBe(110);
    expect(state.usage.outputTokens).toBe(55);
    // 0.013 → 1 cent (round).
    expect(state.usage.costUsdCents).toBe(1);
  });

  it("session.completed sets ended=true and turns=1", () => {
    const s = new EventStream().sessionStarted().sessionCompleted();
    const state = reduceEvents(s.events, { truncatedTail: false });
    expect(state.ended).toBe(true);
    expect(state.turns).toBe(1);
  });

  it("truncatedTail option flows through", () => {
    const state = reduceEvents([], { truncatedTail: true });
    expect(state.truncatedTail).toBe(true);
  });

  it("partial assistant buffer at end-of-stream is flushed (crash mid-message)", () => {
    const s = new EventStream().sessionStarted().assistantChunk("unfinished...", false);
    const state = reduceEvents(s.events, { truncatedTail: true });
    const assistant = state.messages.filter((m) => m.role === "assistant");
    expect(assistant).toHaveLength(1);
    expect(assistant[0]?.content).toBe("unfinished...");
  });

  it("tool.result without a preceding tool.called is skipped (forward-compat)", () => {
    const s = new EventStream().sessionStarted().toolResult("orphan");
    const state = reduceEvents(s.events, { truncatedTail: false });
    expect(state.toolCalls).toEqual([]);
  });

  it("agent.thinking is tracked for lastSeq/lastTs but not messages", () => {
    const s = new EventStream().sessionStarted().thinking("hmm").thinking("ok");
    const state = reduceEvents(s.events, { truncatedTail: false });
    expect(state.messages.filter((m) => m.role === "assistant")).toHaveLength(0);
    // 3 events: seq 0,1,2
    expect(state.lastSeq).toBe(2);
  });

  it("20-turn scenario: messages, usage cumulative, lastSeq all consistent", () => {
    const s = new EventStream().sessionStarted();
    for (let i = 0; i < 20; i++) {
      // Events carry cumulative totals (as adapter would emit).
      const cumulativeInput = (i + 1) * 10;
      const cumulativeOutput = (i + 1) * 5;
      s.assistantChunk(`turn-${i} `, true)
        .toolCalled(`tool-${i}`)
        .toolResult(`tool-${i}`)
        .usage(cumulativeInput, cumulativeOutput, 0.001 * (i + 1))
        .sessionCompleted();
    }
    const state = reduceEvents(s.events, { truncatedTail: false });
    // 1 user + 20 assistant
    expect(state.messages).toHaveLength(21);
    expect(state.toolCalls).toHaveLength(20);
    // Last event has cumulative values: 200, 100.
    expect(state.usage.inputTokens).toBe(200);
    expect(state.usage.outputTokens).toBe(100);
    expect(state.turns).toBe(20);
    expect(state.ended).toBe(true);
    expect(state.lastSeq).toBe(s.events.length - 1);
    // messages ordered by firstSeq ascending
    const seqs = state.messages.map((m) => m.firstSeq);
    const sorted = [...seqs].sort((a, b) => a - b);
    expect(seqs).toEqual(sorted);
  });
});

// ---------------------------------------------------------------------------
// T1-07: usage accumulation tests
// ---------------------------------------------------------------------------

describe("reduceEvents: usage-no-double-count", () => {
  it("takes last-seen cumulative values, does not sum events", () => {
    // Simulate adapter output: cumulative totals 100, 300, 600.
    const s = new EventStream()
      .sessionStarted()
      .usage(100, 100) // cumulative after turn 1
      .usage(300, 300) // cumulative after turn 2
      .usage(600, 600); // cumulative after turn 3
    const state = reduceEvents(s.events, { truncatedTail: false });

    // Reducer takes last-seen → 600, NOT sum (100+300+600=1000).
    expect(state.usage.outputTokens).toBe(600);
    expect(state.usage.inputTokens).toBe(600);
  });
});

describe("reduceEvents: usage-replay-round-trip", () => {
  let tmpDir: string;
  let logPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "jellyclaw-usage-roundtrip-"));
    mkdirSync(tmpDir, { recursive: true });
    logPath = join(tmpDir, "session.jsonl");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("write events to JSONL, replay+reduce, final usage matches in-memory reduce", async () => {
    // Build events with cumulative usage values.
    const s = new EventStream()
      .sessionStarted()
      .usage(100, 100)
      .usage(300, 300)
      .usage(600, 600)
      .sessionCompleted();

    // In-memory reduce.
    const inMemoryState = reduceEvents(s.events, { truncatedTail: false });

    // Write to JSONL.
    const jsonlContent = `${s.events.map((e) => JSON.stringify(e)).join("\n")}\n`;
    writeFileSync(logPath, jsonlContent, "utf8");

    // Replay from JSONL and reduce.
    const replayed = await replayJsonl(logPath);
    const replayedState = reduceEvents(replayed.events, { truncatedTail: replayed.truncatedTail });

    // Final usage should match.
    expect(replayedState.usage.inputTokens).toBe(inMemoryState.usage.inputTokens);
    expect(replayedState.usage.outputTokens).toBe(inMemoryState.usage.outputTokens);
    expect(replayedState.usage.cacheReadTokens).toBe(inMemoryState.usage.cacheReadTokens);
    expect(replayedState.usage.cacheWriteTokens).toBe(inMemoryState.usage.cacheWriteTokens);
    expect(replayedState.usage.costUsdCents).toBe(inMemoryState.usage.costUsdCents);

    // Verify values are what we expect: last event's cumulative total.
    expect(replayedState.usage.inputTokens).toBe(600);
    expect(replayedState.usage.outputTokens).toBe(600);
  });
});
