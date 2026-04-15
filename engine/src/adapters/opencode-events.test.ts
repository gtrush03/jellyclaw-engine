/**
 * Unit tests for the OpenCode → jellyclaw adapter.
 *
 * Tests drive `createAdapterFromSource` directly with a synthetic
 * `AsyncIterable<string>` of upstream SSE payload JSON strings — no
 * HTTP, no live OpenCode. Time is injected via a fake clock factory.
 */

import type { Event } from "@jellyclaw/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAdapterFromSource } from "./opencode-events.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function fakeClock(start = 1_700_000_000_000): () => number {
  let t = start;
  return () => {
    t += 1;
    return t;
  };
}

/**
 * A controllable async source. Tests `push()` raw SSE payload strings;
 * the adapter consumes them. Call `close()` to end the stream.
 */
function controllableSource(): {
  source: AsyncIterable<string>;
  push: (s: string) => void;
  close: () => void;
} {
  const queue: string[] = [];
  const waiters: Array<(v: IteratorResult<string>) => void> = [];
  let closed = false;

  return {
    source: {
      [Symbol.asyncIterator](): AsyncIterator<string> {
        return {
          next(): Promise<IteratorResult<string>> {
            if (queue.length > 0) {
              const v = queue.shift() as string;
              return Promise.resolve({ value: v, done: false });
            }
            if (closed) {
              return Promise.resolve({ value: undefined as unknown as string, done: true });
            }
            return new Promise((resolve) => waiters.push(resolve));
          },
          return(): Promise<IteratorResult<string>> {
            closed = true;
            return Promise.resolve({ value: undefined as unknown as string, done: true });
          },
        };
      },
    },
    push(s: string): void {
      if (waiters.length > 0) {
        const w = waiters.shift();
        if (w) w({ value: s, done: false });
        return;
      }
      queue.push(s);
    },
    close(): void {
      closed = true;
      while (waiters.length > 0) {
        const w = waiters.shift();
        if (w) w({ value: undefined as unknown as string, done: true });
      }
    },
  };
}

function frame(type: string, properties: Record<string, unknown>): string {
  return JSON.stringify({ type, properties });
}

async function collect(it: AsyncIterable<Event>, limit = 1000): Promise<Event[]> {
  const out: Event[] = [];
  for await (const e of it) {
    out.push(e);
    if (out.length >= limit) break;
  }
  return out;
}

const baseOpts = {
  sessionId: "ses-test-001",
  cwd: "/tmp/test",
  model: "claude-sonnet-test",
  tools: ["read", "write", "bash"] as const,
  config: { provider: { apiKey: "secret-leak" } },
};

// ---------------------------------------------------------------------------
// 1. Happy path
// ---------------------------------------------------------------------------

describe("opencode-events adapter — happy path", () => {
  it("emits the canonical sequence for a single assistant turn with one tool call", async () => {
    const ctl = controllableSource();
    const handle = createAdapterFromSource({
      ...baseOpts,
      clock: fakeClock(),
      source: ctl.source,
    });

    // Feed canned upstream frames.
    ctl.push(frame("server.connected", {}));
    ctl.push(
      frame("message.updated", {
        info: {
          id: "msg-1",
          role: "assistant",
          time: { created: 1, completed: null },
        },
      }),
    );
    ctl.push(
      frame("message.part.updated", {
        messageID: "msg-1",
        part: { type: "text", text: "hello " },
      }),
    );
    ctl.push(
      frame("message.part.updated", {
        messageID: "msg-1",
        part: { type: "text", text: "world" },
      }),
    );
    // Streaming tool input.
    ctl.push(
      frame("message.part.updated", {
        messageID: "msg-1",
        part: {
          type: "tool-use",
          id: "tool-A",
          name: "read",
          input: '{"path":"',
          state: "streaming",
        },
      }),
    );
    // Tool input completed -> emits start.
    ctl.push(
      frame("message.part.updated", {
        messageID: "msg-1",
        part: {
          type: "tool-use",
          id: "tool-A",
          name: "read",
          input: { path: "/tmp/x" },
          state: "completed",
        },
      }),
    );
    // Tool result -> emits end.
    ctl.push(
      frame("message.part.updated", {
        messageID: "msg-1",
        part: { type: "tool-result", callID: "tool-A", output: "file contents" },
      }),
    );
    // Assistant turn complete with usage.
    ctl.push(
      frame("message.updated", {
        info: {
          id: "msg-1",
          role: "assistant",
          time: { created: 1, completed: 100 },
          tokens: { input: 50, output: 25, cache: { read: 10, write: 5 } },
        },
      }),
    );
    ctl.close();

    const events = await collect(handle);
    const types = events.map((e) => e.type);

    expect(types[0]).toBe("system.init");
    expect(types[1]).toBe("system.config");
    // 2 text deltas
    const deltaIdxs = types.map((t, i) => (t === "assistant.delta" ? i : -1)).filter((i) => i >= 0);
    expect(deltaIdxs).toHaveLength(2);

    // Tool call delta(s) before start.
    const startIdx = types.indexOf("tool.call.start");
    const endIdx = types.indexOf("tool.call.end");
    const firstDeltaIdx = types.indexOf("tool.call.delta");
    expect(firstDeltaIdx).toBeGreaterThan(-1);
    expect(startIdx).toBeGreaterThan(firstDeltaIdx);
    expect(endIdx).toBeGreaterThan(startIdx);
    expect(types).toContain("assistant.message");
    expect(types).toContain("cost.tick");
    expect(types[types.length - 1]).toBe("result");

    const result = events[events.length - 1];
    if (result?.type !== "result") throw new Error("expected terminal result");
    expect(result.status).toBe("success");

    // system.config must have redacted the apiKey.
    const cfg = events[1];
    if (cfg?.type !== "system.config") throw new Error("expected system.config");
    const provider = (cfg.config as { provider?: { apiKey?: unknown } }).provider;
    expect(provider?.apiKey).toBe("[REDACTED]");
  });
});

