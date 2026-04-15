/**
 * Phase 09.02 — resume a session from its JSONL transcript.
 *
 * Flow: locate JSONL → `replayJsonl` → `reduceEvents` → apply `ResumeOptions`
 * trimming → return `EngineState`. The trimming step uses a cheap char/4
 * token estimate and drops oldest resolved `tool_result` payloads (keeping
 * the `tool_use` ids) until the budget fits, preserving the most-recent
 * unresolved tool chain so the model's structural expectations still hold.
 */

import type { Logger } from "pino";

import { createLogger } from "../logger.js";
import type { Db } from "./db.js";
import type { SessionPaths } from "./paths.js";
import { reduceEvents } from "./reduce.js";
import { replayJsonl } from "./replay.js";
import {
  DEFAULT_DROPPED_TOOL_RESULT,
  type EngineState,
  type ReplayedToolCall,
  type ResumeOptions,
  SessionNotFoundError,
} from "./types.js";

export interface ResumeInputs {
  readonly sessionId: string;
  readonly paths: SessionPaths;
  /** If omitted, resolved via `SELECT project_hash FROM sessions WHERE id = ?`. */
  readonly projectHash?: string;
  /** Required when `projectHash` is omitted. */
  readonly db?: Db;
  readonly resumeOptions?: ResumeOptions;
  readonly logger?: Logger;
}

// ---------------------------------------------------------------------------
// Token estimate — cheap, deliberately approximate
// ---------------------------------------------------------------------------

/**
 * Rough token estimate: `ceil(chars/4)`. This is the standard coarse bound
 * documented in Anthropic's guides — it's wrong by a few percent but fast
 * enough to run in a hot trim loop without tokenizing properly.
 */
function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

function toolCallTokens(tc: ReplayedToolCall): number {
  let total = estimateTokens(tc.toolName);
  try {
    total += estimateTokens(JSON.stringify(tc.input ?? null));
  } catch {
    // circular / unserializable — give up on this portion
  }
  if (tc.result !== null) {
    try {
      total += estimateTokens(JSON.stringify(tc.result));
    } catch {
      // see above
    }
  }
  if (tc.error !== null) {
    total += estimateTokens(`${tc.error.code}${tc.error.message}`);
  }
  return total;
}

function estimateStateTokens(state: EngineState): number {
  let total = 0;
  for (const m of state.messages) total += estimateTokens(m.content);
  for (const tc of state.toolCalls) total += toolCallTokens(tc);
  return total;
}

/**
 * Trim oldest resolved `tool_result` payloads by replacing `result` with the
 * placeholder string. Walks in ascending `startSeq`. Leaves:
 *   (a) the most-recent unresolved tool_call untouched (active chain), and
 *   (b) any call whose `result` is already the placeholder alone.
 *
 * If after replacing every eligible result we're still over budget, returns
 * the partially-trimmed state and lets the caller decide (we log a warn).
 */
function applyTrimming(state: EngineState, options: ResumeOptions, logger: Logger): EngineState {
  if (options.maxContextTokens === undefined) return state;
  const budget = options.maxContextTokens;
  const placeholder = options.droppedToolResultPlaceholder ?? DEFAULT_DROPPED_TOOL_RESULT;

  let current = estimateStateTokens(state);
  if (current <= budget) return state;

  // Identify the most recent unresolved call (by startSeq). Exclude it from
  // trimming so the model's tool-use/tool-result pairing stays intact.
  let unresolvedLatestSeq = -1;
  for (const tc of state.toolCalls) {
    if (tc.result === null && tc.error === null && tc.startSeq > unresolvedLatestSeq) {
      unresolvedLatestSeq = tc.startSeq;
    }
  }

  // Sort indices by ascending startSeq — oldest first.
  const order = state.toolCalls
    .map((tc, i) => ({ i, seq: tc.startSeq }))
    .sort((a, b) => a.seq - b.seq)
    .map((x) => x.i);

  const mutated: ReplayedToolCall[] = state.toolCalls.slice();

  for (const idx of order) {
    if (current <= budget) break;
    const tc = mutated[idx];
    if (!tc) continue;
    if (tc.startSeq === unresolvedLatestSeq) continue;
    if (tc.result === null) continue; // nothing to drop
    if (tc.result === placeholder) continue; // already trimmed

    const before = toolCallTokens(tc);
    const replaced: ReplayedToolCall = { ...tc, result: placeholder };
    mutated[idx] = replaced;
    const after = toolCallTokens(replaced);
    current -= Math.max(0, before - after);
  }

  if (current > budget) {
    logger.warn(
      { estimated: current, budget },
      "resume: trimmed tool results but still over context budget; returning as-is",
    );
  }

  return { ...state, toolCalls: mutated };
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

export async function resumeSession(inputs: ResumeInputs): Promise<EngineState> {
  const logger: Logger = inputs.logger ?? createLogger({ name: "session-resume" });

  let projectHash = inputs.projectHash;
  if (projectHash === undefined) {
    if (!inputs.db) {
      throw new Error("resumeSession: projectHash omitted and no db provided");
    }
    const row = inputs.db.raw
      .prepare("SELECT project_hash FROM sessions WHERE id = ?")
      .get(inputs.sessionId) as { project_hash: string } | undefined;
    if (!row) throw new SessionNotFoundError(inputs.sessionId);
    projectHash = row.project_hash;
  }

  const path = inputs.paths.sessionLog(projectHash, inputs.sessionId);
  const replay = await replayJsonl(path, { logger });

  if (replay.events.length === 0 && replay.linesRead === 0 && replay.bytesRead === 0) {
    // replayJsonl returns empty counters specifically on ENOENT.
    throw new SessionNotFoundError(inputs.sessionId);
  }

  const state = reduceEvents(replay.events, { truncatedTail: replay.truncatedTail });

  // If the reducer didn't observe a session.started, backfill projectHash so
  // callers that hit an unusual transcript still get a sane state back.
  const withHash: EngineState = state.projectHash ? state : { ...state, projectHash };

  if (!inputs.resumeOptions) return withHash;
  return applyTrimming(withHash, inputs.resumeOptions, logger);
}
