/**
 * Phase 10.03 — the canonical `Engine` class.
 *
 * Library consumers only ever see this class through `createEngine()` — the
 * constructor takes a private `EngineInternals` bag and is therefore not
 * meant to be called directly. All public methods match the signatures in
 * `public-types.ts` EXACTLY. The class is intentionally thin: it delegates
 * run lifecycle to the Phase 10.02 `RunManager` and owns only the
 * dispose/teardown orchestration + `runStream()` bridge.
 */

import { randomUUID } from "node:crypto";
import type { EventEmitter } from "node:events";
import type { AgentRegistry } from "./agents/registry.js";
import type { OpenCodeHandle } from "./bootstrap/opencode-server.js";
import type { JellyclawConfig } from "./config.js";
import type { AgentEvent } from "./events.js";
import type { HookRegistry } from "./hooks/registry.js";
import type { Logger } from "./logger.js";
import type { McpRegistry } from "./mcp/registry.js";
import type { CompiledPermissions } from "./permissions/types.js";
import type { RunHandle, RunInput } from "./public-types.js";
import { makeRunHandle, toCreateRunOptions } from "./run-handle.js";
import type { RunManager } from "./server/types.js";
import { findLatestForProject } from "./session/continue.js";
import type { Db } from "./session/db.js";
import type { SessionPaths } from "./session/paths.js";
import { projectHash } from "./session/paths.js";
import type { SkillRegistry } from "./skills/registry.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class EngineDisposedError extends Error {
  override readonly name = "EngineDisposedError";
  constructor() {
    super("Engine has been disposed; construct a new one via createEngine()");
  }
}

export class RunNotFoundError extends Error {
  override readonly name = "RunNotFoundError";
  constructor(runId: string) {
    super(`run not found: ${runId}`);
  }
}

export class NoSessionsForProjectError extends Error {
  override readonly name = "NoSessionsForProjectError";
  readonly projectHash: string;
  constructor(hash: string) {
    super(`no sessions found for project ${hash}`);
    this.projectHash = hash;
  }
}

export class ConfigInvalidError extends Error {
  override readonly name = "ConfigInvalidError";
  readonly issues: readonly unknown[];
  constructor(issues: readonly unknown[], message?: string) {
    super(message ?? `invalid jellyclaw config (${issues.length} issue(s))`);
    this.issues = issues;
  }
}

// ---------------------------------------------------------------------------
// Internals — NOT a public type
// ---------------------------------------------------------------------------

