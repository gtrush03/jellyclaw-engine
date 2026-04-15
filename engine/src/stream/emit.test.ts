/**
 * stream-json emitter tests — Phase 03 Prompt 03.
 */

import type {
  AssistantDeltaEvent,
  AssistantMessageEvent,
  CostTickEvent,
  Event,
  EventType,
  HookFireEvent,
  OutputFormat,
  PermissionRequestEvent,
  ResultEvent,
  SessionUpdateEvent,
  SubagentEndEvent,
  SubagentStartEvent,
  SystemConfigEvent,
  SystemInitEvent,
  ToolCallDeltaEvent,
  ToolCallEndEvent,
  ToolCallStartEvent,
  Usage,
  UserEvent,
} from "@jellyclaw/shared";
import { describe, expect, it } from "vitest";
import { downgrade, StreamEmitter, type WritableLike, writeEvent } from "./emit.js";

class MockStream implements WritableLike {
  lines: string[] = [];
  private drainListeners: (() => void)[] = [];
  private blocked = false;
  private writeCount = 0;
  private blockEveryN = 0;

  write(chunk: string, cb?: (err?: Error | null) => void): boolean {
    this.lines.push(chunk);
    cb?.();
    this.writeCount += 1;
    if (this.blockEveryN > 0 && this.writeCount % this.blockEveryN === 0) {
      this.blocked = true;
      // Schedule drain on next microtask so writeEvent can register listener.
      queueMicrotask(() => this.unblock());
      return false;
    }
    return !this.blocked;
  }

  once(event: "drain", listener: () => void): this {
    if (event === "drain") this.drainListeners.push(listener);
    return this;
  }

  block() {
    this.blocked = true;
  }

  unblock() {
    this.blocked = false;
    const ls = this.drainListeners.splice(0);
    for (const l of ls) l();
  }

  blockEvery(n: number) {
    this.blockEveryN = n;
  }
}

const SID = "sess-1";
const ZERO_USAGE: Usage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  cost_usd: 0,
};

function evSystemInit(ts = 1): SystemInitEvent {
  return {
    type: "system.init",
    session_id: SID,
    cwd: "/x",
    model: "m",
    tools: [],
    ts,
  };
}
function evSystemConfig(ts = 2): SystemConfigEvent {
  return { type: "system.config", config: {}, ts };
}
function evUser(ts = 3): UserEvent {
  return { type: "user", session_id: SID, content: "hi", ts };
}
function evDelta(text: string, ts = 4): AssistantDeltaEvent {
  return { type: "assistant.delta", session_id: SID, text, ts };
}
function evMessage(text = "final", ts = 10): AssistantMessageEvent {
  return {
    type: "assistant.message",
    session_id: SID,
    message: { role: "assistant", content: [{ type: "text", text }] },
    usage: ZERO_USAGE,
    ts,
  };
}
function evToolStart(ts = 5): ToolCallStartEvent {
  return {
    type: "tool.call.start",
    session_id: SID,
    tool_use_id: "t1",
    name: "bash",
    input: {},
    subagent_path: [],
    ts,
  };
}
function evToolDelta(ts = 6): ToolCallDeltaEvent {
  return {
    type: "tool.call.delta",
    session_id: SID,
    tool_use_id: "t1",
    partial_json: "{",
    ts,
  };
}
function evToolEnd(ts = 7): ToolCallEndEvent {
  return {
    type: "tool.call.end",
    session_id: SID,
    tool_use_id: "t1",
    duration_ms: 1,
    ts,
  };
}
function evSubStart(ts = 8): SubagentStartEvent {
  return {
    type: "subagent.start",
    session_id: SID,
    agent_name: "x",
    parent_id: "p",
    allowed_tools: [],
    ts,
  };
}
function evSubEnd(ts = 9): SubagentEndEvent {
  return { type: "subagent.end", session_id: SID, summary: "", usage: ZERO_USAGE, ts };
}
function evHook(ts = 11): HookFireEvent {
  return {
    type: "hook.fire",
    session_id: SID,
    event: "tool.execute.before",
    decision: "allow",
    stdout: "",
    stderr: "",
    ts,
  };
}
function evPerm(ts = 12): PermissionRequestEvent {
  return {
    type: "permission.request",
    session_id: SID,
    tool: "bash",
    rule_matched: "*",
    action: "allow",
    ts,
  };
}
function evSessionUpdate(ts = 13): SessionUpdateEvent {
  return { type: "session.update", session_id: SID, patch: {}, ts };
}
function evCostTick(ts = 14): CostTickEvent {
  return { type: "cost.tick", session_id: SID, usage: ZERO_USAGE, ts };
}
function evResult(ts = 15): ResultEvent {
  return {
    type: "result",
    session_id: SID,
    status: "success",
    stats: { turns: 1, tools_called: 0, duration_ms: 100 },
    ts,
  };
}

