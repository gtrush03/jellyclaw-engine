/**
 * Phase 09.02 shared contracts — JSONL transcript, replay, resume, idempotency.
 *
 * All three agents (JSONL layer, resume/continue/idempotency, CLI) code against
 * this single file so their outputs compose without surprises.
 *
 * Philosophy: the JSONL file is an append-only log of `AgentEvent` values plus
 * `.meta.json` for denormalized summary. SQLite is an index over that — if the
 * DB and the FS ever disagree, **the filesystem wins** (Phase 09's source of
 * truth is the JSONL; SQLite is a derived cache). Replay/resume must be
 * deterministic: same JSONL input → same `EngineState`.
 */

import type { AgentEvent } from "../events.js";

// ---------------------------------------------------------------------------
// Session meta (written atomically by meta.ts; read by CLI + resume)
// ---------------------------------------------------------------------------

/**
 * `.meta.json` sidecar — one per session. Denormalized for fast `sessions list`
 * rendering. Source of truth remains the JSONL; meta may lag by at most one
 * turn if we crash between `fsync` of the JSONL and the atomic rename of meta.
 * Readers that detect a stale meta should prefer a re-derive from JSONL.
 */
export interface SessionMeta {
  readonly version: 1;
  readonly sessionId: string;
  readonly projectHash: string;
  readonly cwd: string;
  readonly model: string | null;
  readonly provider: "anthropic" | "openrouter" | null;
  readonly createdAt: number;
  readonly lastTurnAt: number;
  readonly parentSessionId: string | null;
  readonly status: "active" | "ended" | "archived";
  /** First 240 chars of the last assistant message, trimmed. */
  readonly summary: string | null;
  readonly turns: number;
  readonly usage: CumulativeUsage;
}

export interface CumulativeUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly costUsdCents: number;
}

export const EMPTY_USAGE: CumulativeUsage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsdCents: 0,
});

// ---------------------------------------------------------------------------
// Rehydrated engine state (what resume() returns)
// ---------------------------------------------------------------------------

/**
 * A single conversational message as reconstructed from the event stream.
 * `agent.message` deltas are concatenated into one `assistant` message per
 * contiguous run ending at `final: true`. `user` messages come from
 * `session.started.wish` and (in Phase 10+) any follow-on user input events.
 */
export interface ReplayedMessage {
  readonly role: "user" | "assistant" | "system";
  readonly content: string;
  /** `seq` of the first event contributing to this message. */
  readonly firstSeq: number;
  /** `ts` of the first event contributing to this message. */
  readonly firstTs: number;
}

/**
 * A tool invocation reconstructed from `tool.called` + `tool.result`/`tool.error`
 * pairs keyed on `tool_id`. Missing result indicates the turn was interrupted
 * (crash mid-call) — callers may choose to prune or replay.
 */
export interface ReplayedToolCall {
  readonly toolId: string;
  readonly toolName: string;
  readonly input: unknown;
  readonly result: unknown | null;
  readonly error: { code: string; message: string } | null;
  readonly durationMs: number | null;
  readonly startedAt: number;
  readonly finishedAt: number | null;
  readonly startSeq: number;
}

export interface ReplayedPermissionDecision {
  readonly requestId: string;
  readonly toolName: string;
  readonly outcome: "granted" | "denied";
  readonly grantedBy?: "user" | "policy" | "auto";
  readonly deniedBy?: "user" | "policy" | "auto";
  readonly scope?: "once" | "session" | "forever";
  readonly ts: number;
}

/**
 * Fully reconstructed engine state after replaying a JSONL transcript.
 *
 * Intentionally event-shaped (messages, toolCalls, usage). Todos and memory
 * are NOT yet in the AgentEvent union; when Phase 10's engine loop emits them
 * they'll be added here and the reducer extended. Until then consumers should
 * treat `todos`/`memory` as `undefined` and not assume presence.
 */
export interface EngineState {
  readonly sessionId: string;
  readonly projectHash: string | null;
  readonly cwd: string | null;
  readonly model: string | null;
  readonly provider: "anthropic" | "openrouter" | null;
  readonly messages: readonly ReplayedMessage[];
  readonly toolCalls: readonly ReplayedToolCall[];
  readonly permissions: readonly ReplayedPermissionDecision[];
  readonly usage: CumulativeUsage;
  /** Max `seq` observed; the next emitted event must use `seq + 1`. */
  readonly lastSeq: number;
  /** Max `ts` observed across events. */
  readonly lastTs: number;
  /** Number of completed turns (session.completed events). */
  readonly turns: number;
  /** True if the last line in the JSONL was partial (crash mid-write). */
  readonly truncatedTail: boolean;
  /** True if the session ended cleanly (saw a session.completed event). */
  readonly ended: boolean;
}

// ---------------------------------------------------------------------------
// Resume trimming options (context-budget aware)
// ---------------------------------------------------------------------------