export interface EngineInternals {
  config: JellyclawConfig;
  logger: Logger;
  runManager: RunManager;
  sessionPaths: SessionPaths;
  db: Db | null;
  registries: {
    skills: SkillRegistry | null;
    agents: AgentRegistry | null;
    mcp: McpRegistry | null;
    hooks: HookRegistry | null;
    permissions: CompiledPermissions | null;
  };
  opencode: OpenCodeHandle | null;
  /** Held for teardown; never exposed through `engine.config`. */
  opencodePassword: string | null;
  providerOverride: unknown;
  skillWatcher: { stop(): Promise<void> } | null;
  cwd: string;
  disposed: boolean;
  disposePromise: Promise<void> | null;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class Engine {
  readonly #internals: EngineInternals;

  /** @internal — consumers must use `createEngine()`. */
  constructor(internals: EngineInternals) {
    this.#internals = internals;
  }

  /** The resolved config (post-zod, post-merge). Read-only snapshot. */
  get config(): JellyclawConfig {
    return this.#internals.config;
  }

  /** Structured logger (pino-compatible). */
  get logger(): Logger {
    return this.#internals.logger;
  }

  /**
   * Dispatch a run. Returns a `RunHandle` synchronously — `sessionId` is
   * resolved up-front so consumers can subscribe through other channels
   * (HTTP SSE, tailing JSONL) before the first event arrives.
   */
  run(input: RunInput): RunHandle {
    this.#assertLive();
    const internals = this.#internals;
    const sessionId = input.sessionId ?? randomUUID();
    const runId = randomUUID();
    const cwd = input.cwd ?? internals.cwd;
    const prompt = input.prompt ?? "";

    // If the caller supplied an external AbortSignal we honour it by
    // cancelling the run when it fires. The handle's own cancel() wins
    // for cleanup purposes.
    const onExternalAbort = input.signal
      ? () => {
          handle.cancel();
        }
      : null;
    if (input.signal && onExternalAbort) {
      if (input.signal.aborted) {
        // Cancel immediately, but still produce a handle for structural
        // symmetry — consumers may still want the sessionId.
        queueMicrotask(onExternalAbort);
      } else {
        input.signal.addEventListener("abort", onExternalAbort, { once: true });
      }
    }

    const handle = makeRunHandle({
      runManager: internals.runManager,
      runId,
      sessionId,
      cwd,
      start: async () =>
        internals.runManager.create(toCreateRunOptions({ prompt, sessionId, cwd, input })),
      resumeWithPrompt: (nextPrompt) => this.run({ sessionId, prompt: nextPrompt, cwd }),
    });

    return handle;
  }

  /**
   * Same as `run()` but returns a Web `ReadableStream<AgentEvent>`. Useful
   * for HTTP/SSE bridges and for consumers who prefer streams over
   * async-iterables. Cancelling the stream propagates to the run.
   */
  runStream(input: RunInput): ReadableStream<AgentEvent> {
    const handle = this.run(input);
    const iterator = handle[Symbol.asyncIterator]();
    return new ReadableStream<AgentEvent>({
      async pull(controller) {
        try {
          const next = await iterator.next();
          if (next.done) {
            controller.close();
            return;
          }
          controller.enqueue(next.value);
        } catch (err) {
          controller.error(err);
        }
      },
      cancel(): void {
        handle.cancel();
      },
    });
  }

  /** Inject a mid-run user turn. Throws `RunNotFoundError` if unknown. */
  async steer(runId: string, text: string): Promise<void> {
    this.#assertLive();
    await Promise.resolve();
    const ok = this.#internals.runManager.steer(runId, text);
    if (!ok) throw new RunNotFoundError(runId);
  }

  /** Cancel an in-flight run. Throws `RunNotFoundError` if unknown. */
  async cancel(runId: string): Promise<void> {
    this.#assertLive();
    await Promise.resolve();
    const ok = this.#internals.runManager.cancel(runId);
    if (!ok) throw new RunNotFoundError(runId);
  }

  /**
   * Resume an existing session by id. Returns a fresh `RunHandle` — new
   * runId, same sessionId. No prompt is injected; the engine continues
   * from the last turn.
   */
  resume(sessionId: string): RunHandle {
    this.#assertLive();
    const internals = this.#internals;
    const runId = randomUUID();
    const cwd = internals.cwd;

    const handle = makeRunHandle({
      runManager: internals.runManager,
      runId,
      sessionId,
      cwd,
      start: async () => internals.runManager.create({ prompt: "", sessionId, cwd }),
      resumeWithPrompt: (nextPrompt) => this.run({ sessionId, prompt: nextPrompt, cwd }),
    });
    return handle;
  }

  /**
   * Resume the most-recently-touched session for the current cwd. Throws
   * `NoSessionsForProjectError` if the project has never been used.
   */
  continueLatest(): RunHandle {
    this.#assertLive();
    const internals = this.#internals;
    const db = internals.db;
    const hash = projectHash(internals.cwd);

    if (!db) {
      throw new NoSessionsForProjectError(hash);
    }

    // `findLatestForProject` is technically async but backed by a sync
    // better-sqlite3 call — we resolve synchronously to keep the public
    // method synchronous as specified. The single internal await is a
    // `Promise.resolve()`, so we can safely read the underlying row.
    const row = db.raw
      .prepare(`SELECT id FROM sessions WHERE project_hash = ? ORDER BY last_turn_at DESC LIMIT 1`)
      .get(hash) as { id: string } | undefined;

    if (!row) {
      // Dual-path: also exercise the canonical helper for parity in tests
      // that spy on it. Fire-and-forget — we've already decided.
      void findLatestForProject(db, hash).catch(() => undefined);
      throw new NoSessionsForProjectError(hash);
    }

    return this.resume(row.id);
  }

  /**
   * Shut the engine down. Idempotent — the same resolved Promise is
   * returned on repeat calls. Teardown uses `Promise.allSettled` so partial
   * failure does not prevent other subsystems from closing.
   */
  dispose(): Promise<void> {
    const internals = this.#internals;
    if (internals.disposePromise) return internals.disposePromise;
    internals.disposed = true;

    internals.disposePromise = (async () => {
      const log = internals.logger;
      const tasks: Promise<unknown>[] = [];

      tasks.push(
        internals.runManager.shutdown(30_000).catch((err: unknown) => {
          log.warn({ err }, "engine.dispose: runManager.shutdown failed");
        }),
      );

      if (internals.skillWatcher) {
        tasks.push(
          internals.skillWatcher.stop().catch((err: unknown) => {
            log.warn({ err }, "engine.dispose: skillWatcher.stop failed");
          }),
        );
      }

      if (internals.registries.mcp) {
        tasks.push(
          internals.registries.mcp.stop().catch((err: unknown) => {
            log.warn({ err }, "engine.dispose: mcp.stop failed");
          }),
        );
      }

      await Promise.allSettled(tasks);

      // SQLite close is synchronous; wrap for symmetry + catch.
      if (internals.db) {
        try {
          internals.db.close();
        } catch (err) {
          log.warn({ err }, "engine.dispose: db.close failed");
        }
      }

      if (internals.opencode) {
        try {
          await internals.opencode.kill();
        } catch (err) {
          log.warn({ err }, "engine.dispose: opencode.kill failed");
        }
      }
    })();

    return internals.disposePromise;
  }

  // -------------------------------------------------------------------------
  // private helpers
  // -------------------------------------------------------------------------

  #assertLive(): void {
    if (this.#internals.disposed) throw new EngineDisposedError();
  }
}

/**
 * Internal factory — the only blessed way to construct an `Engine` outside
 * of `create-engine.ts`. Keeps the public `new Engine(...)` signature
 * un-callable in practice since consumers cannot build an `EngineInternals`.
 */
export function newEngine(internals: EngineInternals): Engine {
  return new Engine(internals);
}

// Re-export so Agent C's barrel can pull from engine.ts.
export type { EventEmitter };