function parseLines(mock: MockStream): unknown[] {
  return mock.lines.map((l) => {
    expect(l.endsWith("\n")).toBe(true);
    return JSON.parse(l);
  });
}

describe("writeEvent", () => {
  it("writes one NDJSON line", async () => {
    const m = new MockStream();
    const ev = evSystemInit();
    await writeEvent(m, ev);
    expect(m.lines).toEqual([`${JSON.stringify(ev)}\n`]);
  });

  it("awaits drain on backpressure", async () => {
    const m = new MockStream();
    m.block();
    let resolved = false;
    const p = writeEvent(m, evSystemInit()).then(() => {
      resolved = true;
    });
    // microtask flush
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);
    m.unblock();
    await p;
    expect(resolved).toBe(true);
  });
});

describe("jellyclaw-full passthrough", () => {
  it("emits all 15 event types verbatim, in order", async () => {
    const m = new MockStream();
    const e = new StreamEmitter(m, "jellyclaw-full");
    const seq: Event[] = [
      evSystemInit(1),
      evSystemConfig(2),
      evUser(3),
      evDelta("a", 4),
      evMessage("m", 5),
      evToolStart(6),
      evToolDelta(7),
      evToolEnd(8),
      evSubStart(9),
      evSubEnd(10),
      evHook(11),
      evPerm(12),
      evSessionUpdate(13),
      evCostTick(14),
      evResult(15),
    ];
    for (const ev of seq) await e.emit(ev);
    await e.finish();
    const lines = parseLines(m);
    expect(lines).toEqual(seq);
    expect(lines.length).toBe(15);
  });
});

describe("claude-code-compat", () => {
  it("coalesces deltas into the assistant.message and drops noise", async () => {
    const m = new MockStream();
    const e = new StreamEmitter(m, "claude-code-compat");
    await e.emit(evSystemInit(1));
    await e.emit(evUser(2));
    const parts = ["he", "ll", "o ", "wor", "ld"];
    let ts = 3;
    for (const p of parts) {
      await e.emit(evDelta(p, ts));
      ts += 1;
    }
    await e.emit(evMessage("ORIGINAL", ts));
    await e.emit(evCostTick(ts + 1));
    await e.emit(evResult(ts + 2));
    await e.finish();

    const lines = parseLines(m) as Array<{ type: string }>;
    expect(lines.map((l) => l.type)).toEqual([
      "system.init",
      "user",
      "assistant.message",
      "result",
    ]);
    const msg = lines[2] as AssistantMessageEvent;
    expect(msg.message.content).toEqual([{ type: "text", text: "hello world" }]);
  });

  it("drops tool/subagent/hook/permission/session.update/system.config", async () => {
    const m = new MockStream();
    const e = new StreamEmitter(m, "claude-code-compat");
    await e.emit(evSystemInit(1));
    await e.emit(evSystemConfig(2));
    await e.emit(evToolStart(3));
    await e.emit(evToolDelta(4));
    await e.emit(evToolEnd(5));
    await e.emit(evSubStart(6));
    await e.emit(evSubEnd(7));
    await e.emit(evHook(8));
    await e.emit(evPerm(9));
    await e.emit(evSessionUpdate(10));
    await e.emit(evCostTick(11));
    await e.emit(evResult(12));
    await e.finish();
    const types = (parseLines(m) as Array<{ type: string }>).map((l) => l.type);
    expect(types).toEqual(["system.init", "result"]);
  });

  it("flushes buffered deltas as a synthetic assistant.message on finish()", async () => {
    const m = new MockStream();
    const e = new StreamEmitter(m, "claude-code-compat");
    await e.emit(evSystemInit(1));
    await e.emit(evDelta("partial-", 2));
    await e.emit(evDelta("text", 3));
    await e.finish();
    const lines = parseLines(m) as Array<{ type: string }>;
    expect(lines.map((l) => l.type)).toEqual(["system.init", "assistant.message"]);
    const msg = lines[1] as AssistantMessageEvent;
    expect(msg.message.content).toEqual([{ type: "text", text: "partial-text" }]);
    expect(msg.usage).toEqual(ZERO_USAGE);
    expect(msg.ts).toBe(3);
  });

  it("falls back to original message content when no deltas were buffered", async () => {
    const m = new MockStream();
    const e = new StreamEmitter(m, "claude-code-compat");
    await e.emit(evMessage("only-this", 5));
    await e.finish();
    const lines = parseLines(m) as Array<{ message: { content: unknown } }>;
    expect(lines[0]?.message.content).toEqual([{ type: "text", text: "only-this" }]);
  });
});

