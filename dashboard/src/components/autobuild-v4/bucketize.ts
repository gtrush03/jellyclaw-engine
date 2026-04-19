/**
 * Correct, rig-state-aware bucketize + tier-count math for autobuild-v4.
 *
 * Ground truth: the previous implementation in `autobuild-v3/logic.ts` +
 * `autobuild-v2/logic.ts` lied in two specific ways, both observed live:
 *
 *   1. `bucketizeRuns` placed runs in status `complete` OR `passed` in the
 *      `completed` bucket, but other counters fed off narrower status filters,
 *      producing "Completed 4" in one column next to "0 completed" in the top
 *      strip. This file unifies on ONE set of rules that every v4 counter uses.
 *
 *   2. `tierCountsFromPrompts` counted `prompt.status === 'complete'` — but
 *      `prompt.status` is the LEGACY phase-level status, not the per-prompt
 *      run outcome. Four T0 runs could be `complete` in `rig.runs` while their
 *      prompts were still `not-started` in `/api/status`, producing a tier
 *      strip that read "T0 0/5" even though 4 prompts had merged.
 *
 * v4 fix: ALWAYS join against `rig.runs[id].status` + `rig.completed[]` when
 * computing tier counts. Trust the rig, not the legacy phase snapshot.
 *
 * Pure, React-free, no `any`, no network — unit-tested by the sibling
 * `bucketize.test.ts`.
 */

import type { Prompt, RigState, RunRecord, RunStatus, Tier } from "@/types";

// ---------------------------------------------------------------------------
// Bucketize — splits a rig snapshot into the five queue slots the UI renders
// ---------------------------------------------------------------------------

/**
 * Statuses that represent "the rig is actively chewing on this run right now".
 * `completion_detected` counts as running because the rig hasn't yet moved on —
 * the test/commit phase is still in flight. `retrying` also counts as running
 * because a retry means another working session is spinning up.
 *
 * `self_checking` is not in `RunStatus` today but is documented as a transient
 * phase inside `working`; we keep the string here so a future schema bump
 * doesn't regress the bucket.
 */
export const RUNNING_STATUSES: ReadonlySet<string> = new Set<string>([
  "spawning",
  "prompting",
  "working",
  "completion_detected",
  "self_checking",
  "testing",
  "retrying",
]);

/**
 * Statuses that mean the run completed successfully. `passed` is an older
 * terminal success emitted by some transitions; `complete` is the canonical
 * terminal success. We treat both as "done" for the UI.
 */
export const COMPLETED_STATUSES: ReadonlySet<string> = new Set<string>(["complete", "passed"]);

/**
 * An entry in any of the v4 buckets. We pair the id and the record so downstream
 * code doesn't have to re-key. `run` is nullable so the queued bucket can carry
 * synthetic placeholders for ids that are listed in `state.queue` but haven't
 * had a RunRecord materialized yet (pre-spawn state).
 */
export interface BucketEntry {
  runId: string;
  run: RunRecord | null;
}

/**
 * The five sections the v4 UI renders. Every run lands in exactly one bucket.
 * Ordering rule (checked in `bucketize`):
 *   1. `needs_review === true`          → review  (overrides everything)
 *   2. `status === 'escalated'` or
 *      `state.halted` with a current run → escalated
 *   3. status ∈ RUNNING_STATUSES         → running
 *   4. `status === 'queued'`             → queued
 *   5. `status === 'failed'`             → failed (retryable)
 *   6. status ∈ COMPLETED_STATUSES       → completed
 *   (otherwise → dropped, should never happen for a valid snapshot)
 */
export interface Buckets {
  running: BucketEntry[];
  queued: BucketEntry[];
  review: BucketEntry[];
  escalated: BucketEntry[];
  completed: BucketEntry[];
  failed: BucketEntry[];
}

