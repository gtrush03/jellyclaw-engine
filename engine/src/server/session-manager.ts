/**
 * Phase 10.5 — Session facade over {@link RunManager}.
 *
 * The vendored OpenCode TUI (via {@link engine/src/tui/sdk-adapter.ts}) speaks
 * in sessions: list, get, delete, messages, pending-permissions. Jellyclaw's
 * primary state unit is a *run* (one engine turn); a *session* is the stable
 * identifier carried across runs. This module provides the thin projection
 * without introducing a parallel persistent store.
 *
 * Responsibilities:
 *   - Index active runs by `sessionId` (many-to-one: many runs can share one
 *     session id across resume/continue).
 *   - Observe each run's EventEmitter and fan-in to a single global emitter
 *     consumed by `GET /v1/events` SSE subscribers.
 *   - Track pending permission prompts per session — a `permission.requested`
 *     event enqueues an entry, a subsequent `permission.granted` /
 *     `permission.denied` (matched by `request_id`) clears it, and
 *     `replyPermission` emits a bridge event the engine loop will replace
 *     once Phase 10.03+ wires the real `UserPromptSubmit` path.
 *
 * Everything else (pure computation, no I/O) stays in the route handler.
 */

import { EventEmitter } from "node:events";

import type { Logger } from "pino";

import type { AgentEvent } from "../events.js";
import type { BufferedEvent, RunEntry, RunManager } from "./types.js";

// ---------------------------------------------------------------------------
// Public shapes (stable across Phase 10.5 → 10.6)
// ---------------------------------------------------------------------------

export interface SessionSummary {
  readonly id: string;
  readonly title?: string;
  readonly createdAt: number;
  readonly status: "running" | "idle" | "completed" | "failed" | "cancelled";
  readonly latestRunId: string;
}

export interface PendingPermission {
  readonly id: string;
  readonly sessionId: string;
  readonly toolName: string;
  readonly reason: string;
  readonly inputPreview: unknown;
  readonly askedAt: number;
}

export interface SessionManager {
  listSessions(): readonly SessionSummary[];
  getSession(sessionId: string): SessionSummary | undefined;
  deleteSession(sessionId: string): boolean;
  listMessages(sessionId: string): readonly AgentEvent[];
  listPendingPermissions(sessionId: string): readonly PendingPermission[];
  replyPermission(
    sessionId: string,
    permissionId: string,
    response: "once" | "always" | "reject",
  ): boolean;
  /** Subscribe to the global event stream. Returns an unsubscribe fn. */
  onEvent(listener: (ev: AgentEvent) => void): () => void;
  /** Register a run so this manager observes it. Idempotent. */
  attachRun(run: RunEntry): void;
}

export interface SessionManagerOptions {
  readonly runManager: RunManager;
  readonly logger: Logger;
}

