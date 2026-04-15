import { describe, expect, it } from "vitest";
import {
  HOOK_PAYLOAD_SCHEMAS,
  makeInstructionsLoadedEvent,
  makeNotificationEvent,
  makePostToolUseEvent,
  makePreCompactEvent,
  makePreToolUseEvent,
  makeSessionStartEvent,
  makeStopEvent,
  makeSubagentStartEvent,
  makeSubagentStopEvent,
  makeUserPromptSubmitEvent,
  truncateToolResultForHook,
  validateModifiedPayload,
} from "./events.js";
import { ALL_HOOK_EVENTS, type HookEventKind } from "./types.js";

describe("HOOK_PAYLOAD_SCHEMAS", () => {
  it("has a schema for every event kind", () => {
    for (const kind of ALL_HOOK_EVENTS) {
      expect(HOOK_PAYLOAD_SCHEMAS[kind]).toBeDefined();
    }
    const registryKeys = Object.keys(HOOK_PAYLOAD_SCHEMAS).sort();
    const eventKeys = [...ALL_HOOK_EVENTS].sort();
    expect(registryKeys).toEqual(eventKeys);
  });
});

describe("SessionStart schema", () => {
  it("accepts a valid payload and round-trips", () => {
    const payload = { sessionId: "s1", cwd: "/tmp", config: { a: 1 } };
    const parsed = HOOK_PAYLOAD_SCHEMAS.SessionStart.parse(payload);
    expect(parsed).toEqual(payload);
  });
  it("rejects missing required field", () => {
    expect(() => HOOK_PAYLOAD_SCHEMAS.SessionStart.parse({ cwd: "/tmp", config: {} })).toThrow();
  });
  it("rejects unknown keys (strict)", () => {
    expect(() =>
      HOOK_PAYLOAD_SCHEMAS.SessionStart.parse({
        sessionId: "s",
        cwd: "/tmp",
        config: {},
        extra: 1,
      }),
    ).toThrow();
  });
});

describe("InstructionsLoaded schema", () => {
  it("accepts null claudeMd", () => {
    const p = { sessionId: "s", claudeMd: null, systemPromptBytes: 0 };
    expect(HOOK_PAYLOAD_SCHEMAS.InstructionsLoaded.parse(p)).toEqual(p);
  });
  it("rejects wrong type on systemPromptBytes", () => {
    expect(() =>
      HOOK_PAYLOAD_SCHEMAS.InstructionsLoaded.parse({
        sessionId: "s",
        claudeMd: "",
        systemPromptBytes: "0",
      }),
    ).toThrow();
  });
});

describe("UserPromptSubmit schema", () => {
  it("round-trips", () => {
    const p = { sessionId: "s", prompt: "hi" };
    expect(HOOK_PAYLOAD_SCHEMAS.UserPromptSubmit.parse(p)).toEqual(p);
  });
  it("rejects non-string prompt", () => {
    expect(() =>
      HOOK_PAYLOAD_SCHEMAS.UserPromptSubmit.parse({ sessionId: "s", prompt: 1 }),
    ).toThrow();
  });
});

describe("PreToolUse / PostToolUse schemas", () => {
  it("PreToolUse accepts a typical payload", () => {
    const p = {
      sessionId: "s",
      toolName: "Bash",
      toolInput: { command: "ls" },
      callId: "c1",
    };
    expect(HOOK_PAYLOAD_SCHEMAS.PreToolUse.parse(p)).toEqual(p);
  });
  it("PostToolUse accepts optional truncated flag", () => {
    const p = {
      sessionId: "s",
      toolName: "Bash",
      toolInput: {},
      toolResult: "ok",
      callId: "c1",
      durationMs: 5,
      truncated: true,
    };
    expect(HOOK_PAYLOAD_SCHEMAS.PostToolUse.parse(p)).toEqual(p);
  });
  it("PostToolUse rejects negative duration", () => {
    expect(() =>
      HOOK_PAYLOAD_SCHEMAS.PostToolUse.parse({
        sessionId: "s",
        toolName: "x",
        toolInput: {},
        toolResult: null,
        callId: "c",
        durationMs: -1,
      }),
    ).toThrow();
  });
});

