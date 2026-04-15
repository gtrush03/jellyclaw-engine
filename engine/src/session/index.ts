/**
 * Session store public surface.
 *
 * Consumers should import from this barrel rather than reaching into
 * individual modules. The `Db.raw` better-sqlite3 handle is intentionally
 * re-exported as part of the `Db` interface so advanced readers can issue
 * ad-hoc queries, but writes MUST go through {@link SessionWriter}.
 *
 * Phase 09.02 adds the JSONL transcript + replay + reduce surface. Resume,
 * continue, and idempotency (wish ledger) are owned by a sibling agent and
 * not yet landed; their re-exports are marked TODO below and will be wired
 * up during the final integration pass.
 */

export type { ContinueInputs } from "./continue.js";
// Phase 09.02 — resume, continue, idempotency (integration pass)
export { continueSession, findLatestForProject } from "./continue.js";
// Phase 09.01 — storage layer
export type { Db, OpenDbOptions } from "./db.js";
export { openDb } from "./db.js";
export type { FtsHit, FtsSearchOptions } from "./fts.js";
export { searchMessages } from "./fts.js";
export { WishLedger } from "./idempotency.js";
// Phase 09.02 — JSONL writer + replay
export { openJsonl } from "./jsonl.js";
// Phase 09.02 — meta sidecar
export { readSessionMeta, writeSessionMeta } from "./meta.js";
export type { SessionPathsOptions } from "./paths.js";
export { projectHash, SessionPaths } from "./paths.js";
// Phase 09.02 — pure reducer
export { reduceEvents } from "./reduce.js";
export type { ReplayResult } from "./replay.js";
export { replayJsonl } from "./replay.js";
export type { ResumeInputs } from "./resume.js";
export { resumeSession } from "./resume.js";
// Phase 09.02 — frozen shared contracts
export type {
  AgentEvent,
  BeginWishOptions,
  CumulativeUsage,
  EngineState,
  JsonlWriter,
  OpenJsonlOptions,
  ReplayedMessage,
  ReplayedPermissionDecision,
  ReplayedToolCall,
  ResumeOptions,
  SessionListRow,
  SessionMeta,
  WishCheckOutcome,
  WishRecord,
} from "./types.js";
export {
  DEFAULT_DROPPED_TOOL_RESULT,
  DEFAULT_ROTATE_BYTES,
  EMPTY_USAGE,
  JsonlCorruptError,
  NoSessionForProjectError,
  SessionNotFoundError,
  WishConflictError,
} from "./types.js";
export type {
  AppendMessageInput,
  AppendToolCallInput,
  UpdateUsageInput,
  UpsertSessionInput,
} from "./writer.js";
export { SessionWriter } from "./writer.js";