export function createSessionManager(opts: SessionManagerOptions): SessionManager {
  const { runManager, logger } = opts;
  const globalBus = new EventEmitter();
  globalBus.setMaxListeners(0);

  const attached = new WeakSet<object>();
  const pending = new Map<string, Map<string, PendingPermission>>(); // sessionId → reqId → entry

  function collectRunsBySession(): Map<string, RunEntry[]> {
    const out = new Map<string, RunEntry[]>();
    // `RunManager` does not expose a list API. We can only see runs we've
    // attached. Grab via the internal `get` is impossible without a runId, so
    // the caller (routes) must funnel run creation through `attachRun`. We
    // still tolerate pre-existing runs by iterating attached records.
    for (const run of attachedRuns.values()) {
      const entry = runManager.get(run.runId);
      if (!entry) continue;
      const list = out.get(entry.sessionId);
      if (list) list.push(entry);
      else out.set(entry.sessionId, [entry]);
    }
    return out;
  }

  // Keep a set of attached runs so we can enumerate. A Map<runId, RunEntry>
  // because `RunManager.get(runId)` is the only accessor exposed by the
  // frozen contract in `types.ts`.
  const attachedRuns = new Map<string, RunEntry>();

  function summariseSession(sessionId: string, runs: RunEntry[]): SessionSummary | undefined {
    if (runs.length === 0) return undefined;
    const sorted = [...runs].sort((a, b) => a.createdAt - b.createdAt);
    const latest = sorted[sorted.length - 1];
    const first = sorted[0];
    if (!latest || !first) return undefined;
    const anyRunning = runs.some((r) => r.status === "running");
    const status: SessionSummary["status"] = anyRunning
      ? "running"
      : (latest.status as SessionSummary["status"]);
    return {
      id: sessionId,
      createdAt: first.createdAt,
      status,
      latestRunId: latest.runId,
    };
  }

  function handleEvent(run: RunEntry, buffered: BufferedEvent): void {
    const ev = buffered.event;
    // Permission bookkeeping.
    if (ev.type === "permission.requested") {
      const pendingForSession = pending.get(run.sessionId) ?? new Map<string, PendingPermission>();
      pendingForSession.set(ev.request_id, {
        id: ev.request_id,
        sessionId: run.sessionId,
        toolName: ev.tool_name,
        reason: ev.reason,
        inputPreview: ev.input_preview,
        askedAt: ev.ts,
      });
      pending.set(run.sessionId, pendingForSession);
    } else if (ev.type === "permission.granted" || ev.type === "permission.denied") {
      const pendingForSession = pending.get(run.sessionId);
      if (pendingForSession) {
        pendingForSession.delete(ev.request_id);
        if (pendingForSession.size === 0) pending.delete(run.sessionId);
      }
    }
    globalBus.emit("event", ev);
  }

  return {
    attachRun(run: RunEntry): void {
      if (attached.has(run.emitter)) return;
      attached.add(run.emitter);
      attachedRuns.set(run.runId, run);

      // Replay buffered events into the global bus so a subscriber that
      // attached before this run was observed still sees them.
      for (const buffered of run.buffer) {
        handleEvent(run, buffered);
      }

      const onEvt = (buffered: BufferedEvent): void => {
        handleEvent(run, buffered);
      };
      const onDone = (): void => {
        run.emitter.off("event", onEvt);
      };
      run.emitter.on("event", onEvt);
      run.emitter.once("done", onDone);
    },

    listSessions(): readonly SessionSummary[] {
      const grouped = collectRunsBySession();
      const out: SessionSummary[] = [];
      for (const [sid, runs] of grouped) {
        const s = summariseSession(sid, runs);
        if (s) out.push(s);
      }
      out.sort((a, b) => b.createdAt - a.createdAt);
      return out;
    },

    getSession(sessionId: string): SessionSummary | undefined {
      const grouped = collectRunsBySession();
      const runs = grouped.get(sessionId);
      if (!runs) return undefined;
      return summariseSession(sessionId, runs);
    },

    deleteSession(sessionId: string): boolean {
      const grouped = collectRunsBySession();
      const runs = grouped.get(sessionId);
      if (!runs) return false;
      let cancelled = false;
      for (const r of runs) {
        if (r.status === "running") {
          runManager.cancel(r.runId);
          cancelled = true;
        }
        attachedRuns.delete(r.runId);
      }
      pending.delete(sessionId);
      return cancelled || runs.length > 0;
    },

    listMessages(sessionId: string): readonly AgentEvent[] {
      const grouped = collectRunsBySession();
      const runs = grouped.get(sessionId);
      if (!runs) return [];
      const events: AgentEvent[] = [];
      const sorted = [...runs].sort((a, b) => a.createdAt - b.createdAt);
      for (const r of sorted) {
        for (const buf of r.buffer) events.push(buf.event);
      }
      return events;
    },

    listPendingPermissions(sessionId: string): readonly PendingPermission[] {
      const m = pending.get(sessionId);
      if (!m) return [];
      return [...m.values()].sort((a, b) => a.askedAt - b.askedAt);
    },

    replyPermission(sessionId, permissionId, response): boolean {
      const m = pending.get(sessionId);
      const entry = m?.get(permissionId);
      if (!m || !entry) return false;
      m.delete(permissionId);
      if (m.size === 0) pending.delete(sessionId);
      logger.debug(
        { sessionId, permissionId, response },
        "session-manager: permission reply recorded (engine loop will consume in 10.03+)",
      );
      // Bridge: emit a synthetic granted/denied event so SSE subscribers see
      // the decision. The real engine loop will replace this once the
      // UserPromptSubmit wire is live.
      const now = Date.now();
      if (response === "reject") {
        globalBus.emit("event", {
          type: "permission.denied",
          session_id: sessionId,
          ts: now,
          seq: 0,
          request_id: permissionId,
          denied_by: "user",
          reason: "user rejected",
        } satisfies AgentEvent);
      } else {
        globalBus.emit("event", {
          type: "permission.granted",
          session_id: sessionId,
          ts: now,
          seq: 0,
          request_id: permissionId,
          scope: response === "always" ? "forever" : "once",
          granted_by: "user",
        } satisfies AgentEvent);
      }
      return true;
    },

    onEvent(listener): () => void {
      const wrap = (ev: AgentEvent): void => listener(ev);
      globalBus.on("event", wrap);
      return () => globalBus.off("event", wrap);
    },
  };
}
