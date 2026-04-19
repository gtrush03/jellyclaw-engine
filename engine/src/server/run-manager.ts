/**
 * Phase 10.02 — in-process RunManager.
 *
 * Owns the lifecycle of each HTTP-initiated run:
 *   - starts the engine's async iterator (`run()` from engine/src/index.ts)
 *   - fans events out to (a) a bounded ring buffer, (b) an EventEmitter for
 *     SSE subscribers, (c) the Phase-09 durable JSONL transcript.
 *   - surfaces cancellation via an AbortController passed INTO `run()`.
 *     Today the Phase-0 stub does not honour the signal; we still thread it
 *     through so Phase 10.03+ wiring is zero-touch.
 *   - exposes a snapshot, a graceful shutdown, a mid-run steer hook, and a
 *     resume-from-session path.
 *
 * The ring buffer keeps the last N events per run; `floor` tracks the lowest
 * event id still retained. SSE reconnections below the floor fall back to
 * the JSONL replay path.
 */

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { access } from "node:fs/promises";
import type { Logger } from "pino";

import { runAgentLoop } from "../agents/loop.js";
import { loadSoul } from "../agents/soul.js";
import type { AgentEvent } from "../events.js";
import type { HookRegistry } from "../hooks/registry.js";
import { run as engineRun } from "../internal.js";
import type { McpRegistry } from "../mcp/registry.js";
import type { CompiledPermissions } from "../permissions/types.js";
import type { Provider } from "../providers/types.js";
import type { Db, JsonlWriter } from "../session/index.js";
import {
  openJsonl,
  projectHash,
  replayJsonl,
  resumeSession,
  SessionPaths,
  SessionWriter,
} from "../session/index.js";
import type {
  BufferedEvent,
  CreateRunOptions,
  PriorMessage,
  ResumeRunOptions,
  RunEntry,
  RunManager,
  RunManagerSnapshot,
  RunStatus,
} from "./types.js";
import { RunNotFoundError } from "./types.js";

export const DEFAULT_RING_BUFFER_CAP = 512;
export const DEFAULT_POST_COMPLETION_TTL_MS = 5 * 60 * 1000;

/**
 * Convert a replayed JSONL event stream into an ordered list of
 * `PriorMessage` entries suitable for {@link AgentLoopOptions.priorMessages}.
 *
 * Rules:
 *  - `user.prompt` events become `{ role: "user", content: text }`.
 *  - Consecutive `agent.message` deltas collapse into ONE assistant message;
 *    the run ends at the first `final: true` OR at any non-agent.message
 *    boundary (another user.prompt, tool event, etc.). Empty merged strings
 *    are dropped so the model never sees a blank assistant turn.
 *  - All other event types (thinking, tool.*, permission.*, usage, session.*,
 *    subagent.*, stream.ping) are ignored — they don't contribute to the
 *    user/assistant alternation the chat API expects.
 */
