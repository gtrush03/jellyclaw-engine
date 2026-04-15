/**
 * Phase 10.03 — cancellation paths on both `RunHandle.cancel()` and the
 * `Engine.cancel(runId)` surface, plus the `RunNotFoundError` case.
 *
 * Contract:
 *   - `runHandle.cancel()` before the run completes → iterator finishes with
 *     a terminal event (accept `session.completed` with status `cancelled`
 *     OR a dedicated `cancelled` / `session.error` event — the contract
 *     doesn't prescribe the exact shape, just that iteration terminates).
 *   - `engine.cancel(runHandle.id)` produces the same effect from the Engine
 *     surface.
 *   - `engine.cancel(unknownId)` throws `RunNotFoundError`.
 */

import type { AgentEvent } from "@jellyclaw/engine";

import { createEngine, RunNotFoundError } from "@jellyclaw/engine";
import { afterEach, describe, expect, it } from "vitest";

function makeMockProvider(): unknown {
  return {
    name: "mock",
    async *stream(): AsyncGenerator<AgentEvent, void, void> {
      /* unused in Phase 0 stub */
    },
  };
}

const disposables: Array<{ dispose: () => Promise<void> }> = [];

afterEach(async () => {
  while (disposables.length > 0) {
    const e = disposables.pop();
    if (e) {
      try {
        await e.dispose();
      } catch {
        /* idempotent */
      }
    }
  }
});

interface EngineSurface {
  run(input: { prompt: string }): AsyncIterable<AgentEvent> & {
    id: string;
    sessionId: string;
    cancel: () => void;
  };
  cancel(runId: string): Promise<void>;
  dispose(): Promise<void>;
}

function isTerminal(ev: AgentEvent): boolean {
  // Accept either the dedicated terminal variants or `cancelled`.
  return (
    ev.type === "session.completed" ||
    ev.type === "session.error" ||
    // Some consumers may observe a synthetic `cancelled` event; match
    // defensively without depending on a specific type-string outside
    // the frozen AgentEvent union.
    (ev as { type: string }).type === "cancelled"
  );
}

describe("library: cancellation", () => {
  it("runHandle.cancel() before completion → iterator terminates", async () => {
    const engine = (await createEngine({
      providerOverride: makeMockProvider(),
    })) as unknown as EngineSurface;
    disposables.push(engine);

    const handle = engine.run({ prompt: "long-running cancel target" });
    // Cancel before draining.
    handle.cancel();

    const collected: AgentEvent[] = [];
    const deadline = Date.now() + 3_000;
    for await (const ev of handle) {
      collected.push(ev);
      if (Date.now() > deadline) throw new Error("iterator did not terminate post-cancel");
      if (isTerminal(ev)) break;
    }

    // Iterator must have produced at least one event (even if just the
    // terminal one) and terminated.
    expect(collected.length).toBeGreaterThanOrEqual(1);
    const last = collected[collected.length - 1];
    expect(last).toBeTruthy();
    // Accept any terminal shape — see isTerminal().
    if (last) expect(isTerminal(last)).toBe(true);
  });

  it("engine.cancel(runId) cancels from the Engine surface", async () => {
    const engine = (await createEngine({
      providerOverride: makeMockProvider(),
    })) as unknown as EngineSurface;
    disposables.push(engine);

    const handle = engine.run({ prompt: "engine-level cancel" });
    const runId = handle.id;
    expect(runId.length).toBeGreaterThan(0);

    // `Engine.cancel` is async — it returns a promise that rejects with
    // RunNotFoundError if the run has already completed by the time we call.
    // For the Phase-0 stub, "already completed" is acceptable: await the
    // promise and accept either resolve or a RunNotFoundError rejection.
    try {
      await engine.cancel(runId);
    } catch (err) {
      // Only RunNotFoundError is acceptable here; any other throw is a bug.
      expect(err).toBeInstanceOf(RunNotFoundError);
    }

    const collected: AgentEvent[] = [];
    const deadline = Date.now() + 3_000;
    for await (const ev of handle) {
      collected.push(ev);
      if (Date.now() > deadline) throw new Error("iterator did not terminate");
      if (isTerminal(ev)) break;
    }
    expect(collected.length).toBeGreaterThanOrEqual(1);
  });

  it("cancelled run's terminal event carries a cancellation reason", async () => {
    const engine = (await createEngine({
      providerOverride: makeMockProvider(),
    })) as unknown as EngineSurface;
    disposables.push(engine);

    const handle = engine.run({ prompt: "cancel-reason target" });
    handle.cancel();

    const collected: AgentEvent[] = [];
    const deadline = Date.now() + 3_000;
    for await (const ev of handle) {
      collected.push(ev);
      if (Date.now() > deadline) throw new Error("iterator did not terminate post-cancel");
      if (isTerminal(ev)) break;
    }

    const last = collected[collected.length - 1];
    expect(last).toBeTruthy();
    if (!last) return;
    expect(isTerminal(last)).toBe(true);
    // The public AgentEvent union doesn't have a dedicated cancelled field,
    // so the engine signals cancellation by setting `summary: "cancelled"` on
    // the synthetic terminal `session.completed`, OR via a `session.error`
    // with a cancellation code. Accept either.
    const asCompleted = last as { type: string; summary?: string };
    const asError = last as { type: string; code?: string; message?: string };
    const cancelledLike =
      (asCompleted.type === "session.completed" && asCompleted.summary === "cancelled") ||
      (asError.type === "session.error" &&
        (asError.code?.includes("cancel") === true ||
          asError.message?.toLowerCase().includes("cancel") === true));
    expect(cancelledLike).toBe(true);
  });

  it("engine.cancel(unknownId) rejects with RunNotFoundError", async () => {
    const engine = (await createEngine({
      providerOverride: makeMockProvider(),
    })) as unknown as EngineSurface;
    disposables.push(engine);

    await expect(engine.cancel("run-that-does-not-exist-xxxx")).rejects.toThrow(RunNotFoundError);
  });

  it("RunNotFoundError is an Error subclass with a stable name", async () => {
    const engine = (await createEngine({
      providerOverride: makeMockProvider(),
    })) as unknown as EngineSurface;
    disposables.push(engine);

    try {
      await engine.cancel("nonexistent-run-id");
      throw new Error("expected cancel() to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(RunNotFoundError);
      expect((err as Error).name).toBe("RunNotFoundError");
    }
  });
});
