import { useCallback, useMemo } from "react";
import { useRuns } from "@/hooks/useRuns";
import { useRigProcess } from "@/hooks/useRigProcess";
import { useRigControl } from "@/hooks/useRigControl";
import { useRigAction } from "@/hooks/useRigAction";
import { usePrompts } from "@/hooks/usePrompts";
import type { Prompt, RunRecord } from "@/types";
import type { RigAction } from "@/hooks/useRigAction";
import { bucketize, tierCountsV4 } from "./bucketize";
import { useResetAction } from "./useResetAction";
import { StatusHeader } from "./StatusHeader";
import { TierTrack } from "./TierTrack";
import { NowCard } from "./NowCard";
import { UpNextList } from "./UpNextList";
import { DoneFeed } from "./DoneFeed";
import { EmptyState } from "./EmptyState";

/**
 * Root of the autobuild-v4 surface. Pure layout + data binding — no real
 * subcomponent logic lives here. Wires the four rig hooks, computes the
 * interim buckets (agent 5 replaces with `bucketize()` + `tierCountsV4()`),
 * and passes data into the subcomponents in one vertical scroll.
 *
 * Design spec: `./DESIGN-SPEC.md` (agent 1) — single scroll, no tabs, no
 * columns. See `/Users/gtrush/Downloads/AUTOBUILD-V4-STARTUP.md` for the
 * ASCII layout this renders.
 */