// ---------------------------------------------------------------------------
// 2. Ordering: late start
// ---------------------------------------------------------------------------

describe("opencode-events adapter — ordering", () => {
  it("buffers .end until .start arrives, then emits them in order", async () => {
    const ctl = controllableSource();
    const handle = createAdapterFromSource({
      ...baseOpts,
      clock: fakeClock(),
      source: ctl.source,
      orderingTimeoutMs: 5_000,
    });

    // tool-result first (would emit .end), then tool-use completed (start).
    ctl.push(
      frame("message.part.updated", {
        messageID: "msg-1",
        part: { type: "tool-result", callID: "tool-A", output: "ok" },
      }),
    );
    ctl.push(
      frame("message.part.updated", {
        messageID: "msg-1",
        part: {
          type: "tool-use",
          id: "tool-A",
          name: "bash",
          input: { cmd: "echo" },
          state: "completed",
        },
      }),
    );
    ctl.close();

    const events = await collect(handle);
    const types = events.map((e) => e.type);
    const startIdx = types.indexOf("tool.call.start");
    const endIdx = types.indexOf("tool.call.end");
    expect(startIdx).toBeGreaterThan(-1);
    expect(endIdx).toBeGreaterThan(startIdx);
  });
});

// ---------------------------------------------------------------------------
// 3. Orphan end with timeout
// ---------------------------------------------------------------------------

describe("opencode-events adapter — orphan end timeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("synthesises a .start when no matching .start arrives within the timeout", async () => {
    const ctl = controllableSource();
    const handle = createAdapterFromSource({
      ...baseOpts,
      clock: fakeClock(),
      source: ctl.source,
      orderingTimeoutMs: 2_000,
    });

    const collected: Event[] = [];
    const iter = handle[Symbol.asyncIterator]();

    // Drain the two synthetic prelude events.
    const a = await iter.next();
    if (!a.done) collected.push(a.value);
    const b = await iter.next();
    if (!b.done) collected.push(b.value);

    // Push only an orphan tool-result.
    ctl.push(
      frame("message.part.updated", {
        messageID: "msg-1",
        part: { type: "tool-result", callID: "orphan-1", output: "oops" },
      }),
    );

    // Let the microtask queue process the push.
    await Promise.resolve();
    await Promise.resolve();

    // Advance fake timers past the ordering timeout.
    await vi.advanceTimersByTimeAsync(2_100);

    // Now collect three events: synthesised start, hook.fire, end.
    const e1 = await iter.next();
    if (!e1.done) collected.push(e1.value);
    const e2 = await iter.next();
    if (!e2.done) collected.push(e2.value);
    const e3 = await iter.next();
    if (!e3.done) collected.push(e3.value);

    ctl.close();
    // Drain to terminal result.
    for (;;) {
      const r = await iter.next();
      if (r.done) break;
      collected.push(r.value);
    }

    const types = collected.map((e) => e.type);
    const startIdx = types.indexOf("tool.call.start");
    const hookIdx = types.indexOf("hook.fire");
    const endIdx = types.indexOf("tool.call.end");

    expect(startIdx).toBeGreaterThan(-1);
    expect(hookIdx).toBeGreaterThan(startIdx);
    expect(endIdx).toBeGreaterThan(startIdx);

    const start = collected[startIdx];
    if (start?.type !== "tool.call.start") throw new Error("expected start");
    expect(start.name).toBe("unknown");
    expect(start.input).toBeNull();

    const hook = collected[hookIdx];
    if (hook?.type !== "hook.fire") throw new Error("expected hook.fire");
    expect(hook.decision).toBe("adapter.synthesize_start");
    expect(hook.event).toBe("stream.ordering_violation");
    expect(hook.stdout).toBe("orphan-1");
  });
});

// ---------------------------------------------------------------------------
// 4. Parse-error tolerance
// ---------------------------------------------------------------------------

