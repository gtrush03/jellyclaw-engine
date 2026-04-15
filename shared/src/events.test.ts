import { describe, expect, it } from "vitest";
import {
  EVENT_TYPES,
  Event,
  type EventType,
  isAssistantDelta,
  isEvent,
  isResult,
  isToolEnd,
  isToolStart,
  OUTPUT_FORMAT_EVENTS,
  parseEvent,
  redactConfig,
  Usage,
} from "./events.js";

// ---------------------------------------------------------------------------
// Golden samples — one hand-written well-formed instance per variant.
// Kept inline (not in a golden-jsonl) so the schema tests can diff the
// actual parse output too.
// ---------------------------------------------------------------------------

const usage = {
  input_tokens: 10,
  output_tokens: 20,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  cost_usd: 0.001,
};

const samples: Record<EventType, unknown> = {
  "system.init": {
    type: "system.init",
    session_id: "s1",
    cwd: "/tmp",
    model: "claude-opus-4-6",
    tools: ["read", "write"],
    ts: 1,
  },
  "system.config": {
    type: "system.config",
    config: { provider: "anthropic", model: "claude-opus-4-6" },
    ts: 2,
  },
  user: {
    type: "user",
    session_id: "s1",
    content: "hello",
    ts: 3,
  },
  "assistant.delta": {
    type: "assistant.delta",
    session_id: "s1",
    text: "hi",
    ts: 4,
  },
  "assistant.message": {
    type: "assistant.message",
    session_id: "s1",
    message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
    usage,
    ts: 5,
  },
  "tool.call.start": {
    type: "tool.call.start",
    session_id: "s1",
    tool_use_id: "t1",
    name: "read",
    input: { path: "a.md" },
    subagent_path: [],
    ts: 6,
  },
  "tool.call.delta": {
    type: "tool.call.delta",
    session_id: "s1",
    tool_use_id: "t1",
    partial_json: '{"path"',
    ts: 7,
  },
  "tool.call.end": {
    type: "tool.call.end",
    session_id: "s1",
    tool_use_id: "t1",
    result: "contents",
    duration_ms: 12,
    ts: 8,
  },
  "subagent.start": {
    type: "subagent.start",
    session_id: "s1",
    agent_name: "researcher",
    parent_id: "s0",
    allowed_tools: ["read"],
    ts: 9,
  },
  "subagent.end": {
    type: "subagent.end",
    session_id: "s1",
    summary: "done",
    usage,
    ts: 10,
  },
  "hook.fire": {
    type: "hook.fire",
    session_id: "s1",
    event: "tool.execute.before",
    decision: "allow",
    stdout: "",
    stderr: "",
    ts: 11,
  },
  "permission.request": {
    type: "permission.request",
    session_id: "s1",
    tool: "bash",
    rule_matched: "bash(ls)",
    action: "allow",
    ts: 12,
  },
  "session.update": {
    type: "session.update",
    session_id: "s1",
    patch: { todos: [{ id: "1", text: "x" }] },
    ts: 13,
  },
  "cost.tick": {
    type: "cost.tick",
    session_id: "s1",
    usage,
    ts: 14,
  },
  result: {
    type: "result",
    session_id: "s1",
    status: "success",
    stats: { turns: 2, tools_called: 1, duration_ms: 1234 },
    ts: 15,
  },
};

describe("Event — discriminated union", () => {
  it("covers all 15 variants", () => {
    expect(EVENT_TYPES).toHaveLength(15);
    expect(new Set(EVENT_TYPES).size).toBe(15);
  });

  for (const type of EVENT_TYPES) {
    it(`round-trips ${type}`, () => {
      const sample = samples[type];
      const parsed = parseEvent(sample);
      // The parser fills Usage defaults; re-serialising and re-parsing
      // must be a fixed-point.
      const json = JSON.stringify(parsed);
      const reparsed = parseEvent(JSON.parse(json));
      expect(reparsed).toEqual(parsed);
      expect(reparsed.type).toBe(type);
    });
  }

  it("rejects unknown discriminator", () => {
    const r = Event.safeParse({ type: "nope", ts: 1 });
    expect(r.success).toBe(false);
  });

  it("rejects missing required fields", () => {
    const r = Event.safeParse({ type: "system.init", session_id: "s1", ts: 1 });
    // Missing cwd/model/tools.
    expect(r.success).toBe(false);
  });

  it("rejects negative ts", () => {
    const r = Event.safeParse({ ...(samples.user as object), ts: -1 });
    expect(r.success).toBe(false);
  });
});

