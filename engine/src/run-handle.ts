/**
 * Phase 10.03 — `RunHandle` factory.
 *
 * `Engine.run()` / `Engine.resume()` must return a `RunHandle` synchronously so
 * consumers can read `.sessionId` / `.id` before awaiting the first event. The
 * handle is both an async-iterable and a structured control surface.
 *
 * This module contains the one private helper `makeRunHandle` that bridges the
 * RunManager's `RunEntry.emitter` to an `AsyncIterable<AgentEvent>`. The
 * Engine class stays free of emitter wiring.
 */

import type { EventEmitter } from "node:events";

import type { AgentEvent } from "./events.js";
import type { RunHandle } from "./public-types.js";
import type { BufferedEvent, CreateRunOptions, RunEntry, RunManager } from "./server/types.js";

export interface MakeRunHandleOptions {
  readonly runManager: RunManager;
  /**
   * Pre-allocated runId surfaced as `RunHandle.id`. Becomes the stable
   * identifier for `cancel()` / `steer()` once the underlying run-manager
   * entry is materialised. When the real entry is created we DO NOT swap the
   * public-facing id — we keep this one and route by sessionId (see below).
   */
  readonly runId: string;
  readonly sessionId: string;
  readonly cwd: string;
  /**
   * Starts the underlying run-manager entry on first iterator pull. For a
   * fresh `engine.run(input)` call this is `runManager.create(opts)`; for
   * `engine.resume(sessionId)` this is a call that re-creates a new run
   * against the same sessionId.
   *
   * Returning a real `RunEntry` hands over control — from that point forward
   * we subscribe to `entry.emitter` and proxy `cancel()` to
   * `entry.abortController`.
   */
  readonly start: () => Promise<RunEntry>;
  /**
   * Factory used by `RunHandle.resume(prompt)` — returns a fresh RunHandle
   * against the same sessionId, new runId. Supplied by the Engine so the
   * handle doesn't need to know about Engine internals.
   */
  readonly resumeWithPrompt: (prompt: string) => RunHandle;
}

type DoneListener = (payload: { status: string; sessionId: string }) => void;
type EventListener = (payload: BufferedEvent) => void;

/**
 * Build a `RunHandle`. Iterator semantics:
 *
 *   1. First `next()` triggers `start()` which materialises the RunEntry.
 *   2. Subsequent events come off `entry.emitter` via a tiny pull queue.
 *   3. `done` terminates the iterator cleanly; errors surface as iterator
 *      rejections.
 *   4. `cancel()` + `resume()` are wired through the RunManager.
 */
export function makeRunHandle(opts: MakeRunHandleOptions): RunHandle {
  const { runManager, runId, sessionId, start, resumeWithPrompt } = opts;

  // Shared state. Populated on first iterator pull.
  let entry: RunEntry | null = null;
  let started = false;
  let startPromise: Promise<RunEntry> | null = null;
  let cancelled = false;

  // Pull queue — events that arrived between pulls.
  const queue: BufferedEvent[] = [];
  let pending: {
    resolve: (r: IteratorResult<AgentEvent>) => void;
    reject: (e: unknown) => void;
  } | null = null;
  let done = false;
  let pendingError: unknown = null;

  function wireEmitter(em: EventEmitter): { offEvent: EventListener; offDone: DoneListener } {
    const onEvent: EventListener = (buffered) => {
      if (done) return;
      if (pending) {
        const p = pending;
        pending = null;
        p.resolve({ value: buffered.event, done: false });
        return;
      }
      queue.push(buffered);
    };
    const onDone: DoneListener = () => {
      done = true;
      em.off("event", onEvent);
      em.off("done", onDone);
      if (pending) {
        const p = pending;
        pending = null;
        if (pendingError) p.reject(pendingError);
        else p.resolve({ value: undefined, done: true });
      }
    };
    em.on("event", onEvent);
    em.on("done", onDone);
    // Replay any events that arrived before we subscribed (the RunManager
    // buffers them in `entry.buffer`; its `floor` bounds replay).
    return { offEvent: onEvent, offDone: onDone };
  }

  function ensureStarted(): Promise<RunEntry> {
    if (entry) return Promise.resolve(entry);
    if (startPromise) return startPromise;
    started = true;
    startPromise = start().then((e) => {
      entry = e;
      // Drain any already-buffered events into our queue before wiring new
      // listeners, preserving order.
      for (const buffered of e.buffer) {
        queue.push(buffered);
      }
      wireEmitter(e.emitter);
      if (e.status !== "running") {
        done = true;
      }
      // If cancel() was called before the entry existed, propagate now.
      if (cancelled) {
        e.abortController.abort();
      }
      return e;
    });
    return startPromise;
  }

  const handle: RunHandle = {
    id: runId,
    sessionId,
    cancel(): void {
      cancelled = true;
      if (entry) {
        runManager.cancel(entry.runId);
      }
    },
    resume(prompt: string): RunHandle {
      return resumeWithPrompt(prompt);
    },
    [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
      return {
        async next(): Promise<IteratorResult<AgentEvent>> {
          if (pendingError) {
            const err = pendingError;
            pendingError = null;
            throw err;
          }
          if (!started) {
            try {
              await ensureStarted();
            } catch (err) {
              done = true;
              throw err;
            }
          }
          if (queue.length > 0) {
            const buffered = queue.shift();
            if (buffered) return { value: buffered.event, done: false };
          }
          if (done) return { value: undefined, done: true };
          return new Promise<IteratorResult<AgentEvent>>((resolve, reject) => {
            pending = { resolve, reject };
          });
        },
        return(): Promise<IteratorResult<AgentEvent>> {
          done = true;
          handle.cancel();
          return Promise.resolve({ value: undefined, done: true });
        },
        throw(err: unknown): Promise<IteratorResult<AgentEvent>> {
          done = true;
          handle.cancel();
          return Promise.reject(err);
        },
      };
    },
  };

  return handle;
}

/**
 * Shared helper for translating a `CreateRunOptions`-shaped input from an
 * `EngineOptions.RunInput` object — keeps engine.ts free of field fan-out.
 */
export function toCreateRunOptions(args: {
  prompt: string;
  sessionId: string;
  cwd: string;
  input: {
    readonly model?: string;
    readonly permissionMode?: string;
    readonly maxTurns?: number;
    readonly wishId?: string;
    readonly appendSystemPrompt?: string;
    readonly allowedTools?: readonly string[];
  };
}): CreateRunOptions {
  const { prompt, sessionId, cwd, input } = args;
  const out: CreateRunOptions = {
    prompt,
    sessionId,
    cwd,
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.permissionMode !== undefined ? { permissionMode: input.permissionMode } : {}),
    ...(input.maxTurns !== undefined ? { maxTurns: input.maxTurns } : {}),
    ...(input.wishId !== undefined ? { wishId: input.wishId } : {}),
    ...(input.appendSystemPrompt !== undefined
      ? { appendSystemPrompt: input.appendSystemPrompt }
      : {}),
    ...(input.allowedTools !== undefined ? { allowedTools: input.allowedTools } : {}),
  };
  return out;
}
