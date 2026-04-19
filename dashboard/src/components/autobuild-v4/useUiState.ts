/**
 * Derive the single "what UI mode are we in" signal for autobuild-v4.
 *
 * The v4 page is a single scroll with three big sections (NOW / UP NEXT / DONE),
 * but most of the time only ONE of them is visually meaningful. Rather than
 * let every subcomponent sniff `rig.runs` / `rigProcess.running` /
 * `state.completed` on its own (and disagree — the v3 bug), we expose one
 * discriminated union that the top-level `<AutobuildV4 />` switches on.
 *
 * The four UI states map directly to the spec:
 *   - 'empty'        — rig OFFLINE and no history → show <EmptyState />
 *   - 'idle'         — rig ONLINE but nothing in-flight → muted "Idle — waiting
 *                      for scheduler" card
 *   - 'running'      — rig ONLINE and exactly one run in-flight → hero <NowCard />
 *   - 'all-complete' — every prompt has landed in `state.completed` → gold
 *                      "✓ All 42 prompts complete" pill, Start button dims to
 *                      "Rig done"
 *
 * Pure, React-free, no data-fetching. Unit-tested by `useUiState.test.ts`.
 */

import type { Prompt, RigState, RunRecord } from "@/types";
import { bucketize } from "./bucketize";

export type UiState =
  | { kind: "empty" }
  | { kind: "idle"; hasHistory: boolean }
  | { kind: "running"; currentRun: RunRecordWithId }
  | { kind: "all-complete" };

/**
 * A `RunRecord` with its id attached, because callers of `useUiState` always
 * need both when rendering the NOW card. The bucketize helper emits this pair
 * natively so we just reuse its shape.
 */
export interface RunRecordWithId extends RunRecord {
  id: string;
}

/**
 * Pure derivation. Does NOT accept a `rigProcess` param on purpose — we trust
 * `state.rig_process?.running` as the source of truth (populated by the backend
 * envelope in `/api/runs`). Callers that need to react to the separate
 * `/rig/running` endpoint should patch that onto the state before calling.
 */
export function deriveUiState(
  state: RigState | null | undefined,
  prompts: Prompt[] | null | undefined,
): UiState {
  // Null / loading → treat as empty. The empty state renders a neutral "Press
  // Start" screen, which is the sanest thing to show while we're waiting for
  // the first /api/runs response.
  if (!state) return { kind: "empty" };

  const rigRunning = state.rig_process?.running ?? false;
  const buckets = bucketize(state);

  const hasAnyRunRecord = Object.keys(state.runs).length > 0;
  const hasCompleted = (state.completed?.length ?? 0) > 0;
  const hasEscalated = (state.escalated?.length ?? 0) > 0;
  const hasHistory = hasAnyRunRecord || hasCompleted || hasEscalated;

  // All-complete wins over everything else: if the rig has landed every known
  // prompt, the user should see "done" even while the daemon is technically
  // still alive (the dispatcher exits on its own a moment later).
  if (prompts && prompts.length > 0) {
    const completedSet = new Set(state.completed ?? []);
    const promptIds = prompts.map((p) => p.id);
    // Only count prompts that are *autobuild-managed* — anything with a tier.
    // Non-autobuild prompts (legacy phase work) don't belong in this gate.
    const managed = promptIds.filter((id) =>
      prompts.some((p) => p.id === id && typeof p.tier === "number"),
    );
    if (managed.length > 0 && managed.every((id) => completedSet.has(id))) {
      return { kind: "all-complete" };
    }
  }

  // Rig offline + zero history → pristine "press start" screen.
  if (!rigRunning && !hasHistory) {
    return { kind: "empty" };
  }

  // Rig online with an in-flight run → hero NOW card.
  if (rigRunning && buckets.running.length > 0) {
    // If concurrency is 1 we'll only have one; if 2 we pick the most recently
    // updated. The spec says "1 in-flight" is running-state; concurrency 2 is
    // still legitimately running — just pick the newest run to feature.
    const sorted = [...buckets.running].sort((a, b) => {
      const aT = a.run?.updated_at ?? "";
      const bT = b.run?.updated_at ?? "";
      if (aT === bT) return 0;
      return aT < bT ? 1 : -1;
    });
    const hero = sorted[0];
    if (hero?.run) {
      return {
        kind: "running",
        currentRun: { id: hero.runId, ...hero.run },
      };
    }
  }

  // Rig online + nothing in-flight → idle (waiting for scheduler).
  if (rigRunning) {
    return { kind: "idle", hasHistory };
  }

  // Rig offline but history exists → idle-with-history (the user reset or
  // stopped after a run). Render the DONE feed; no NOW card.
  return { kind: "idle", hasHistory };
}