describe("opencode-events adapter — parse error tolerance", () => {
  it("skips malformed lines, emits a hook.fire, and continues iteration", async () => {
    const ctl = controllableSource();
    const handle = createAdapterFromSource({
      ...baseOpts,
      clock: fakeClock(),
      source: ctl.source,
    });

    ctl.push(frame("server.connected", {}));
    ctl.push("data: {not json"); // malformed
    ctl.push(
      frame("session.updated", {
        info: { id: "ses-x", title: "still working" },
      }),
    );
    ctl.close();

    const events = await collect(handle);
    const types = events.map((e) => e.type);
    expect(types).toContain("session.update");
    const parseErr = events.find(
      (e) => e.type === "hook.fire" && e.event === "adapter.parse_error",
    );
    expect(parseErr).toBeDefined();
    if (parseErr?.type === "hook.fire") {
      expect(parseErr.decision).toBe("adapter.drop");
    }
    expect(types[types.length - 1]).toBe("result");
  });
});

// ---------------------------------------------------------------------------
// 5. Subagent nesting
// ---------------------------------------------------------------------------

describe("opencode-events adapter — subagent nesting", () => {
  it("attaches subagent_path to nested tool.call.start events", async () => {
    const ctl = controllableSource();
    const handle = createAdapterFromSource({
      ...baseOpts,
      clock: fakeClock(),
      source: ctl.source,
    });

    const iter = handle[Symbol.asyncIterator]();
    // Drain prelude.
    await iter.next();
    await iter.next();

    // Simulate nested subagent dispatch.
    handle.pushSubagent("grep-helper", "ses-grep");
    handle.pushSubagent("diff-helper", "ses-diff");

    ctl.push(
      frame("message.part.updated", {
        messageID: "msg-1",
        part: {
          type: "tool-use",
          id: "tool-X",
          name: "read",
          input: { path: "/a" },
          state: "completed",
        },
      }),
    );

    // Let the iteration consume the frame.
    let start: Event | undefined;
    for (;;) {
      const r = await iter.next();
      if (r.done) break;
      if (r.value.type === "tool.call.start") {
        start = r.value;
        break;
      }
    }

    if (start?.type !== "tool.call.start") throw new Error("expected tool.call.start");
    expect(start.subagent_path).toEqual(["grep-helper", "diff-helper"]);

    handle.popSubagent();
    handle.popSubagent();
    ctl.close();

    // Drain.
    for (;;) {
      const r = await iter.next();
      if (r.done) break;
    }
  });
});

// ---------------------------------------------------------------------------
// 6. AbortController
// ---------------------------------------------------------------------------

describe("opencode-events adapter — abort", () => {
  it("ends with result{status:'cancelled'} when the signal aborts", async () => {
    const ctl = controllableSource();
    const ac = new AbortController();
    const handle = createAdapterFromSource({
      ...baseOpts,
      clock: fakeClock(),
      source: ctl.source,
      signal: ac.signal,
    });

    const iter = handle[Symbol.asyncIterator]();
    // Drain prelude.
    await iter.next();
    await iter.next();

    // Push one frame mid-stream.
    ctl.push(
      frame("session.updated", {
        info: { id: "ses-x" },
      }),
    );
    const e1 = await iter.next();
    expect(e1.done).toBe(false);

    // Abort.
    ac.abort();
    ctl.close();

    // Drain — final non-done event must be `result{status:'cancelled'}`.
    let last: Event | undefined;
    for (;;) {
      const r = await iter.next();
      if (r.done) break;
      last = r.value;
    }
    if (last?.type !== "result") throw new Error("expected terminal result");
    expect(last.status).toBe("cancelled");
  });
});

// ---------------------------------------------------------------------------
// 7. Backpressure
// ---------------------------------------------------------------------------

describe("opencode-events adapter — backpressure", () => {
  it("processes 2_000 frames through a slow consumer without dropping events", async () => {
    // Note: prompt allows fewer than 10k for CI speed; we use 2_000.
    const N = 2_000;

    const ctl = controllableSource();
    const handle = createAdapterFromSource({
      ...baseOpts,
      clock: fakeClock(),
      source: ctl.source,
      costTickEvery: 100_000, // suppress periodic cost.tick noise from this count
    });

    // Fire-and-forget producer (sync; the source queues internally).
    for (let i = 0; i < N; i++) {
      ctl.push(
        frame("session.updated", {
          info: { id: `ses-${i}` },
        }),
      );
    }
    ctl.close();

    const rssBefore = process.memoryUsage().rss;
    let count = 0;
    for await (const e of handle) {
      count += 1;
      if (e.type === "session.update" && count % 250 === 0) {
        // Simulate a slow consumer.
        await new Promise((r) => setTimeout(r, 1));
      }
    }
    const rssAfter = process.memoryUsage().rss;

    // Expected: 2 prelude + N session.update + 1 result.
    expect(count).toBe(N + 3);
    const growth = rssAfter - rssBefore;
    expect(growth).toBeLessThan(50 * 1024 * 1024);
  }, 30_000);
});