/**
 * Bucketize a rig snapshot.
 *
 * Key correctness rules:
 *   - `needs_review: true` wins over status. A run that ended in `complete`
 *     with `needs_review: true` belongs in `review`, not `completed`. This is
 *     the v3 bug we're fixing in reverse — v3 let `completed` steal review runs
 *     in certain code paths.
 *   - Ids in `state.queue` but absent from `state.runs` get synthetic entries
 *     with `run: null` in `queued`. The dispatcher reserves these slots before
 *     spawning; the UI wants to see them so the "UP NEXT" count matches the
 *     queue length.
 *   - `completed` and `escalated` are sorted most-recently-updated first so the
 *     DONE feed reads top-down in chronological order.
 */
export function bucketize(state: RigState | null | undefined): Buckets {
  const buckets: Buckets = {
    running: [],
    queued: [],
    review: [],
    escalated: [],
    completed: [],
    failed: [],
  };

  if (!state) return buckets;

  const seen = new Set<string>();
  const escalatedIds = new Set<string>(state.escalated ?? []);

  for (const [id, run] of Object.entries(state.runs)) {
    seen.add(id);
    const entry: BucketEntry = { runId: id, run };

    // 1. needs_review wins over everything else.
    if (run.needs_review) {
      buckets.review.push(entry);
      continue;
    }

    // 2. escalated = terminal failure the operator must deal with. Trust
    //    EITHER the run's own `status === 'escalated'` OR membership in the
    //    authoritative `state.escalated[]` list (the dispatcher leaves the
    //    run's status as `failed` but flags the id after max retries).
    //    If the whole rig is halted and this run is the one mid-flight, also
    //    treat it as escalated so the UI surfaces it as "blocked on human".
    if (run.status === "escalated" || escalatedIds.has(id)) {
      buckets.escalated.push(entry);
      continue;
    }
    if (state.halted && RUNNING_STATUSES.has(run.status)) {
      buckets.escalated.push(entry);
      continue;
    }

    // 3. running = actively in-flight.
    if (RUNNING_STATUSES.has(run.status)) {
      buckets.running.push(entry);
      continue;
    }

    // 4. queued = awaiting dispatch.
    if (run.status === "queued") {
      buckets.queued.push(entry);
      continue;
    }

    // 5. failed = retryable but not yet escalated.
    if (run.status === "failed") {
      buckets.failed.push(entry);
      continue;
    }

    // 6. completed = terminal success.
    if (COMPLETED_STATUSES.has(run.status)) {
      buckets.completed.push(entry);
      continue;
    }

    // Any other status is a schema drift — silently drop so the UI still renders.
  }

  // Synthetic entries for queue ids without run records.
  for (const id of state.queue ?? []) {
    if (seen.has(id)) continue;
    buckets.queued.push({ runId: id, run: null });
  }

  // Also honor the authoritative `state.completed` list — the dispatcher may
  // have advanced the run off its `runs` map after commit, but still flag it
  // as completed. Only add ones we haven't already accounted for.
  for (const id of state.completed ?? []) {
    if (seen.has(id)) continue;
    buckets.completed.push({ runId: id, run: null });
    seen.add(id);
  }

  // Same for escalated — authoritative on the halted-run list.
  for (const id of state.escalated ?? []) {
    if (seen.has(id)) continue;
    buckets.escalated.push({ runId: id, run: null });
    seen.add(id);
  }

  buckets.completed.sort(byUpdatedAtDesc);
  buckets.escalated.sort(byUpdatedAtDesc);

  return buckets;
}

function byUpdatedAtDesc(a: BucketEntry, b: BucketEntry): number {
  const ta = a.run?.updated_at ?? "";
  const tb = b.run?.updated_at ?? "";
  if (ta === tb) return 0;
  return ta < tb ? 1 : -1;
}

// ---------------------------------------------------------------------------
// Tier counts — joined against rig.runs, NOT legacy prompt.status
// ---------------------------------------------------------------------------

export interface TierCount {
  /** 0..4 */
  tier: number;
  /** Prompts whose run is in `COMPLETED_STATUSES` OR whose id is in `state.completed`. */
  done: number;
  /** Every prompt with `prompt.tier === tier`. */
  total: number;
  /** Prompts with a matching run in `RUNNING_STATUSES`. */
  running: number;
}