export function AutobuildV4() {
  const { data: rig } = useRuns();
  const { data: rigProcess } = useRigProcess();
  const { data: prompts } = usePrompts();
  const rigControl = useRigControl();
  const action = useRigAction();

  const onAction = useCallback(
    async (cmd: RigAction, runId: string, payload?: Record<string, unknown>) => {
      await action.mutateAsync({ runId, action: cmd, body: payload });
    },
    [action],
  );

  const buckets = useMemo(() => bucketize(rig ?? null), [rig]);
  const tierCounts = useMemo(() => tierCountsV4(rig ?? null, prompts ?? null), [rig, prompts]);

  const rigOnline = rigProcess?.running === true;
  const totalRuns = rig ? Object.keys(rig.runs).length : 0;
  const showEmpty = !rigOnline && totalRuns === 0 && !rig?.halted;

  const onStart = useCallback(() => {
    rigControl.start.mutate();
  }, [rigControl.start]);

  const onStop = useCallback(() => {
    rigControl.stop.mutate();
  }, [rigControl.stop]);

  // Agent 7's `/api/rig/reset` wiring. `canReset` is gated on rig-offline +
  // any history; `reset()` POSTs and invalidates the query cache on success.
  const resetAction = useResetAction();
  const onReset = useCallback(() => {
    void resetAction.reset();
  }, [resetAction]);
  const canReset = resetAction.canReset(rig ?? null);

  const dailyBudget = useMemo(
    () => ({
      spent: rig?.daily_budget_usd?.spent ?? 0,
      cap: rig?.daily_budget_usd?.cap ?? 0,
    }),
    [rig?.daily_budget_usd?.spent, rig?.daily_budget_usd?.cap],
  );

  // Simplified staleness — agent 7 owns the real 180s gate.
  const heartbeatAgeMs = rig?.rig_heartbeat
    ? Math.max(0, Date.now() - Date.parse(rig.rig_heartbeat))
    : 0;

  const totalDone = tierCounts.reduce((acc, t) => acc + t.done, 0);
  const totalAll = tierCounts.reduce((acc, t) => acc + t.total, 0);
  const allComplete = totalAll > 0 && totalDone === totalAll;

  const nowEntry = buckets.running[0] ?? null;
  const nowRunId = nowEntry?.runId ?? null;
  const nowRun = nowEntry?.run ?? null;

  // Build a fast lookup of prompts by id so the queued rows can be hydrated
  // with title + tier + estimated-duration without another pass. Prompts
  // carry the phase-prefix in their id (`phase-99b-.../T0-02-...`) while rig
  // run ids are short (`T0-02-...`); index by BOTH forms so short-id lookups
  // in NowCard / UpNextList / etc. always hit.
  const promptIndex = useMemo(() => {
    const m = new Map<string, Prompt>();
    if (prompts) {
      for (const p of prompts) {
        m.set(p.id, p);
        const short = p.id.includes("/") ? (p.id.split("/").pop() ?? p.id) : p.id;
        if (short !== p.id) m.set(short, p);
      }
    }
    return m;
  }, [prompts]);

  const nowPrompt = nowRunId ? (promptIndex.get(nowRunId) ?? null) : null;

  // Bind per-run actions for NowCard. The real card exposes abort/skip/tell
  // as separate handlers rather than a single `onAction(cmd)` dispatcher.
  const onAbortRun = useCallback(
    (runId: string) => {
      void onAction("abort", runId);
    },
    [onAction],
  );
  const onSkipRun = useCallback(
    (runId: string) => {
      void onAction("skip", runId);
    },
    [onAction],
  );
  const onTellRun = useCallback(
    (runId: string, message: string) => {
      void onAction("approve", runId, { message });
    },
    [onAction],
  );

  // Escalation actions for UpNextList (retry / skip / approve-anyway).
  const onRetryEsc = useCallback(
    (runId: string) => {
      void onAction("retry", runId);
    },
    [onAction],
  );
  const onSkipEsc = useCallback(
    (runId: string) => {
      void onAction("skip", runId);
    },
    [onAction],
  );
  const onApproveAnywayEsc = useCallback(
    (runId: string) => {
      void onAction("approve-anyway", runId);
    },
    [onAction],
  );

  // Project the bucketize output into the subcomponent contracts. Queued
  // rows come from `buckets.queued` — each entry's `runId` is the prompt id,
  // so we hydrate with the prompt lookup. Entries without a matching prompt
  // are rendered with a best-effort title derived from the id.
  const queuedRows = useMemo(
    () =>
      buckets.queued.map((e) => {
        const p = promptIndex.get(e.runId);
        return {
          id: e.runId,
          title: p?.title ?? e.runId,
          tier: p?.tier ?? 0,
          estMin: p?.estimated_duration_min ?? null,
        };
      }),
    [buckets.queued, promptIndex],
  );
  // Failed runs need operator attention too — surface them alongside
  // escalated in UpNextList's red section so the user can Retry / Skip /
  // Approve-Anyway. The rig will otherwise keep auto-retrying silently.
  const escalatedRows = useMemo(
    () => [...buckets.escalated, ...buckets.failed].filter(hasRun).map(toRunIdPair),
    [buckets.escalated, buckets.failed],
  );
  const completedRows = useMemo(
    () => buckets.completed.filter(hasRun).map(toRunIdPair),
    [buckets.completed],
  );
  const awaitingReviewRows = useMemo(
    () => buckets.review.filter(hasRun).map(toRunIdPair),
    [buckets.review],
  );

  // Done-feed approve/reject handlers. `reject` isn't a RigAction (the
  // backend only knows abort/approve/retry/skip/approve-anyway), so we map
  // a UI-level reject to `skip` — same "move past this run" semantics.
  const onApproveDone = useCallback(
    (runId: string) => {
      void onAction("approve", runId);
    },
    [onAction],
  );
  const onRejectDone = useCallback(
    (runId: string) => {
      void onAction("skip", runId);
    },
    [onAction],
  );

  return (
    <main className="flex-1 overflow-y-auto overflow-x-hidden" data-v4-root aria-label="Autobuild">
      <div className="mx-auto max-w-[880px] px-6 py-8 space-y-8">
        <StatusHeader
          rigProcess={rigProcess ?? null}
          paused={rig?.paused ?? false}
          halted={rig?.halted ?? false}
          dailyBudget={dailyBudget}
          onStart={onStart}
          onStop={onStop}
          onReset={onReset}
          canReset={canReset}
          heartbeatAgeMs={heartbeatAgeMs}
          allComplete={allComplete}
        />

        {showEmpty ? (
          <EmptyState onStart={onStart} />
        ) : (
          <>
            <TierTrack tierCounts={tierCounts} totalDone={totalDone} totalAll={totalAll} />

            <NowCard
              run={nowRun}
              runId={nowRunId}
              title={nowPrompt?.title ?? null}
              rigOnline={rigOnline}
              onAbort={onAbortRun}
              onSkip={onSkipRun}
              onTell={onTellRun}
            />

            <UpNextList
              queued={queuedRows}
              escalated={escalatedRows}
              onRetry={onRetryEsc}
              onSkipEscalation={onSkipEsc}
              onApproveAnyway={onApproveAnywayEsc}
            />

            <DoneFeed
              completed={completedRows}
              awaitingReview={awaitingReviewRows}
              allComplete={allComplete}
              onApprove={onApproveDone}
              onReject={onRejectDone}
            />
          </>
        )}
      </div>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Helpers for projecting `BucketEntry` arrays (which allow `run: null` for
// pre-spawn queue placeholders and authoritative completed/escalated ids) into
// the subcomponent contracts that require a non-null `RunRecord`.
// ---------------------------------------------------------------------------

type NonNullRunEntry = { runId: string; run: RunRecord };

function hasRun(e: { runId: string; run: RunRecord | null }): e is NonNullRunEntry {
  return e.run !== null;
}

function toRunIdPair(e: NonNullRunEntry): NonNullRunEntry {
  return { runId: e.runId, run: e.run };
}
