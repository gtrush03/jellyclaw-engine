import { describe, expect, it } from "vitest";
import { AgentEvent } from "../events.js";
import { adaptChunk, adaptDone, createAdapterState } from "./adapter.js";
import type { ProviderChunk } from "./types.js";

/**
 * Fixture A — text-only (Haiku 4.5, "Say hi in 3 words") — captured live
 * 2026-04-15. See PHASE-99 prompt 01 for details. The SDK helper emits
 * `message.content: []` and `content_block.text: ""` empty (NOT
 * pre-accumulated as older SDKs did); the adapter must still ignore these.
 */
const FIXTURE_A: ProviderChunk[] = [
  {
    type: "message_start",
    message: {
      model: "claude-haiku-4-5-20251001",
      id: "msg_01HrziDgGpXFoDjPxLM75NXg",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "Hello, how are you?" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      stop_details: null,
      usage: {
        input_tokens: 19,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
        output_tokens: 9,
        service_tier: "standard",
        inference_geo: "not_available",
      },
    },
  },
  {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "Hello, how are you?" },
  },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
  {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: ", how are you?" },
  },
  { type: "content_block_stop", index: 0 },
  {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null, stop_details: null },
    usage: {
      input_tokens: 19,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 9,
    },
  },
  { type: "message_stop" },
];

/**
 * Fixture B — tool_use (Haiku 4.5, get_weather("Paris")) — captured live
 * 2026-04-15 via raw SDK (bypasses cache-breakpoint planner bug).
 */
const FIXTURE_B: ProviderChunk[] = [
  {
    type: "message_start",
    message: {
      model: "claude-haiku-4-5-20251001",
      id: "msg_011htp2VEb7PkNefpGxrEdkk",
      type: "message",
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "toolu_01UM7JnP2c5aLqzuUfomaRQv",
          name: "get_weather",
          input: { city: "Paris" },
          caller: { type: "direct" },
        },
      ],
      stop_reason: "tool_use",
      stop_sequence: null,
      stop_details: null,
      usage: {
        input_tokens: 612,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
        output_tokens: 54,
        service_tier: "standard",
        inference_geo: "not_available",
      },
    },
  },
  {
    type: "content_block_start",
    index: 0,
    content_block: {
      type: "tool_use",
      id: "toolu_01UM7JnP2c5aLqzuUfomaRQv",
      name: "get_weather",
      input: { city: "Paris" },
      caller: { type: "direct" },
    },
  },
  {
    type: "content_block_delta",
    index: 0,
    delta: { type: "input_json_delta", partial_json: "" },
  },
  {
    type: "content_block_delta",
    index: 0,
    delta: { type: "input_json_delta", partial_json: '{"ci' },
  },
  {
    type: "content_block_delta",
    index: 0,
    delta: { type: "input_json_delta", partial_json: 'ty": "Paris"}' },
  },
  { type: "content_block_stop", index: 0 },
  {
    type: "message_delta",
    delta: { stop_reason: "tool_use", stop_sequence: null, stop_details: null },
    usage: {
      input_tokens: 612,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 54,
    },
  },
  { type: "message_stop" },
];

function makeState(overrides: Partial<Parameters<typeof createAdapterState>[0]> = {}) {
  return createAdapterState({
    sessionId: "sess-test",
    model: "claude-haiku-4-5-20251001",
    wish: "",
    agent: "default",
    cwd: "/tmp",
    provider: "anthropic",
    ...overrides,
  });
}

function runAll(
  chunks: ProviderChunk[],
  nowStart = 1_700_000_000_000,
): {
  events: AgentEvent[];
  state: ReturnType<typeof makeState>;
} {
  const state = makeState();
  const events: AgentEvent[] = [];
  let now = nowStart;
  for (const chunk of chunks) {
    events.push(...adaptChunk(state, chunk, now));
    now += 1;
  }
  return { events, state };
}

describe("adapter: fixture A (text-only)", () => {
  it("maps the captured stream to session.started + message deltas + flush + usage", () => {
    const { events } = runAll(FIXTURE_A);

    expect(events.map((e) => e.type)).toEqual([
      "session.started",
      "agent.message",
      "agent.message",
      "agent.message",
      "usage.updated",
    ]);

    // session.started
    expect(events[0]).toMatchObject({
      type: "session.started",
      session_id: "sess-test",
      wish: "",
      agent: "default",
      model: "claude-haiku-4-5-20251001",
      provider: "anthropic",
      cwd: "/tmp",
      seq: 0,
    });

    // First text delta
    expect(events[1]).toMatchObject({
      type: "agent.message",
      delta: "Hello",
      final: false,
      seq: 1,
    });
    // Second text delta
    expect(events[2]).toMatchObject({
      type: "agent.message",
      delta: ", how are you?",
      final: false,
      seq: 2,
    });
    // Final flush on content_block_stop
    expect(events[3]).toMatchObject({
      type: "agent.message",
      delta: "",
      final: true,
      seq: 3,
    });
    // usage.updated
    expect(events[4]).toMatchObject({
      type: "usage.updated",
      input_tokens: 19,
      output_tokens: 9,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      seq: 4,
    });
  });

  it("every emitted event validates against the AgentEvent Zod union", () => {
    const { events } = runAll(FIXTURE_A);
    for (const e of events) expect(() => AgentEvent.parse(e)).not.toThrow();
  });
});

