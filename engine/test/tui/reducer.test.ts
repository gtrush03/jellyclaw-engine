/**
 * Phase 99-06 — table-test suite for the TUI reducer.
 *
 * Covers every `AgentEvent` variant + every `UiAction`, plus identity /
 * purity invariants documented in `engine/src/tui/state/reducer.ts`.
 */

import { describe, expect, it } from "vitest";

import type { AgentEvent } from "../../src/events.js";
import { reduce } from "../../src/tui/state/reducer.js";
import {
  createInitialState,
  type TextMessage,
  type ToolCallMessage,
  type UiState,
} from "../../src/tui/state/types.js";

// ---------------------------------------------------------------------------
// Event factories — keep tests DRY
// ---------------------------------------------------------------------------

const SESSION = "sess-1";

const base = (seq: number, ts = 1_000_000): { session_id: string; ts: number; seq: number } => ({
  session_id: SESSION,
  ts,
  seq,
});

const sessionStarted = (overrides: Partial<AgentEvent> = {}): AgentEvent =>
  ({
    type: "session.started",
    ...base(1),
    wish: "do the thing",
    agent: "default",
    model: "claude-sonnet-4",
    provider: "anthropic",
    cwd: "/tmp",
    ...overrides,
  }) as AgentEvent;

const sessionCompleted = (summary?: string): AgentEvent =>
  ({
    type: "session.completed",
    ...base(99),
    turns: 3,
    duration_ms: 5_000,
    ...(summary !== undefined ? { summary } : {}),
  }) as AgentEvent;

const sessionError = (recoverable = false): AgentEvent =>
  ({
    type: "session.error",
    ...base(2),
    code: "EBOOM",
    message: "kaboom",
    recoverable,
  }) as AgentEvent;

const agentMessage = (delta: string, final = false, seq = 10): AgentEvent =>
  ({
    type: "agent.message",
    ...base(seq),
    delta,
    final,
  }) as AgentEvent;

const agentThinking = (delta = "hmm"): AgentEvent =>
  ({
    type: "agent.thinking",
    ...base(11),
    delta,
  }) as AgentEvent;

const toolCalled = (toolId = "t1", toolName = "Read", input: unknown = { path: "x" }): AgentEvent =>
  ({
    type: "tool.called",
    ...base(20),
    tool_id: toolId,
    tool_name: toolName,
    input,
  }) as AgentEvent;

const toolResult = (toolId = "t1", output: unknown = "hello", durationMs = 42): AgentEvent =>
  ({
    type: "tool.result",
    ...base(21),
    tool_id: toolId,
    tool_name: "Read",
    output,
    duration_ms: durationMs,
  }) as AgentEvent;

const toolError = (toolId = "t1"): AgentEvent =>
  ({
    type: "tool.error",
    ...base(22),
    tool_id: toolId,
    tool_name: "Read",
    code: "EACCES",
    message: "permission denied",
  }) as AgentEvent;

const permRequested = (requestId = "r1"): AgentEvent =>
  ({
    type: "permission.requested",
    ...base(30),
    request_id: requestId,
    tool_name: "Bash",
    reason: "wants to run rm -rf",
    input_preview: { cmd: "ls" },
  }) as AgentEvent;

const permGranted = (requestId = "r1"): AgentEvent =>
  ({
    type: "permission.granted",
    ...base(31),
    request_id: requestId,
    scope: "once",
    granted_by: "user",
  }) as AgentEvent;

const permDenied = (requestId = "r1"): AgentEvent =>
  ({
    type: "permission.denied",
    ...base(32),
    request_id: requestId,
    denied_by: "user",
  }) as AgentEvent;

const subagentSpawned = (): AgentEvent =>
  ({
    type: "subagent.spawned",
    ...base(40),
    subagent_id: "sa-1",
    parent_session_id: SESSION,
    agent: "researcher",
    wish: "find stuff",
  }) as AgentEvent;

const subagentReturned = (): AgentEvent =>
  ({
    type: "subagent.returned",
    ...base(41),
    subagent_id: "sa-1",
    parent_session_id: SESSION,
    ok: true,
  }) as AgentEvent;