export function eventsToPriorMessages(events: readonly AgentEvent[]): ReadonlyArray<PriorMessage> {
  const out: PriorMessage[] = [];
  let pendingAssistant: string[] | null = null;

  const flushAssistant = (): void => {
    if (pendingAssistant === null) return;
    const content = pendingAssistant.join("");
    if (content.length > 0) {
      out.push({ role: "assistant", content });
    }
    pendingAssistant = null;
  };

  for (const event of events) {
    if (event.type === "agent.message") {
      if (pendingAssistant === null) pendingAssistant = [];
      pendingAssistant.push(event.delta);
      if (event.final) flushAssistant();
      continue;
    }
    // Any non-agent.message boundary terminates the in-flight assistant run.
    flushAssistant();
    if (event.type === "user.prompt") {
      out.push({ role: "user", content: event.text });
    }
    // All other event types are deliberately ignored.
  }
  flushAssistant();
  return out;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

interface MutableRunEntry {
  readonly runId: string;
  readonly sessionId: string;
  status: RunStatus;
  readonly buffer: BufferedEvent[];
  readonly emitter: EventEmitter;
  readonly abortController: AbortController;
  completedAt: number | null;
  readonly createdAt: number;
  /** Lowest event id still retained in `buffer`; for JSONL-replay routing. */
  floor: number;
  /** Next id to assign to a buffered event. Mirrors AgentEvent.seq ordering. */
  nextId: number;
  /** Steering inbox; drained by the engine loop in Phase 10.03+. */
  readonly steerInbox: string[];
  /** Completion promise — shutdown() awaits these. */
  readonly done: Promise<void>;
  readonly jsonl: JsonlWriter | null;
  readonly sessionWriter: SessionWriter | null;
  readonly paths: SessionPaths;
  readonly projectHash: string;
  readonly cwd: string;
}

export interface RunManagerOptions {
  readonly logger: Logger;
  readonly paths?: SessionPaths;
  /** When provided, enables SessionWriter index updates. */
  readonly db?: Db;
  readonly ringBufferCap?: number;
  readonly postCompletionTtlMs?: number;
  /**
   * Escape hatch for tests: override the underlying iterator. Defaults to
   * the real `engineRun`. MUST accept a `signal` option (even if unused).
   */
  readonly runFactory?: (
    opts: CreateRunOptions & { signal: AbortSignal; sessionId: string },
  ) => AsyncIterable<AgentEvent>;
  readonly logEvents?: boolean;
  /**
   * Phase 99.03 — real-loop dependencies. When all four (`provider`, `hooks`,
   * `permissions`, `defaultModel`) are present AND `runFactory` is not
   * overridden, the manager drives `runAgentLoop` instead of the Phase-0 stub.
   * Missing any of them → fall back to the stub iterator (keeps legacy tests
   * and library consumers that lack an API key working).
   */
  readonly provider?: Provider;
  readonly hooks?: HookRegistry;
  readonly permissions?: CompiledPermissions;
  readonly defaultModel?: string;
  readonly defaultCwd?: string;
  /** MCP registry for tool augmentation (T0-01). */
  readonly mcp?: McpRegistry;
}

/**
 * Construct a concrete {@link RunManager}. Shared by the HTTP server and
 * tests; not exported as a class because the `RunManager` interface is the
 * public contract (see server/types.ts).
 */
export function createRunManager(options: RunManagerOptions): RunManager {
  const logger = options.logger;
  const paths = options.paths ?? new SessionPaths();
  const db = options.db;
  const ringCap = options.ringBufferCap ?? DEFAULT_RING_BUFFER_CAP;
  const ttlMs = options.postCompletionTtlMs ?? DEFAULT_POST_COMPLETION_TTL_MS;
  const runFactory = options.runFactory ?? makeDefaultRunFactory(options, logger);

  const runs = new Map<string, MutableRunEntry>();
  let totalRuns = 0;
  let completedRuns = 0;
  let closed = false;

  async function startIterator(entry: MutableRunEntry, opts: CreateRunOptions): Promise<void> {
    let finalStatus: RunStatus = "completed";

    // Record session presence in the shared index as soon as the run starts.
    // Without this row, `Engine.continueLatest()` can't find the session on a
    // subsequent engine instance (the JSONL log exists but no DB pointer).
    if (entry.sessionWriter) {
      const nowMs = Date.now();
      try {
        await entry.sessionWriter.upsertSession({
          id: entry.sessionId,
          projectHash: entry.projectHash,
          cwd: entry.cwd,
          model: opts.model ?? null,
          createdAt: nowMs,
          lastTurnAt: nowMs,
          parentSessionId: null,
          status: "active",
          summary: null,
        });
      } catch (err) {
        logger.warn(
          { err, runId: entry.runId, sessionId: entry.sessionId },
          "run-manager: sessionWriter.upsertSession(start) failed",
        );
      }
    }

    try {
      const iterable = runFactory({
        ...opts,
        sessionId: entry.sessionId,
        signal: entry.abortController.signal,
      });

      for await (const event of iterable) {
        if (entry.abortController.signal.aborted) {
          finalStatus = "cancelled";
          break;
        }
        pushEvent(entry, event);
        if (entry.jsonl) {
          try {
            await entry.jsonl.write(event);
          } catch (err) {
            logger.warn({ err, runId: entry.runId }, "run-manager: jsonl write failed");
          }
        }
      }
    } catch (err) {
      finalStatus = "failed";
      logger.error({ err, runId: entry.runId }, "run-manager: iterator threw");
    } finally {
      entry.status = finalStatus;
      entry.completedAt = Date.now();
      completedRuns++;

      // Update index with terminal status + last_turn_at so
      // `findLatestForProject` orders correctly across multiple sessions.
      if (entry.sessionWriter) {
        try {
          await entry.sessionWriter.upsertSession({
            id: entry.sessionId,
            projectHash: entry.projectHash,
            cwd: entry.cwd,
            model: opts.model ?? null,
            createdAt: entry.createdAt,
            lastTurnAt: entry.completedAt ?? Date.now(),
            parentSessionId: null,
            status: finalStatus === "cancelled" || finalStatus === "failed" ? "ended" : "ended",
            summary: null,
          });
        } catch (err) {
          logger.warn(
            { err, runId: entry.runId, sessionId: entry.sessionId },
            "run-manager: sessionWriter.upsertSession(end) failed",
          );
        }
      }

      // Always append an unambiguous terminal event for cancellation / error
      // paths so `RunHandle` consumers can distinguish a natural completion
      // from a cancelled one. The public `AgentEvent` union has no dedicated
      // cancelled variant, so we overload `session.completed.summary`.
      if (finalStatus === "cancelled") {
        const t = Date.now();
        pushEvent(entry, {
          type: "session.completed",
          session_id: entry.sessionId,
          ts: t,
          seq: entry.nextId,
          summary: "cancelled",
          turns: 0,
          duration_ms: t - entry.createdAt,
        });
      } else if (finalStatus === "failed") {
        const lastEvent = entry.buffer[entry.buffer.length - 1]?.event;
        const lastType = lastEvent?.type;
        if (lastType !== "session.error") {
          const t = Date.now();
          pushEvent(entry, {
            type: "session.error",
            session_id: entry.sessionId,
            ts: t,
            seq: entry.nextId,
            code: "iterator_failed",
            message: "run iterator threw",
            recoverable: false,
          });
        }
      }

      entry.emitter.emit("done", { status: finalStatus, sessionId: entry.sessionId });

      if (entry.jsonl) {
        try {
          await entry.jsonl.flushTurn();
          await entry.jsonl.close();
        } catch (err) {
          logger.warn({ err, runId: entry.runId }, "run-manager: jsonl close failed");
        }
      }

      // Schedule eviction so post-run SSE reconnect windows stay bounded.
      const t = setTimeout(() => {
        runs.delete(entry.runId);
        entry.emitter.removeAllListeners();
      }, ttlMs);
      t.unref();
    }
  }

  function pushEvent(entry: MutableRunEntry, event: AgentEvent): void {
    const id = entry.nextId++;
    const buffered: BufferedEvent = { id, event };
    entry.buffer.push(buffered);
    while (entry.buffer.length > ringCap) {
      entry.buffer.shift();
      entry.floor = (entry.buffer[0]?.id ?? id) >>> 0;
    }
    if (entry.buffer.length > 0 && entry.floor === 0 && entry.buffer[0]) {
      entry.floor = entry.buffer[0].id;
    }
    entry.emitter.emit("event", buffered);
    if (options.logEvents) {
      logger.debug({ runId: entry.runId, id, type: event.type }, "run-manager: event");
    }
  }

  function makeEntry(
    runId: string,
    sessionId: string,
    cwd: string,
    jsonl: JsonlWriter | null,
    sessionWriter: SessionWriter | null,
    pHash: string,
  ): MutableRunEntry {
    const emitter = new EventEmitter();
    // Default max listeners (10) is too low for realistic SSE fan-out.
    emitter.setMaxListeners(0);
    let resolveDone!: () => void;
    const donePromise = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    emitter.once("done", () => resolveDone());

    return {
      runId,
      sessionId,
      status: "running",
      buffer: [],
      emitter,
      abortController: new AbortController(),
      completedAt: null,
      createdAt: Date.now(),
      floor: 0,
      nextId: 0,
      steerInbox: [],
      done: donePromise,
      jsonl,
      sessionWriter,
      paths,
      projectHash: pHash,
      cwd,
    };
  }

  async function openDurability(
    sessionId: string,
    cwd: string,
  ): Promise<{ jsonl: JsonlWriter | null; sessionWriter: SessionWriter | null; pHash: string }> {
    const pHash = projectHash(cwd);
    let jsonl: JsonlWriter | null = null;
    let sessionWriter: SessionWriter | null = null;
    try {
      jsonl = await openJsonl({ sessionId, projectHash: pHash, paths, logger });
    } catch (err) {
      logger.warn({ err, sessionId }, "run-manager: openJsonl failed; running without transcript");
    }
    if (db) {
      try {
        sessionWriter = new SessionWriter(db, logger);
      } catch (err) {
        logger.warn({ err, sessionId }, "run-manager: SessionWriter init failed");
      }
    }
    return { jsonl, sessionWriter, pHash };
  }

  return {
    async create(opts: CreateRunOptions): Promise<RunEntry> {
      if (closed) {
        throw new Error("RunManager is shut down");
      }
      const runId = randomUUID();
      const sessionId = opts.sessionId ?? randomUUID();
      const cwd = opts.cwd ?? process.cwd();

      // 1. Rehydrate prior-turn context from the session JSONL BEFORE we open
      //    the writer (openJsonl appends; we want to read the pre-existing
      //    tail, not any user.prompt we're about to append). Only attempted
      //    when the caller passed an explicit sessionId (continuation). A
      //    brand-new session has no log; a missing file for a claimed
      //    sessionId is treated as "new session" per the spec.
      let priorMessages: ReadonlyArray<PriorMessage> | undefined;
      if (opts.sessionId !== undefined) {
        const pHashEarly = projectHash(cwd);
        const logPath = paths.sessionLog(pHashEarly, sessionId);
        if (await fileExists(logPath)) {
          try {
            const replay = await replayJsonl(logPath, { logger });
            priorMessages = eventsToPriorMessages(replay.events);
          } catch (err) {
            logger.warn(
              { err, runId, sessionId, path: logPath },
              "run-manager: replayJsonl for priorMessages failed; continuing without history",
            );
          }
        }
      }

      const { jsonl, sessionWriter, pHash } = await openDurability(sessionId, cwd);
      const entry = makeEntry(runId, sessionId, cwd, jsonl, sessionWriter, pHash);
      runs.set(runId, entry);
      totalRuns++;

      // 2. Persist the user's prompt BEFORE kicking off the iterator so the
      //    on-disk transcript captures this turn even if the agent crashes
      //    before emitting any event. The writer's internal seq counter
      //    handles assignment.
      if (jsonl) {
        try {
          await jsonl.writeUserPrompt(sessionId, opts.prompt);
        } catch (err) {
          logger.warn(
            { err, runId, sessionId },
            "run-manager: writeUserPrompt failed; continuing without user-turn persistence",
          );
        }
      }

      // 3. Kick off the iterator but return promptly so the caller gets its
      //    runId. `priorMessages` threads through to `runAgentLoop`.
      const iterOpts: CreateRunOptions =
        priorMessages !== undefined ? { ...opts, priorMessages } : opts;
      void startIterator(entry, iterOpts);

      return toReadonly(entry);
    },

    get(runId: string): RunEntry | undefined {
      const entry = runs.get(runId);
      return entry ? toReadonly(entry) : undefined;
    },

    cancel(runId: string): boolean {
      const entry = runs.get(runId);
      if (!entry) return false;
      if (entry.status !== "running") return false;
      entry.abortController.abort();
      return true;
    },

    steer(runId: string, text: string): boolean {
      const entry = runs.get(runId);
      if (!entry) return false;
      if (entry.status !== "running") return false;
      entry.steerInbox.push(text);
      // Bridge: until the Phase 10.03+ engine loop consumes steerInbox we
      // surface a synthetic agent.message so subscribers see that steering
      // was accepted. Replace once the real loop lands.
      const synthetic: AgentEvent = {
        type: "agent.message",
        session_id: entry.sessionId,
        ts: Date.now(),
        seq: entry.nextId,
        delta: `[steer] ${text}`,
        final: false,
      };
      pushEvent(entry, synthetic);
      return true;
    },

    async resume(runId: string, opts: ResumeRunOptions): Promise<RunEntry> {
      const parent = runs.get(runId);
      if (!parent) throw new RunNotFoundError(runId);
      const sessionId = parent.sessionId;

      // Hydrate prior state from JSONL; we don't yet feed it into the
      // iterator (Phase 10.03+), but the call validates the session exists
      // on disk and lets us fail fast if not.
      try {
        await resumeSession({
          sessionId,
          paths,
          projectHash: parent.projectHash,
          logger,
        });
      } catch (err) {
        logger.warn({ err, runId, sessionId }, "run-manager: resumeSession failed; proceeding");
      }

      const newRunId = randomUUID();
      const { jsonl, sessionWriter, pHash } = await openDurability(sessionId, parent.cwd);
      const entry = makeEntry(newRunId, sessionId, parent.cwd, jsonl, sessionWriter, pHash);
      runs.set(newRunId, entry);
      totalRuns++;

      void startIterator(entry, { prompt: opts.prompt, sessionId, cwd: parent.cwd });
      return toReadonly(entry);
    },

    snapshot(): RunManagerSnapshot {
      let active = 0;
      for (const e of runs.values()) if (e.status === "running") active++;
      return { activeRuns: active, totalRuns, completedRuns };
    },

    async shutdown(graceMs: number): Promise<void> {
      if (closed) return;
      closed = true;

      const actives: Promise<void>[] = [];
      for (const entry of runs.values()) {
        if (entry.status === "running") {
          entry.abortController.abort();
          actives.push(entry.done);
        }
      }

      if (actives.length === 0) return;

      const timer = new Promise<void>((resolve) => {
        const t = setTimeout(() => resolve(), graceMs);
        t.unref();
      });
      await Promise.race([Promise.all(actives).then(() => undefined), timer]);
    },
  };
}

/** Freeze a mutable entry into the public readonly view. */
function toReadonly(entry: MutableRunEntry): RunEntry {
  return {
    runId: entry.runId,
    sessionId: entry.sessionId,
    status: entry.status,
    buffer: entry.buffer,
    emitter: entry.emitter,
    abortController: entry.abortController,
    completedAt: entry.completedAt,
    createdAt: entry.createdAt,
  };
}

/**
 * Default iterator factory.
 *
 * Phase 99.03: when the caller wired up `provider` + `hooks` + `permissions` +
 * `defaultModel`, we drive the real `runAgentLoop` generator. Otherwise we
 * fall back to the Phase-0 stub (`engineRun`) so library consumers without an
 * API key and legacy tests keep working.
 */
function makeDefaultRunFactory(
  mgr: RunManagerOptions,
  logger: Logger,
): (
  opts: CreateRunOptions & { signal: AbortSignal; sessionId: string },
) => AsyncIterable<AgentEvent> {
  const realLoopReady =
    mgr.provider !== undefined &&
    mgr.hooks !== undefined &&
    mgr.permissions !== undefined &&
    mgr.defaultModel !== undefined;

  if (!realLoopReady) {
    return (opts) => {
      const { prompt, sessionId, cwd } = opts;
      // Signal is intentionally dropped here — the legacy stub ignores it.
      return engineRun({
        wish: prompt,
        sessionId,
        ...(cwd !== undefined ? { cwd } : {}),
      });
    };
  }

  const provider = mgr.provider as Provider;
  const hooks = mgr.hooks as HookRegistry;
  const permissions = mgr.permissions as CompiledPermissions;
  const defaultModel = mgr.defaultModel as string;
  const defaultCwd = mgr.defaultCwd ?? process.cwd();
  const mcp = mgr.mcp;

  return (opts) => {
    const model = opts.model ?? defaultModel;
    const cwd = opts.cwd ?? defaultCwd;
    // Resolve the system prompt: caller override wins; else pull jellyclaw's
    // default voice (via `loadSoul()` — honours env + ~/.jellyclaw/soul.md).
    // Wrapped in an async generator so we can await the disk read without
    // changing the factory's sync return signature.
    async function* runWithSoul(): AsyncGenerator<AgentEvent, void, void> {
      const systemPrompt =
        opts.appendSystemPrompt !== undefined
          ? opts.appendSystemPrompt
          : ((await loadSoul({ logger })) ?? undefined);
      yield* runAgentLoop({
        provider,
        hooks,
        permissions,
        model,
        prompt: opts.prompt,
        sessionId: opts.sessionId,
        cwd,
        signal: opts.signal,
        logger,
        ...(systemPrompt !== undefined ? { systemPrompt } : {}),
        ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
        ...(opts.priorMessages !== undefined ? { priorMessages: opts.priorMessages } : {}),
        ...(mcp !== undefined ? { mcp } : {}),
      });
    }
    return runWithSoul();
  };
}
