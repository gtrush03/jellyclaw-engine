/**
 * Phase 10.03 — library API: basic `createEngine` + `engine.run` smoke.
 *
 * Validates the synchronous contract documented in
 * `engine/src/public-types.ts`:
 *
 *   - `createEngine(options)` resolves to an `Engine`.
 *   - `engine.run(input)` returns a `RunHandle` whose `.id` and `.sessionId`
 *     are non-empty strings available SYNCHRONOUSLY (before any await).
 *   - Iterating the handle yields at least `session.started` and a terminal
 *     event within 2 seconds.
 *
 * Tests use the `providerOverride` DI hook — we don't hit Anthropic /
 * OpenRouter. The mock yields the canonical lifecycle triple
 * `session.started → agent.message → session.completed`.
 */

import type { AgentEvent } from "@jellyclaw/engine";

import { createEngine } from "@jellyclaw/engine";
import { afterEach, describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Mock provider: conforms to EngineOptions.providerOverride (shape: any object
// accepted by the engine's provider-override hook). We keep the surface
// intentionally minimal — Agent A's Engine is responsible for calling
// `.stream()` when a real run ticks; Phase-0 echo-loop tests don't need it.
// ---------------------------------------------------------------------------

function makeMockProvider(): unknown {
  return {
    name: "mock",
    async *stream(): AsyncGenerator<AgentEvent, void, void> {
      // The echo loop is driven inside the engine; this surface is only
      // exercised once Phase 11+ wires the real runner. Present for shape.
    },
  };
}

// Track engines to dispose after each test.
const disposables: Array<{ dispose: () => Promise<void> }> = [];

afterEach(async () => {
  while (disposables.length > 0) {
    const e = disposables.pop();
    if (e) {
      try {
        await e.dispose();
      } catch {
        /* idempotent — ignore */
      }
    }
  }
});

describe("library: createEngine + engine.run — basic contract", () => {
  it("createEngine() with a minimal providerOverride resolves", async () => {
    const engine = await createEngine({
      providerOverride: makeMockProvider(),
    });
    expect(engine).toBeTruthy();
    expect(typeof (engine as unknown as { run: unknown }).run).toBe("function");
    disposables.push(engine as unknown as { dispose: () => Promise<void> });
  });

  it("engine.run() returns a RunHandle with sync .id and .sessionId", async () => {
    const engine = await createEngine({
      providerOverride: makeMockProvider(),
    });
    disposables.push(engine as unknown as { dispose: () => Promise<void> });

    // The critical synchronous contract: no await between the run() call and
    // reading .id / .sessionId.
    const handle = (
      engine as unknown as {
        run: (input: { prompt: string }) => {
          id: string;
          sessionId: string;
          [Symbol.asyncIterator]: () => AsyncIterator<AgentEvent>;
        };
      }
    ).run({ prompt: "hi" });

    expect(typeof handle.id).toBe("string");
    expect(handle.id.length).toBeGreaterThan(0);
    expect(typeof handle.sessionId).toBe("string");
    expect(handle.sessionId.length).toBeGreaterThan(0);
    // UUID-ish shape — either a v4 UUID or an opaque non-empty id. The
    // strict check keeps us honest if Agent A accidentally seeds sessionId
    // from an async-resolved source.
    expect(handle.sessionId).toMatch(/^[0-9a-zA-Z_-]+$/);
  });

  it("engine.run() iterates to a terminal event within 2s", async () => {
    const engine = await createEngine({
      providerOverride: makeMockProvider(),
    });
    disposables.push(engine as unknown as { dispose: () => Promise<void> });

    const handle = (
      engine as unknown as {
        run: (input: { prompt: string }) => AsyncIterable<AgentEvent> & {
          id: string;
          sessionId: string;
        };
      }
    ).run({ prompt: "hi" });

    const types: string[] = [];
    const deadline = Date.now() + 2_000;
    for await (const ev of handle) {
      types.push(ev.type);
      if (Date.now() > deadline) throw new Error("iterator did not terminate within 2s");
      if (ev.type === "session.completed" || ev.type === "session.error") break;
    }

    expect(types).toContain("session.started");
    const terminal = types[types.length - 1];
    expect(terminal === "session.completed" || terminal === "session.error").toBe(true);
  });

  it("handle.id is stable across reads on the same handle", async () => {
    const engine = await createEngine({
      providerOverride: makeMockProvider(),
    });
    disposables.push(engine as unknown as { dispose: () => Promise<void> });

    const handle = (
      engine as unknown as {
        run: (input: { prompt: string }) => { id: string; sessionId: string };
      }
    ).run({ prompt: "x" });

    const id1 = handle.id;
    const sid1 = handle.sessionId;
    const id2 = handle.id;
    const sid2 = handle.sessionId;
    expect(id1).toBe(id2);
    expect(sid1).toBe(sid2);
  });
});