describe("adapter: fixture B (tool_use)", () => {
  it("maps the captured stream to session.started + tool.called + usage (no intermediate emissions)", () => {
    const { events } = runAll(FIXTURE_B);

    expect(events.map((e) => e.type)).toEqual(["session.started", "tool.called", "usage.updated"]);

    expect(events[1]).toMatchObject({
      type: "tool.called",
      tool_id: "toolu_01UM7JnP2c5aLqzuUfomaRQv",
      tool_name: "get_weather",
      input: { city: "Paris" },
      seq: 1,
    });
    // input is a parsed object, NOT a string.
    const called = events[1] as Extract<AgentEvent, { type: "tool.called" }>;
    expect(typeof called.input).toBe("object");
    expect(called.input).not.toBeNull();

    expect(events[2]).toMatchObject({
      type: "usage.updated",
      input_tokens: 612,
      output_tokens: 54,
      seq: 2,
    });
  });

  it("every emitted event validates against the AgentEvent Zod union", () => {
    const { events } = runAll(FIXTURE_B);
    for (const e of events) expect(() => AgentEvent.parse(e)).not.toThrow();
  });
});

describe("adapter: invalid tool JSON", () => {
  it("emits tool.error{code:'invalid_input'} instead of tool.called", () => {
    const chunks: ProviderChunk[] = [
      {
        type: "message_start",
        message: { usage: { input_tokens: 10 } },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_bad", name: "broken" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: "{not-json" },
      },
      { type: "content_block_stop", index: 0 },
    ];
    const { events } = runAll(chunks);
    const types = events.map((e) => e.type);
    expect(types).toContain("tool.error");
    expect(types).not.toContain("tool.called");
    const err = events.find((e) => e.type === "tool.error") as Extract<
      AgentEvent,
      { type: "tool.error" }
    >;
    expect(err.code).toBe("invalid_input");
    expect(err.tool_id).toBe("toolu_bad");
    expect(err.tool_name).toBe("broken");
  });
});

describe("adapter: mixed text + tool across two content blocks", () => {
  it("flushes text (final:true) before emitting tool.called for next block", () => {
    const chunks: ProviderChunk[] = [
      {
        type: "message_start",
        message: { usage: { input_tokens: 50 } },
      },
      // Block 0: text
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Checking..." },
      },
      { type: "content_block_stop", index: 0 },
      // Block 1: tool_use
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "toolu_x", name: "search" },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"q":"a"}' },
      },
      { type: "content_block_stop", index: 1 },
    ];
    const { events } = runAll(chunks);

    // Find positions
    const flushIdx = events.findIndex((e) => e.type === "agent.message" && e.final === true);
    const toolIdx = events.findIndex((e) => e.type === "tool.called");
    expect(flushIdx).toBeGreaterThanOrEqual(0);
    expect(toolIdx).toBeGreaterThanOrEqual(0);
    expect(flushIdx).toBeLessThan(toolIdx);

    const tool = events[toolIdx] as Extract<AgentEvent, { type: "tool.called" }>;
    expect(tool.input).toEqual({ q: "a" });
  });
});

describe("adapter: usage with cache hits", () => {
  it("propagates cache_read_input_tokens into usage.updated.cache_read_tokens", () => {
    const chunks: ProviderChunk[] = [
      {
        type: "message_start",
        message: {
          usage: {
            input_tokens: 200,
            cache_read_input_tokens: 100,
            cache_creation_input_tokens: 50,
          },
        },
      },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: {
          input_tokens: 200,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 50,
          output_tokens: 30,
        },
      },
    ];
    const { events } = runAll(chunks);
    const usage = events.find((e) => e.type === "usage.updated") as Extract<
      AgentEvent,
      { type: "usage.updated" }
    >;
    expect(usage.cache_read_tokens).toBe(100);
    expect(usage.cache_write_tokens).toBe(50);
    expect(usage.input_tokens).toBe(200);
    expect(usage.output_tokens).toBe(30);
  });
});