describe("Subagent / PreCompact / Stop / Notification schemas", () => {
  it("SubagentStart round-trips", () => {
    const p = { parentSessionId: "p", subagentSessionId: "c", agentName: "worker" };
    expect(HOOK_PAYLOAD_SCHEMAS.SubagentStart.parse(p)).toEqual(p);
  });
  it("SubagentStop round-trips", () => {
    const p = { parentSessionId: "p", subagentSessionId: "c", reason: "done", usage: {} };
    expect(HOOK_PAYLOAD_SCHEMAS.SubagentStop.parse(p)).toEqual(p);
  });
  it("PreCompact rejects negative tokenCount", () => {
    expect(() =>
      HOOK_PAYLOAD_SCHEMAS.PreCompact.parse({ sessionId: "s", tokenCount: -1, threshold: 10 }),
    ).toThrow();
  });
  it("Stop round-trips", () => {
    const p = { sessionId: "s", reason: "end", usage: { tokens: 10 } };
    expect(HOOK_PAYLOAD_SCHEMAS.Stop.parse(p)).toEqual(p);
  });
  it("Notification enforces level enum", () => {
    expect(() =>
      HOOK_PAYLOAD_SCHEMAS.Notification.parse({ sessionId: "s", level: "bad", message: "x" }),
    ).toThrow();
    const ok = { sessionId: "s", level: "info" as const, message: "x" };
    expect(HOOK_PAYLOAD_SCHEMAS.Notification.parse(ok)).toEqual(ok);
  });
});

describe("truncateToolResultForHook", () => {
  it("passes small values through unchanged", () => {
    const r = truncateToolResultForHook({ a: 1 }, 1024);
    expect(r.truncated).toBe(false);
    expect(r.value).toEqual({ a: 1 });
  });
  it("truncates values over the cap", () => {
    const big = "x".repeat(1_048_576); // 1 MB
    const r = truncateToolResultForHook(big, 262_144);
    expect(r.truncated).toBe(true);
    const v = r.value as { truncated: boolean; sizeBytes: number; preview: string };
    expect(v.truncated).toBe(true);
    expect(v.sizeBytes).toBeGreaterThan(262_144);
    expect(v.preview.length).toBeLessThanOrEqual(512);
  });
  it("handles non-serializable input gracefully", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const r = truncateToolResultForHook(circular, 1024);
    expect(r.truncated).toBe(true);
  });
  it("serializes null as 'null' under the cap", () => {
    const r = truncateToolResultForHook(null, 16);
    expect(r.truncated).toBe(false);
    expect(r.value).toBeNull();
  });
});

describe("validateModifiedPayload", () => {
  it("returns parsed payload for valid PreToolUse input", () => {
    const p = { sessionId: "s", toolName: "Bash", toolInput: { command: "ls" }, callId: "c" };
    const out = validateModifiedPayload("PreToolUse", p);
    expect(out).toEqual(p);
  });
  it("returns null on invalid PreToolUse input", () => {
    expect(validateModifiedPayload("PreToolUse", { bogus: true })).toBeNull();
  });
  it("returns null for non-modifiable events", () => {
    const p = { sessionId: "s", cwd: "/tmp", config: {} };
    expect(validateModifiedPayload("SessionStart", p)).toBeNull();
  });
  it("returns parsed payload for valid UserPromptSubmit input", () => {
    const p = { sessionId: "s", prompt: "hello" };
    expect(validateModifiedPayload("UserPromptSubmit", p)).toEqual(p);
  });
  it("returns null for non-modifiable events even when payload would be valid", () => {
    const p = { sessionId: "s", level: "info" as const, message: "x" };
    expect(validateModifiedPayload("Notification" as HookEventKind, p as unknown)).toBeNull();
  });
});

describe("event factory helpers", () => {
  it("makeSessionStartEvent returns the correct shape", () => {
    const e = makeSessionStartEvent({ sessionId: "s", cwd: "/", config: {} });
    expect(e.kind).toBe("SessionStart");
    expect(e.payload.sessionId).toBe("s");
  });
  it("makePreToolUseEvent returns kind 'PreToolUse'", () => {
    const e = makePreToolUseEvent({ sessionId: "s", toolName: "X", toolInput: {}, callId: "c" });
    expect(e.kind).toBe("PreToolUse");
  });
  it("all ten factories produce their declared kind", () => {
    const factories = [
      makeSessionStartEvent({ sessionId: "s", cwd: "/", config: {} }),
      makeInstructionsLoadedEvent({ sessionId: "s", claudeMd: null, systemPromptBytes: 0 }),
      makeUserPromptSubmitEvent({ sessionId: "s", prompt: "" }),
      makePreToolUseEvent({ sessionId: "s", toolName: "X", toolInput: {}, callId: "c" }),
      makePostToolUseEvent({
        sessionId: "s",
        toolName: "X",
        toolInput: {},
        toolResult: null,
        callId: "c",
        durationMs: 0,
      }),
      makeSubagentStartEvent({ parentSessionId: "p", subagentSessionId: "c", agentName: "a" }),
      makeSubagentStopEvent({
        parentSessionId: "p",
        subagentSessionId: "c",
        reason: "",
        usage: {},
      }),
      makePreCompactEvent({ sessionId: "s", tokenCount: 0, threshold: 0 }),
      makeStopEvent({ sessionId: "s", reason: "", usage: {} }),
      makeNotificationEvent({ sessionId: "s", level: "info", message: "" }),
    ];
    const kinds = factories.map((f) => f.kind).sort();
    expect(kinds).toEqual([...ALL_HOOK_EVENTS].sort());
  });
});