export interface ResumeOptions {
  /**
   * Soft cap on the token-estimate of the rehydrated transcript. When
   * exceeded, `resume()` drops oldest `tool_result` payloads first (keeping
   * the `tool_use` id so the model's structural expectations still hold),
   * then summarises oldest turns. Default: undefined — no trimming, caller
   * decides what to do with an oversize state.
   */
  readonly maxContextTokens?: number;
  /**
   * Placeholder for `tool_result` content when dropped. Caller can re-fetch
   * on demand by looking up the `tool_id` in the SQLite `tool_calls` table.
   */
  readonly droppedToolResultPlaceholder?: string;
}

export const DEFAULT_DROPPED_TOOL_RESULT = "<dropped on resume; re-fetch if needed>";

// ---------------------------------------------------------------------------
// JSONL writer contract
// ---------------------------------------------------------------------------

/**
 * A durable append-only log per session. One open handle per live session.
 * Constructed lazily on first write; must be `close()`d on engine shutdown.
 *
 * Durability contract:
 *   - Every `write(event)` appends one JSON line (`NDJSON`). NOT fsynced.
 *   - `flushTurn()` issues one `fsync`; call on `session.completed` and on
 *     graceful engine shutdown. Per-event fsync is a non-starter (5–20 ms).
 *   - On crash mid-write, replay tolerates a truncated final line.
 */
export interface JsonlWriter {
  readonly sessionId: string;
  readonly projectHash: string;
  readonly path: string;
  write(event: AgentEvent): Promise<void>;
  /** fsync the current log file. Idempotent. */
  flushTurn(): Promise<void>;
  /**
   * If the file is ≥ the rotation threshold, move `<id>.jsonl` → `<id>.jsonl.1`
   * (shifting older suffixes, gzipping anything beyond `.3`) and reopen a
   * fresh handle. No-op if under threshold. MUST only be called at turn
   * boundary (after `flushTurn()` or when no write is in flight).
   */
  maybeRotate(): Promise<void>;
  close(): Promise<void>;
}

export interface OpenJsonlOptions {
  readonly sessionId: string;
  readonly projectHash: string;
  readonly paths: import("./paths.js").SessionPaths;
  /** Default 100 MB. Tests set this tiny to exercise rotation. */
  readonly rotateBytes?: number;
  readonly logger?: import("pino").Logger;
  /**
   * Injectable clock; defaults to `Date.now`. Used by rotation for sidecar
   * timestamps; event `ts` values always come from the event itself.
   */
  readonly now?: () => number;
}

export const DEFAULT_ROTATE_BYTES = 100 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Idempotency ledger (wishes)
// ---------------------------------------------------------------------------

export interface WishRecord {
  readonly id: string;
  readonly status: "running" | "done" | "failed";
  readonly attempt: number;
  readonly startedAt: number;
  readonly finishedAt: number | null;
  readonly sessionId: string | null;
  readonly resultJson: string | null;
  readonly error: string | null;
}

export type WishCheckOutcome =
  | { readonly kind: "fresh"; readonly record: WishRecord }
  | { readonly kind: "cached"; readonly record: WishRecord }
  | { readonly kind: "running"; readonly record: WishRecord }
  | { readonly kind: "retry"; readonly record: WishRecord };

export interface BeginWishOptions {
  readonly wishId: string;
  readonly sessionId?: string;
  /** If true and an existing `running` record is found, forcibly take it over. */
  readonly force?: boolean;
}

// ---------------------------------------------------------------------------
// Session summary rows (for CLI sessions list/search)
// ---------------------------------------------------------------------------

export interface SessionListRow {
  readonly id: string;
  readonly projectHash: string;
  readonly cwd: string;
  readonly model: string | null;
  readonly status: "active" | "ended" | "archived";
  readonly createdAt: number;
  readonly lastTurnAt: number;
  readonly summary: string | null;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class SessionNotFoundError extends Error {
  override readonly name = "SessionNotFoundError";
  constructor(public readonly sessionId: string) {
    super(`session not found: ${sessionId}`);
  }
}

export class NoSessionForProjectError extends Error {
  override readonly name = "NoSessionForProjectError";
  constructor(public readonly projectHash: string) {
    super(`no sessions found for project ${projectHash}`);
  }
}

export class JsonlCorruptError extends Error {
  override readonly name = "JsonlCorruptError";
  constructor(
    message: string,
    public readonly lineNumber: number,
  ) {
    super(`${message} (line ${lineNumber})`);
  }
}

export class WishConflictError extends Error {
  override readonly name = "WishConflictError";
  constructor(
    public readonly wishId: string,
    public readonly record: WishRecord,
  ) {
    super(
      `wish ${wishId} already running (attempt ${record.attempt}) since ${new Date(
        record.startedAt,
      ).toISOString()}. Pass --force to override.`,
    );
  }
}

// Re-export AgentEvent for convenience.
export type { AgentEvent };
