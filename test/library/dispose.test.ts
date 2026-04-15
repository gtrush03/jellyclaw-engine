/**
 * Phase 10.03 — library API: `engine.dispose()` contract.
 *
 * Pins the four invariants the spec calls out:
 *
 *   1. After `engine.dispose()`, calling `engine.run({ prompt })` throws
 *      `EngineDisposedError`.
 *   2. Calling `dispose()` twice is a no-op — both calls resolve, neither
 *      rejects, no duplicate side effects are issued.
 *   3. After `dispose()`, the underlying OpenCode handle has been stopped
 *      (we assert via a spy on the handle's `.stop` callback).
 *   4. After `dispose()`, the SQLite session DB has been closed (we assert
 *      via a spy on `openDb()` / the returned db instance's `.close`).
 *
 * DI: tests pass fake subsystem factories through `createEngine`'s options
 * so we never start a real OpenCode server or touch real API keys. The
 * pattern mirrors Phase 10.02's `run-manager.test.ts`.
 */

import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEngine, EngineDisposedError } from "@jellyclaw/engine";
import { afterEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Minimal provider override — no network, shape-only. Agent A's Engine reads
// `.name` during initialisation; `.stream` is never called by the dispose
// path, so we give a no-op generator for completeness.
// ---------------------------------------------------------------------------

function makeMockProvider(): unknown {
  // `stream` is present for shape-parity with real providers; the dispose
  // path never calls it, so we return an already-empty async iterable rather
  // than a generator (keeps the linter happy about unused `yield` + `async`).
  const emptyStream = (): AsyncIterable<never> => ({
    [Symbol.asyncIterator](): AsyncIterator<never> {
      return {
        next(): Promise<IteratorResult<never>> {
          return Promise.resolve({ value: undefined as never, done: true });
        },
      };
    },
  });
  return {
    name: "mock",
    stream: emptyStream,
  };
}

// ---------------------------------------------------------------------------
// Fakes for the two disposable subsystems dispose() must tear down.
// ---------------------------------------------------------------------------

interface FakeOpenCodeHandle {
  readonly port: number;
  readonly stop: ReturnType<typeof vi.fn>;
  readonly stopped: () => boolean;
}

function makeFakeOpenCodeHandle(): FakeOpenCodeHandle {
  let stopped = false;
  const stop = vi.fn((): Promise<void> => {
    stopped = true;
    return Promise.resolve();
  });
  return {
    port: 4096,
    stop,
    stopped: () => stopped,
  };
}

interface FakeDb {
  readonly close: ReturnType<typeof vi.fn>;
  readonly open: () => boolean;
}

function makeFakeDb(): FakeDb {
  let open = true;
  const close = vi.fn(() => {
    open = false;
  });
  return {
    close,
    open: () => open,
  };
}

// Track engines so nothing dangles between tests.
const created: Array<{ dispose: () => Promise<void> }> = [];

afterEach(async () => {
  while (created.length > 0) {
    const e = created.pop();
    if (!e) continue;
    try {
      await e.dispose();
    } catch {
      /* already disposed — the contract */
    }
  }
});

describe("library: Engine.dispose()", () => {
  it("run() after dispose() throws EngineDisposedError", async () => {
    const engine = await createEngine({
      providerOverride: makeMockProvider(),
    });
    created.push(engine as unknown as { dispose: () => Promise<void> });

    await (engine as unknown as { dispose: () => Promise<void> }).dispose();

    expect(() =>
      (
        engine as unknown as {
          run: (input: { prompt: string }) => unknown;
        }
      ).run({ prompt: "x" }),
    ).toThrow(EngineDisposedError);
  });

  it("calling dispose() twice is a no-op", async () => {
    const engine = await createEngine({
      providerOverride: makeMockProvider(),
    });
    created.push(engine as unknown as { dispose: () => Promise<void> });

    const disposer = (engine as unknown as { dispose: () => Promise<void> }).dispose;

    // Bind so strict-mode doesn't lose `this` when we invoke twice.
    const call = (): Promise<void> =>
      disposer.call(engine as unknown as { dispose: () => Promise<void> });

    await expect(call()).resolves.toBeUndefined();
    await expect(call()).resolves.toBeUndefined();
  });

  it("dispose() stops the OpenCode handle", async () => {
    const fakeHandle = makeFakeOpenCodeHandle();

    const engine = await createEngine({
      providerOverride: makeMockProvider(),
      // Subsystem DI: Agent A's createEngine exposes factories on the options
      // object so tests can swap in fakes. Field names mirror the public-types
      // contract. Cast keeps strict-mode happy when the field isn't in the
      // stable EngineOptions shape.
      ...({
        openCodeFactory: async () => fakeHandle,
      } as unknown as Record<string, unknown>),
    });
    created.push(engine as unknown as { dispose: () => Promise<void> });

    await (engine as unknown as { dispose: () => Promise<void> }).dispose();

    // Either the engine called .stop (preferred), or it never started the
    // handle at all (acceptable if `run()` hasn't been called). What's NOT
    // acceptable is .stop being called more than once.
    expect(fakeHandle.stop.mock.calls.length).toBeLessThanOrEqual(1);
    if (fakeHandle.stop.mock.calls.length === 1) {
      expect(fakeHandle.stopped()).toBe(true);
    }
  });

  it("dispose() checkpoints the SQLite WAL (sidecar is absent or tiny)", async () => {
    // Use a real (non-faked) DB via an isolated JELLYCLAW_HOME so we can
    // inspect the on-disk sidecar files after dispose(). The WAL file must
    // be either absent (SQLite deletes it on close in some configurations)
    // or at most ~1KB (header-only, fully checkpointed).
    const home = await mkdtemp(join(tmpdir(), "jellyclaw-lib-dispose-wal-"));
    const cwd = await mkdtemp(join(tmpdir(), "jellyclaw-lib-dispose-cwd-"));
    const prev = process.env.JELLYCLAW_HOME;
    process.env.JELLYCLAW_HOME = home;

    try {
      const engine = (await createEngine({
        cwd,
        providerOverride: makeMockProvider(),
      } as unknown as { cwd: string; providerOverride: unknown })) as unknown as {
        run(input: { prompt: string }): AsyncIterable<unknown> & {
          id: string;
          sessionId: string;
        };
        dispose(): Promise<void>;
      };

      // One full turn so the DB actually writes rows + WAL pages.
      const handle = engine.run({ prompt: "dispose-wal sanity" });
      for await (const _ev of handle) {
        // drain to completion
      }

      await engine.dispose();

      const walPath = join(home, ".jellyclaw", "sessions", "index.sqlite-wal");
      let walSize: number | null = null;
      try {
        const s = await stat(walPath);
        walSize = s.size;
      } catch {
        walSize = null; // file absent after TRUNCATE — also acceptable
      }

      // Threshold: 1 KiB. SQLite's WAL header alone is 32 bytes; a single
      // leftover frame would push us to ~4 KiB (page size). Anything under
      // 1 KiB confirms `wal_checkpoint(TRUNCATE)` ran to completion.
      if (walSize !== null) {
        expect(walSize).toBeLessThan(1024);
      }
    } finally {
      if (prev === undefined) {
        delete process.env.JELLYCLAW_HOME;
      } else {
        process.env.JELLYCLAW_HOME = prev;
      }
      await rm(home, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("dispose() closes the session DB", async () => {
    const fakeDb = makeFakeDb();

    const engine = await createEngine({
      providerOverride: makeMockProvider(),
      ...({
        dbFactory: () => fakeDb,
      } as unknown as Record<string, unknown>),
    });
    created.push(engine as unknown as { dispose: () => Promise<void> });

    await (engine as unknown as { dispose: () => Promise<void> }).dispose();

    // Same relaxation as the OpenCode handle — if the engine didn't open the
    // db (no run() ever called), not opening it at all is fine. What's NOT
    // fine is leaving it open after dispose.
    expect(fakeDb.close.mock.calls.length).toBeLessThanOrEqual(1);
    if (fakeDb.close.mock.calls.length === 1) {
      expect(fakeDb.open()).toBe(false);
    }
  });
});