const usageUpdated = (): AgentEvent =>
  ({
    type: "usage.updated",
    ...base(50),
    input_tokens: 100,
    output_tokens: 200,
    cache_read_tokens: 10,
    cache_write_tokens: 5,
    cost_usd: 0.0123,
  }) as AgentEvent;

const streamPing = (): AgentEvent =>
  ({
    type: "stream.ping",
    ...base(51),
  }) as AgentEvent;

// Find the assistant text message (assumes exactly one).
function findAssistant(state: UiState): TextMessage | undefined {
  return state.items.find((it): it is TextMessage => it.kind === "text" && it.role === "assistant");
}

function findTool(state: UiState, toolId: string): ToolCallMessage | undefined {
  return state.items.find(
    (it): it is ToolCallMessage => it.kind === "tool" && it.toolId === toolId,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("reduce — session events", () => {
  it("session.started seeds session metadata and switches to streaming", () => {
    const next = reduce(createInitialState(), sessionStarted());
    expect(next.sessionId).toBe(SESSION);
    expect(next.model).toBe("claude-sonnet-4");
    expect(next.provider).toBe("anthropic");
    expect(next.cwd).toBe("/tmp");
    expect(next.status).toBe("streaming");
    expect(next.errorMessage).toBeNull();
  });

  it("session.started clears any prior errorMessage", () => {
    const seed = createInitialState({ errorMessage: "old", status: "error" });
    const next = reduce(seed, sessionStarted());
    expect(next.errorMessage).toBeNull();
    expect(next.status).toBe("streaming");
  });

  it("session.completed without summary just sets idle", () => {
    const seed = createInitialState({ status: "streaming" });
    const next = reduce(seed, sessionCompleted());
    expect(next.status).toBe("idle");
    expect(next.items).toHaveLength(0);
  });

  it("session.completed with summary appends a system text item", () => {
    const seed = createInitialState({ status: "streaming" });
    const next = reduce(seed, sessionCompleted("all done"));
    expect(next.status).toBe("idle");
    expect(next.items).toHaveLength(1);
    const item = next.items[0];
    expect(item?.kind).toBe("text");
    if (item?.kind === "text") {
      expect(item.role).toBe("system");
      expect(item.text).toBe("all done");
      expect(item.done).toBe(true);
    }
  });

  it("session.error sets error status, message, and appends error item", () => {
    const next = reduce(createInitialState({ runId: "r-1" }), sessionError(true));
    expect(next.status).toBe("error");
    expect(next.errorMessage).toBe("kaboom");
    expect(next.runId).toBe("r-1");
    const item = next.items[0];
    expect(item?.kind).toBe("error");
    if (item?.kind === "error") {
      expect(item.code).toBe("EBOOM");
      expect(item.message).toBe("kaboom");
    }
  });

  it("session.error with recoverable=false nulls runId", () => {
    const next = reduce(createInitialState({ runId: "r-1" }), sessionError(false));
    expect(next.runId).toBeNull();
  });
});

describe("reduce — agent.message", () => {
  it("first delta creates a streaming assistant message", () => {
    const next = reduce(createInitialState(), agentMessage("Hello"));
    const msg = findAssistant(next);
    expect(msg?.text).toBe("Hello");
    expect(msg?.done).toBe(false);
  });

  it("merges consecutive deltas into the same message", () => {
    let s = createInitialState();
    s = reduce(s, agentMessage("Hel"));
    s = reduce(s, agentMessage("lo, "));
    s = reduce(s, agentMessage("world"));
    expect(s.items).toHaveLength(1);
    const msg = findAssistant(s);
    expect(msg?.text).toBe("Hello, world");
    expect(msg?.done).toBe(false);
  });

  it("final=true closes the message; subsequent delta starts a new one", () => {
    let s = createInitialState();
    s = reduce(s, agentMessage("first ", false, 1));
    s = reduce(s, agentMessage("done.", true, 2));
    expect(s.items).toHaveLength(1);
    const m1 = findAssistant(s);
    expect(m1?.done).toBe(true);
    expect(m1?.text).toBe("first done.");

    s = reduce(s, agentMessage("second", false, 3));
    expect(s.items).toHaveLength(2);
  });

  it("does not merge into a non-assistant prior item", () => {
    let s = createInitialState();
    s = reduce(s, { kind: "user-prompt", id: "u1", text: "hi" });
    s = reduce(s, agentMessage("hello"));
    expect(s.items).toHaveLength(2);
  });
});

describe("reduce — agent.thinking", () => {
  it("returns the SAME state reference (identity)", () => {
    const seed = createInitialState();
    const next = reduce(seed, agentThinking());
    expect(next).toBe(seed);
  });
});

describe("reduce — tool lifecycle", () => {
  it("tool.called appends a pending tool entry", () => {
    const next = reduce(createInitialState(), toolCalled("t1", "Read", { path: "/a" }));
    const t = findTool(next, "t1");
    expect(t?.status).toBe("pending");
    expect(t?.toolName).toBe("Read");
    expect(t?.input).toEqual({ path: "/a" });
  });

  it("tool.called dedups by tool_id (replay safety)", () => {
    let s = createInitialState();
    s = reduce(s, toolCalled("t1"));
    s = reduce(s, toolCalled("t1"));
    expect(s.items.filter((i) => i.kind === "tool")).toHaveLength(1);
  });

  it("tool.result patches matching tool to ok with output + duration", () => {
    let s = createInitialState();
    s = reduce(s, toolCalled("t1"));
    s = reduce(s, toolResult("t1", { ok: true }, 123));
    const t = findTool(s, "t1");
    expect(t?.status).toBe("ok");
    expect(t?.output).toEqual({ ok: true });
    expect(t?.durationMs).toBe(123);
  });

  it("tool.result for unknown tool_id is a no-op (late arrival)", () => {
    const seed = createInitialState();
    const next = reduce(seed, toolResult("ghost"));
    expect(next).toBe(seed);
  });

  it("tool.error patches matching tool to error with code + message", () => {
    let s = createInitialState();
    s = reduce(s, toolCalled("t1"));
    s = reduce(s, toolError("t1"));
    const t = findTool(s, "t1");
    expect(t?.status).toBe("error");
    expect(t?.errorCode).toBe("EACCES");
    expect(t?.errorMessage).toBe("permission denied");
  });

  it("tool.error for unknown tool_id is a no-op", () => {
    const seed = createInitialState();
    const next = reduce(seed, toolError("ghost"));
    expect(next).toBe(seed);
  });
});

describe("reduce — permission lifecycle", () => {
  it("permission.requested sets pendingPermission and awaiting status", () => {
    const next = reduce(createInitialState({ status: "streaming" }), permRequested("r1"));
    expect(next.status).toBe("awaiting-permission");
    expect(next.pendingPermission?.requestId).toBe("r1");
    expect(next.pendingPermission?.toolName).toBe("Bash");
  });

  it("permission.granted clears matching pending and resumes streaming", () => {
    let s = createInitialState();
    s = reduce(s, permRequested("r1"));
    s = reduce(s, permGranted("r1"));
    expect(s.pendingPermission).toBeNull();
    expect(s.status).toBe("streaming");
  });

  it("permission.denied clears matching pending and resumes streaming", () => {
    let s = createInitialState();
    s = reduce(s, permRequested("r1"));
    s = reduce(s, permDenied("r1"));
    expect(s.pendingPermission).toBeNull();
    expect(s.status).toBe("streaming");
  });

  it("permission.granted with mismatched id is ignored", () => {
    let s = createInitialState();
    s = reduce(s, permRequested("r1"));
    const before = s;
    s = reduce(s, permGranted("r-other"));
    expect(s).toBe(before);
  });

  it("permission.granted with no pending is ignored", () => {
    const seed = createInitialState();
    const next = reduce(seed, permGranted("r1"));
    expect(next).toBe(seed);
  });
});

describe("reduce — subagent events", () => {
  it("subagent.spawned is ignored (out of phase scope)", () => {
    const seed = createInitialState();
    expect(reduce(seed, subagentSpawned())).toBe(seed);
  });

  it("subagent.returned is ignored", () => {
    const seed = createInitialState();
    expect(reduce(seed, subagentReturned())).toBe(seed);
  });
});

describe("reduce — usage.updated", () => {
  it("merges all token + cost fields", () => {
    const next = reduce(createInitialState(), usageUpdated());
    expect(next.usage.inputTokens).toBe(100);
    expect(next.usage.outputTokens).toBe(200);
    expect(next.usage.cacheReadTokens).toBe(10);
    expect(next.usage.cacheWriteTokens).toBe(5);
    expect(next.usage.costUsd).toBeCloseTo(0.0123);
  });

  it("preserves prior costUsd when event omits cost", () => {
    const seed = createInitialState({
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0.5,
      },
    });
    const ev = {
      type: "usage.updated",
      ...base(50),
      input_tokens: 1,
      output_tokens: 2,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    } as AgentEvent;
    const next = reduce(seed, ev);
    expect(next.usage.costUsd).toBe(0.5);
  });
});

describe("reduce — stream.ping", () => {
  it("only bumps tick", () => {
    const seed = createInitialState({ tick: 7 });
    const next = reduce(seed, streamPing());
    expect(next.tick).toBe(8);
    // Other fields untouched.
    expect(next.items).toBe(seed.items);
    expect(next.status).toBe(seed.status);
  });
});

describe("reduce — UiAction", () => {
  it("user-prompt appends a done user TextMessage", () => {
    const next = reduce(createInitialState(), {
      kind: "user-prompt",
      id: "u-1",
      text: "hello",
    });
    expect(next.items).toHaveLength(1);
    const item = next.items[0];
    expect(item?.kind).toBe("text");
    if (item?.kind === "text") {
      expect(item.role).toBe("user");
      expect(item.text).toBe("hello");
      expect(item.done).toBe(true);
      expect(item.id).toBe("u-1");
    }
  });

  it("run-started sets runId, sessionId, streaming status, clears error", () => {
    const seed = createInitialState({ errorMessage: "old", status: "error" });
    const next = reduce(seed, {
      kind: "run-started",
      runId: "r-1",
      sessionId: "s-1",
    });
    expect(next.runId).toBe("r-1");
    expect(next.sessionId).toBe("s-1");
    expect(next.status).toBe("streaming");
    expect(next.errorMessage).toBeNull();
  });

  it("run-cancelled clears runId and returns to idle", () => {
    const seed = createInitialState({ runId: "r-1", status: "streaming" });
    const next = reduce(seed, { kind: "run-cancelled" });
    expect(next.runId).toBeNull();
    expect(next.status).toBe("idle");
  });

  it("tick bumps tick", () => {
    const next = reduce(createInitialState({ tick: 3 }), { kind: "tick" });
    expect(next.tick).toBe(4);
  });

  it("clear-error nulls errorMessage and flips error→idle", () => {
    const seed = createInitialState({ status: "error", errorMessage: "x" });
    const next = reduce(seed, { kind: "clear-error" });
    expect(next.errorMessage).toBeNull();
    expect(next.status).toBe("idle");
  });

  it("clear-error preserves non-error status", () => {
    const seed = createInitialState({ status: "streaming", errorMessage: "x" });
    const next = reduce(seed, { kind: "clear-error" });
    expect(next.errorMessage).toBeNull();
    expect(next.status).toBe("streaming");
  });
});

describe("reduce — purity invariants", () => {
  it("does not mutate the input items array on append", () => {
    const seed = createInitialState();
    const before = seed.items;
    const next = reduce(seed, toolCalled("t1"));
    expect(seed.items).toBe(before);
    expect(seed.items).toHaveLength(0);
    expect(next.items).not.toBe(before);
  });

  it("returns a new state object on stream.ping (tick changed)", () => {
    const seed = createInitialState();
    const next = reduce(seed, streamPing());
    expect(next).not.toBe(seed);
  });

  it("tool.result returns same reference when no matching tool exists", () => {
    const seed = createInitialState();
    expect(reduce(seed, toolResult("nope"))).toBe(seed);
  });
});

describe("reduce — defensive fallthrough", () => {
  it("unknown event type returns the same state reference", () => {
    const seed = createInitialState();
    const bogus = {
      type: "totally.fake",
      ...base(999),
    } as unknown as AgentEvent;
    expect(reduce(seed, bogus)).toBe(seed);
  });

  it("unknown UiAction kind returns the same state reference", () => {
    const seed = createInitialState();
    const bogus = { kind: "not-real" } as unknown as { kind: "tick" };
    expect(reduce(seed, bogus)).toBe(seed);
  });
});