const ALL_TIERS: readonly Tier[] = [0, 1, 2, 3, 4] as const;

/**
 * Tier counts the v4 UI trusts. Unlike `tierCountsFromPrompts` in v2/v3 this
 * JOINS `prompts` → `state.runs[prompt.id]` and consults `state.completed`.
 *
 *   - `done`    = prompts whose matching run.status ∈ COMPLETED_STATUSES, OR
 *                 whose id is in `state.completed`. We union so either side
 *                 of the rig (in-memory `runs` map vs post-commit `completed`
 *                 array) can authoritatively say "this prompt shipped".
 *   - `running` = prompts with a matching run in RUNNING_STATUSES. Excludes
 *                 runs that also have `needs_review: true` because those are
 *                 paused on the human and not actually in flight.
 *   - `total`   = every prompt with `prompt.tier === tier`, regardless of run
 *                 state. Callers that want "only prompts with runs" should
 *                 filter ahead of this function.
 *
 * We deliberately ignore `prompt.status` here — that field is populated from
 * the legacy `/api/status.phaseStatus` aggregation and was the root cause of
 * the "T0 0/5 even though 4 complete" bug.
 */
export function tierCountsV4(
  state: RigState | null | undefined,
  prompts: readonly Prompt[] | null | undefined,
): TierCount[] {
  const out: TierCount[] = ALL_TIERS.map((t) => ({
    tier: t,
    done: 0,
    total: 0,
    running: 0,
  }));

  if (!prompts || prompts.length === 0) return out;

  const runs: Record<string, RunRecord> = state?.runs ?? {};
  const completedIds = new Set<string>(state?.completed ?? []);

  for (const p of prompts) {
    if (p.tier === undefined) continue;
    const bucket = out[p.tier];
    if (!bucket) continue;
    bucket.total += 1;

    // Prompt ids carry the phase prefix (e.g. `phase-99b-.../T0-02-...`) while
    // rig run ids are short (`T0-02-...`). Try both forms so the JOIN lands
    // regardless of which side names them.
    const shortId = p.id.includes("/") ? (p.id.split("/").pop() ?? p.id) : p.id;
    const run = runs[p.id] ?? runs[shortId];
    const runDone =
      (run !== undefined && COMPLETED_STATUSES.has(run.status)) ||
      completedIds.has(p.id) ||
      completedIds.has(shortId);
    if (runDone) {
      bucket.done += 1;
      continue;
    }

    if (run !== undefined && !run.needs_review && RUNNING_STATUSES.has(run.status)) {
      bucket.running += 1;
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Convenience helpers for the v4 header strip
// ---------------------------------------------------------------------------

export interface BucketCounts {
  running: number;
  queued: number;
  review: number;
  escalated: number;
  completed: number;
  failed: number;
}

/**
 * Scalar counts — what the top-strip `N running · N queued · …` pills bind to.
 * Always derived from `bucketize()` so the pills can't disagree with the body.
 */
export function bucketCounts(state: RigState | null | undefined): BucketCounts {
  const b = bucketize(state);
  return {
    running: b.running.length,
    queued: b.queued.length,
    review: b.review.length,
    escalated: b.escalated.length,
    completed: b.completed.length,
    failed: b.failed.length,
  };
}

/**
 * Global progress summary — "4/42" in the tier strip's right margin.
 */
export interface ProgressTotal {
  done: number;
  total: number;
}

export function progressTotal(
  state: RigState | null | undefined,
  prompts: readonly Prompt[] | null | undefined,
): ProgressTotal {
  const counts = tierCountsV4(state, prompts);
  let done = 0;
  let total = 0;
  for (const c of counts) {
    done += c.done;
    total += c.total;
  }
  return { done, total };
}

// ---------------------------------------------------------------------------
// Type re-exports so consumers can import everything from one module
// ---------------------------------------------------------------------------

export type { Prompt, RigState, RunRecord, RunStatus, Tier };
