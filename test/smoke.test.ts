import { describe, expect, it } from "vitest";
import {
  AgentEvent,
  defaultConfig,
  isAgentEvent,
  parseAgentEvent,
  run,
} from "../engine/src/index.js";

describe("AgentEvent schema", () => {
  it("accepts a well-formed session.started", () => {
    const ev = parseAgentEvent({
      type: "session.started",
      session_id: "abc",
      ts: 123,
      seq: 0,
      wish: "hi",
      agent: "default",
      model: "claude-sonnet-4-5-20250929",
      provider: "anthropic",
      cwd: "/tmp",
    });
    expect(ev.type).toBe("session.started");
  });

  it("rejects unknown event types", () => {
    const result = AgentEvent.safeParse({ type: "nope", session_id: "a", ts: 1, seq: 0 });
    expect(result.success).toBe(false);
  });

  it("narrows correctly via isAgentEvent", () => {
    const ev = parseAgentEvent({
      type: "agent.message",
      session_id: "x",
      ts: 1,
      seq: 0,
      delta: "hello",
      final: true,
    });
    if (isAgentEvent(ev, "agent.message")) {
      expect(ev.delta).toBe("hello");
    } else {
      throw new Error("narrowing failed");
    }
  });
});

describe("defaultConfig", () => {
  it("returns a parseable config with Anthropic defaults", () => {
    const c = defaultConfig();
    expect(c.provider.type).toBe("anthropic");
    expect(c.telemetry.enabled).toBe(false);
  });
});

describe("run() — phase 0 stub", () => {
  it("emits started → message → usage → completed in order", async () => {
    const seen: string[] = [];
    for await (const ev of run({ wish: "hello", config: { provider: { type: "anthropic" } } })) {
      seen.push(ev.type);
    }
    expect(seen).toEqual([
      "session.started",
      "agent.message",
      "usage.updated",
      "session.completed",
    ]);
  });

  it("assigns a session_id and monotonic seq", async () => {
    const events: Array<{ session_id: string; seq: number }> = [];
    for await (const ev of run({ wish: "hi", config: { provider: { type: "anthropic" } } })) {
      events.push({ session_id: ev.session_id, seq: ev.seq });
    }
    const firstEvent = events[0];
    expect(firstEvent).toBeDefined();
    if (!firstEvent) throw new Error("no events emitted");
    const sid = firstEvent.session_id;
    expect(sid).toBeTruthy();
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      if (!e) throw new Error(`missing event ${i}`);
      expect(e.session_id).toBe(sid);
      expect(e.seq).toBe(i);
    }
  });
});