describe("claurst-min", () => {
  it("writes only delta and result lines in Claurst's flat shape", async () => {
    const m = new MockStream();
    const e = new StreamEmitter(m, "claurst-min");
    await e.emit(evSystemInit(1));
    await e.emit(evUser(2));
    const parts = ["he", "ll", "o ", "wor", "ld"];
    let ts = 3;
    for (const p of parts) {
      await e.emit(evDelta(p, ts));
      ts += 1;
    }
    await e.emit(evMessage("X", ts));
    await e.emit(evCostTick(ts + 1));
    await e.emit(evResult(ts + 2));
    await e.finish();

    const lines = parseLines(m);
    expect(lines.length).toBe(parts.length + 1);
    for (let i = 0; i < parts.length; i += 1) {
      expect(lines[i]).toEqual({ type: "text", value: parts[i] });
    }
    expect(lines[parts.length]).toEqual({
      type: "result",
      status: "success",
      duration_ms: 100,
    });
  });
});

describe("downgrade() stateless matrix", () => {
  const samples: Record<EventType, Event> = {
    "system.init": evSystemInit(),
    "system.config": evSystemConfig(),
    user: evUser(),
    "assistant.delta": evDelta("x"),
    "assistant.message": evMessage(),
    "tool.call.start": evToolStart(),
    "tool.call.delta": evToolDelta(),
    "tool.call.end": evToolEnd(),
    "subagent.start": evSubStart(),
    "subagent.end": evSubEnd(),
    "hook.fire": evHook(),
    "permission.request": evPerm(),
    "session.update": evSessionUpdate(),
    "cost.tick": evCostTick(),
    result: evResult(),
  };

  const expected: Record<OutputFormat, Record<EventType, "pass" | "drop">> = {
    "jellyclaw-full": {
      "system.init": "pass",
      "system.config": "pass",
      user: "pass",
      "assistant.delta": "pass",
      "assistant.message": "pass",
      "tool.call.start": "pass",
      "tool.call.delta": "pass",
      "tool.call.end": "pass",
      "subagent.start": "pass",
      "subagent.end": "pass",
      "hook.fire": "pass",
      "permission.request": "pass",
      "session.update": "pass",
      "cost.tick": "pass",
      result: "pass",
    },
    "claude-code-compat": {
      "system.init": "pass",
      "system.config": "drop",
      user: "pass",
      "assistant.delta": "drop",
      "assistant.message": "pass",
      "tool.call.start": "drop",
      "tool.call.delta": "drop",
      "tool.call.end": "drop",
      "subagent.start": "drop",
      "subagent.end": "drop",
      "hook.fire": "drop",
      "permission.request": "drop",
      "session.update": "drop",
      "cost.tick": "drop",
      result: "pass",
    },
    "claurst-min": {
      "system.init": "drop",
      "system.config": "drop",
      user: "drop",
      "assistant.delta": "pass",
      "assistant.message": "drop",
      "tool.call.start": "drop",
      "tool.call.delta": "drop",
      "tool.call.end": "drop",
      "subagent.start": "drop",
      "subagent.end": "drop",
      "hook.fire": "drop",
      "permission.request": "drop",
      "session.update": "drop",
      "cost.tick": "drop",
      result: "pass",
    },
  };

  for (const fmt of ["jellyclaw-full", "claude-code-compat", "claurst-min"] as OutputFormat[]) {
    for (const [type, ev] of Object.entries(samples) as Array<[EventType, Event]>) {
      it(`${fmt} / ${type}`, () => {
        const r = downgrade(ev, fmt);
        const verdict = expected[fmt][type];
        if (verdict === "drop") {
          expect(r).toBeNull();
        } else {
          expect(r).toEqual(ev);
        }
      });
    }
  }
});

describe("backpressure at scale", () => {
  it("writes 1000 events in order even when blocking every 10th call", async () => {
    const m = new MockStream();
    m.blockEvery(10);
    const e = new StreamEmitter(m, "jellyclaw-full");
    const seq: ResultEvent[] = [];
    for (let i = 0; i < 1000; i += 1) {
      const ev: ResultEvent = {
        type: "result",
        session_id: `s-${i}`,
        status: "success",
        stats: { turns: 0, tools_called: 0, duration_ms: i },
        ts: i + 1,
      };
      seq.push(ev);
      await e.emit(ev);
    }
    expect(m.lines.length).toBe(1000);
    const parsed = parseLines(m) as ResultEvent[];
    for (let i = 0; i < 1000; i += 1) {
      expect(parsed[i]?.session_id).toBe(`s-${i}`);
      expect(parsed[i]?.stats.duration_ms).toBe(i);
    }
  });
});