describe("adapter: forward-compat", () => {
  it("drops unknown chunk types silently without bumping seq", () => {
    const state = makeState();
    const before = state.seq;
    const out = adaptChunk(state, { type: "mystery_event", foo: "bar" }, 1);
    expect(out).toEqual([]);
    expect(state.seq).toBe(before);
  });
});

describe("adapter: seq monotonicity", () => {
  it("assigns strictly increasing seq with no gaps across 100+ chunks", () => {
    // Build a long text stream
    const chunks: ProviderChunk[] = [
      {
        type: "message_start",
        message: { usage: { input_tokens: 10 } },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
    ];
    for (let i = 0; i < 100; i++) {
      chunks.push({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: `${i}` },
      });
    }
    chunks.push({ type: "content_block_stop", index: 0 });
    chunks.push({
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { input_tokens: 10, output_tokens: 100 },
    });

    const { events, state } = runAll(chunks);
    expect(events.length).toBeGreaterThanOrEqual(100);
    for (let i = 0; i < events.length; i++) {
      expect(events[i]?.seq).toBe(i);
    }
    expect(state.seq).toBe(events.length);
  });
});

describe("adapter: session.started only once", () => {
  it("emits session.started exactly once even when two message_start arrive", () => {
    const chunks: ProviderChunk[] = [
      {
        type: "message_start",
        message: { usage: { input_tokens: 10 } },
      },
      {
        type: "message_start",
        message: { usage: { input_tokens: 20 } },
      },
    ];
    const { events, state } = runAll(chunks);
    const starts = events.filter((e) => e.type === "session.started");
    expect(starts.length).toBe(1);
    // Both message_starts contribute input tokens (accumulation across turns).
    expect(state.inputTokens).toBe(30);
  });
});

describe("adapter: adaptDone", () => {
  it("emits a session.completed with the provided turns + duration + summary, bumping seq", () => {
    const state = makeState();
    state.seq = 42;
    const event = adaptDone(state, {
      turns: 3,
      duration_ms: 1200,
      summary: "ok",
      now: 5_000_000,
    });
    expect(event).toMatchObject({
      type: "session.completed",
      session_id: "sess-test",
      ts: 5_000_000,
      seq: 42,
      turns: 3,
      duration_ms: 1200,
      summary: "ok",
    });
    expect(state.seq).toBe(43);
    expect(() => AgentEvent.parse(event)).not.toThrow();
  });

  it("omits summary when not provided (exactOptionalPropertyTypes)", () => {
    const state = makeState();
    const event = adaptDone(state, { turns: 1, duration_ms: 10, now: 1 });
    expect("summary" in event).toBe(false);
  });
});

describe("adapter: purity (same state transition is deterministic)", () => {
  it("produces identical events for identical inputs when `now` is injected", () => {
    const { events: a } = runAll(FIXTURE_A, 1_000_000);
    const { events: b } = runAll(FIXTURE_A, 1_000_000);
    expect(a).toEqual(b);
  });
});

// ---------------------------------------------------------------------------
// T1-07: usage accumulation tests
// ---------------------------------------------------------------------------

describe("adapter: usage-accumulates", () => {
  it("output_tokens in usage.updated events is monotonically non-decreasing across turns", () => {
    // Simulate three message_delta chunks with per-turn usage deltas.
    // The adapter should ACCUMULATE, so emitted output_tokens should be 100, 300, 600.
    const chunks: ProviderChunk[] = [
      {
        type: "message_start",
        message: { usage: { input_tokens: 10 } },
      },
      // Turn 1: delta output = 100
      {
        type: "message_delta",
        delta: { stop_reason: null },
        usage: { output_tokens: 100 },
      },
      // Turn 2: delta output = 200
      {
        type: "message_delta",
        delta: { stop_reason: null },
        usage: { output_tokens: 200 },
      },
      // Turn 3: delta output = 300
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 300 },
      },
    ];

    const { events } = runAll(chunks);
    const usageEvents = events.filter((e) => e.type === "usage.updated") as Extract<
      AgentEvent,
      { type: "usage.updated" }
    >[];

    // Should have 3 usage.updated events (one per message_delta).
    expect(usageEvents).toHaveLength(3);

    // Accumulated values: 100, 100+200=300, 300+300=600 (strictly monotonic).
    expect(usageEvents[0]?.output_tokens).toBe(100);
    expect(usageEvents[1]?.output_tokens).toBe(300);
    expect(usageEvents[2]?.output_tokens).toBe(600);

    // Verify monotonically non-decreasing.
    for (let i = 1; i < usageEvents.length; i++) {
      expect(usageEvents[i]?.output_tokens).toBeGreaterThanOrEqual(
        usageEvents[i - 1]?.output_tokens ?? 0,
      );
    }
  });
});
