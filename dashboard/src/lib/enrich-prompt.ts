import type { Prompt, RunRecord } from "@/types";

/**
 * Unified lifecycle states the PromptCard renders. Merged from two sources:
 *   1. `Prompt.status`   — derived from COMPLETION-LOG.md (authoritative for DONE)
 *   2. `RunRecord.status` + `needs_review` — autobuild rig state
 *
 * The card picks a visual style from this enum. A run that doesn't exist yet
 * resolves to PENDING.
 */
export type EnrichedState =
  | "PENDING"
  | "RUNNING"
  | "FINALIZING"
  | "DONE"
  | "FAILED"
  | "ESCALATED"
  | "REVIEW";

export interface EnrichedPrompt {
  prompt: Prompt;
  run: RunRecord | null;
  state: EnrichedState;
}

export interface EnrichOptions {
  /** `Date.now()` at the call site — injected for deterministic tests. */
  now?: number;
  /** Grace period for the "complete but log is stale" case. */
  finalizingGraceMs?: number;
}

const DEFAULT_FINALIZING_GRACE_MS = 10_000;

/**
 * Conflict-resolution rules (from the spec):
 *   1. `COMPLETION-LOG.md` says DONE  → DONE wins.
 *   2. state says running + log missing → RUNNING wins.
 *   3. state says complete + log missing for >= graceMs → RUNNING "finalizing".
 *   4. neither running nor done → PENDING.
 *
 * `needs_review` on the run trumps everything except DONE (a review gate is
 * useless if the work already landed in COMPLETION-LOG).
 *
 * `failed`/`escalated` bubble up as their own states when COMPLETION-LOG has
 * not declared the prompt done.
 */
export function enrichPrompt(
  prompt: Prompt,
  run: RunRecord | null,
  opts: EnrichOptions = {},
): EnrichedPrompt {
  const now = opts.now ?? Date.now();
  const graceMs = opts.finalizingGraceMs ?? DEFAULT_FINALIZING_GRACE_MS;

  const logSaysDone = prompt.status === "complete";
  const logSaysInProgress = prompt.status === "in-progress";

  // Rule 1 — DONE is terminal. Do NOT downgrade to REVIEW / FAILED even if
  // the run object is still hanging around in memory.
  if (logSaysDone) {
    return { prompt, run, state: "DONE" };
  }

  if (!run) {
    return { prompt, run: null, state: "PENDING" };
  }

  // Review gate takes precedence over the machine state — it's a human signal.
  if (run.needs_review) {
    return { prompt, run, state: "REVIEW" };
  }

  // Rule 3 — run claims complete/passed but COMPLETION-LOG hasn't caught up.
  // Within the grace window render as FINALIZING (same as RUNNING visually
  // for now but distinguishable by callers). Past the grace window we still
  // respect the run — it'll flip to DONE once the log lands.
  if (run.status === "complete" || run.status === "passed") {
    const updatedAt = Date.parse(run.updated_at);
    const delta = Number.isFinite(updatedAt) ? now - updatedAt : 0;
    if (!logSaysDone && delta < graceMs) {
      return { prompt, run, state: "FINALIZING" };
    }
    // Past the grace window: bias toward the run. If the log has been silent
    // for >= graceMs AND the run says done, treat as DONE.
    return { prompt, run, state: "DONE" };
  }

  if (run.status === "escalated") {
    return { prompt, run, state: "ESCALATED" };
  }

  if (run.status === "failed") {
    return { prompt, run, state: "FAILED" };
  }

  // Rule 2 — anything that smells like in-flight work is RUNNING. Covers
  // queued/spawning/prompting/working/completion_detected/testing/retrying.
  const runningStatuses: ReadonlyArray<RunRecord["status"]> = [
    "queued",
    "spawning",
    "prompting",
    "working",
    "completion_detected",
    "testing",
    "retrying",
  ];
  if (runningStatuses.includes(run.status)) {
    return { prompt, run, state: "RUNNING" };
  }

  // Fallback — if COMPLETION-LOG says in-progress but we have no matching run
  // state, RUN is the more informative one.
  if (logSaysInProgress) {
    return { prompt, run, state: "RUNNING" };
  }

  return { prompt, run, state: "PENDING" };
}
