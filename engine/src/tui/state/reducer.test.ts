/**
 * Tests for TUI reducer (T3-08).
 */

import { describe, expect, it } from "vitest";
import { reduce } from "./reducer.js";
import { createInitialState } from "./types.js";

describe("key-command-opens-modal", () => {
  it("open-modal action sets state.modal to 'api-key'", () => {
    const state = createInitialState();
    expect(state.modal).toBe(null);

    const next = reduce(state, { kind: "open-modal", modal: "api-key" });
    expect(next.modal).toBe("api-key");
  });

  it("open-modal does not clear existing state (transcript, runId)", () => {
    const state = createInitialState({
      runId: "run-123",
      sessionId: "session-456",
      items: [
        {
          kind: "text",
          id: "msg-1",
          role: "user",
          text: "hello",
          done: true,
        },
      ],
    });

    const next = reduce(state, { kind: "open-modal", modal: "api-key" });
    expect(next.modal).toBe("api-key");
    expect(next.runId).toBe("run-123");
    expect(next.sessionId).toBe("session-456");
    expect(next.items.length).toBe(1);
  });
});

describe("key-modal-persists-and-closes", () => {
  it("close-modal action sets state.modal to null", () => {
    const state = createInitialState({ modal: "api-key" });
    expect(state.modal).toBe("api-key");

    const next = reduce(state, { kind: "close-modal" });
    expect(next.modal).toBe(null);
  });

  it("close-modal does not cause TUI exit (no exit action)", () => {
    // This test verifies that the close-modal action only sets modal to null
    // and does not contain any exit logic in the reducer
    const state = createInitialState({
      modal: "api-key",
      runId: "run-123",
      status: "idle",
    });

    const next = reduce(state, { kind: "close-modal" });
    expect(next.modal).toBe(null);
    // Status remains unchanged, no exit side effect
    expect(next.status).toBe("idle");
    expect(next.runId).toBe("run-123");
  });

  it("close-modal preserves transcript and session state", () => {
    const state = createInitialState({
      modal: "api-key",
      sessionId: "session-789",
      items: [
        {
          kind: "text",
          id: "msg-2",
          role: "assistant",
          text: "hello back",
          done: true,
        },
      ],
    });

    const next = reduce(state, { kind: "close-modal" });
    expect(next.modal).toBe(null);
    expect(next.sessionId).toBe("session-789");
    expect(next.items.length).toBe(1);
  });
});

describe("sse-error-sets-reconnecting", () => {
  it("connection-lost action sets state.connection to disconnected", () => {
    const state = createInitialState();
    expect(state.connection.kind).toBe("connected");

    const next = reduce(state, { kind: "connection-lost", reason: "network error" });
    expect(next.connection.kind).toBe("disconnected");
    if (next.connection.kind === "disconnected") {
      expect(next.connection.reason).toBe("network error");
    }
  });

  it("reconnecting action sets state.connection to reconnecting with attempt info", () => {
    const state = createInitialState({
      connection: { kind: "disconnected", reason: "test" },
    });

    const next = reduce(state, { kind: "reconnecting", attempt: 2, nextRetryMs: 2000 });
    expect(next.connection.kind).toBe("reconnecting");
    if (next.connection.kind === "reconnecting") {
      expect(next.connection.attempt).toBe(2);
      expect(next.connection.nextRetryMs).toBe(2000);
    }
  });
});

describe("reconnect-restores-connection", () => {
  it("connection-restored sets state.connection to connected", () => {
    const state = createInitialState({
      connection: { kind: "reconnecting", attempt: 3, nextRetryMs: 4000 },
    });

    const next = reduce(state, { kind: "connection-restored" });
    expect(next.connection.kind).toBe("connected");
  });

  it("connection-restored appends a reconnected system message", () => {
    const state = createInitialState({
      connection: { kind: "reconnecting", attempt: 2, nextRetryMs: 2000 },
      items: [],
    });

    const next = reduce(state, { kind: "connection-restored" });
    expect(next.items.length).toBe(1);
    const msg = next.items[0];
    expect(msg).toBeDefined();
    if (msg !== undefined && msg.kind === "text") {
      expect(msg.role).toBe("system");
      expect(msg.text).toContain("reconnected");
    }
  });

  it("connection-restored preserves existing transcript items", () => {
    const state = createInitialState({
      connection: { kind: "reconnecting", attempt: 1, nextRetryMs: 1000 },
      items: [
        {
          kind: "text",
          id: "msg-1",
          role: "user",
          text: "hello",
          done: true,
        },
      ],
    });

    const next = reduce(state, { kind: "connection-restored" });
    expect(next.items.length).toBe(2);
    expect(next.items[0]?.kind).toBe("text");
  });
});