describe("Usage defaults", () => {
  it("fills cache + cost fields when omitted", () => {
    const r = Usage.parse({ input_tokens: 5, output_tokens: 7 });
    expect(r.cache_creation_input_tokens).toBe(0);
    expect(r.cache_read_input_tokens).toBe(0);
    expect(r.cost_usd).toBe(0);
  });

  it("rejects negative token counts", () => {
    expect(Usage.safeParse({ input_tokens: -1, output_tokens: 0 }).success).toBe(false);
  });
});

describe("type guards", () => {
  it("narrow by discriminator", () => {
    const e: Event = parseEvent(samples["tool.call.start"]);
    expect(isToolStart(e)).toBe(true);
    expect(isToolEnd(e)).toBe(false);
    if (isToolStart(e)) {
      // Compile-time narrowing check — `tool_use_id` is only on tool.call.* variants.
      expect(typeof e.tool_use_id).toBe("string");
    }
  });

  it("generic isEvent narrows", () => {
    const e: Event = parseEvent(samples.result);
    expect(isEvent(e, "result")).toBe(true);
    expect(isEvent(e, "assistant.delta")).toBe(false);
    if (isEvent(e, "result")) {
      expect(e.status).toBe("success");
    }
  });

  it("isAssistantDelta + isResult", () => {
    expect(isAssistantDelta(parseEvent(samples["assistant.delta"]))).toBe(true);
    expect(isResult(parseEvent(samples.result))).toBe(true);
  });
});

describe("exhaustiveness", () => {
  it("switch on type is exhaustive", () => {
    // If a variant is added without updating this switch, tsc emits
    // `Type 'X' is not assignable to type 'never'` at the assertion.
    const classify = (e: Event): string => {
      switch (e.type) {
        case "system.init":
          return "init";
        case "system.config":
          return "config";
        case "user":
          return "user";
        case "assistant.delta":
          return "delta";
        case "assistant.message":
          return "message";
        case "tool.call.start":
          return "tool-start";
        case "tool.call.delta":
          return "tool-delta";
        case "tool.call.end":
          return "tool-end";
        case "subagent.start":
          return "sub-start";
        case "subagent.end":
          return "sub-end";
        case "hook.fire":
          return "hook";
        case "permission.request":
          return "perm";
        case "session.update":
          return "update";
        case "cost.tick":
          return "cost";
        case "result":
          return "result";
        default: {
          const _exhaustive: never = e;
          return _exhaustive;
        }
      }
    };
    for (const type of EVENT_TYPES) {
      expect(classify(parseEvent(samples[type]) as Event)).toBeDefined();
    }
  });
});

describe("redactConfig", () => {
  it("scrubs known secret-named keys at any depth", () => {
    const out = redactConfig({
      provider: "anthropic",
      anthropic: { apiKey: "sk-ant-abcdefghijklmn" },
      openrouter: { api_key: "sk-or-abcdefghijklmn" },
      server: { password: "hunter2", OPENCODE_SERVER_PASSWORD: "deadbeef" },
    }) as Record<string, Record<string, unknown>>;
    const a = out.anthropic as Record<string, unknown>;
    expect(a?.apiKey).toBe("[REDACTED]");
    const or = out.openrouter as Record<string, unknown>;
    expect(or?.api_key).toBe("[REDACTED]");
    const srv = out.server as Record<string, unknown>;
    expect(srv?.password).toBe("[REDACTED]");
    expect(srv?.OPENCODE_SERVER_PASSWORD).toBe("[REDACTED]");
    expect(out.provider).toBe("anthropic");
  });

  it("scrubs stringy secrets placed under unrecognised keys", () => {
    const out = redactConfig({
      notes: "our key is sk-ant-1234567890abcdef and don't share it",
    }) as { notes: string };
    expect(out.notes).toBe("[REDACTED]");
  });

  it("is pure (does not mutate input)", () => {
    const input = { anthropic: { apiKey: "sk-ant-xxxxxxxxxxxx" } };
    const copy = structuredClone(input);
    redactConfig(input);
    expect(input).toEqual(copy);
  });

  it("passes non-secrets through unchanged", () => {
    const input = { a: 1, b: [1, 2, 3], c: { d: "hello" } };
    expect(redactConfig(input)).toEqual(input);
  });
});

describe("OUTPUT_FORMAT_EVENTS", () => {
  it("full includes every event", () => {
    for (const t of EVENT_TYPES) {
      expect(OUTPUT_FORMAT_EVENTS["jellyclaw-full"].has(t)).toBe(true);
    }
  });

  it("claude-code-compat is the documented 4-event set", () => {
    expect([...OUTPUT_FORMAT_EVENTS["claude-code-compat"]].sort()).toEqual(
      ["assistant.message", "result", "system.init", "user"].sort(),
    );
  });

  it("claurst-min is delta + result only", () => {
    expect([...OUTPUT_FORMAT_EVENTS["claurst-min"]].sort()).toEqual(
      ["assistant.delta", "result"].sort(),
    );
  });
});
