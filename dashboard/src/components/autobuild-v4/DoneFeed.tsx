import { useMemo, useState } from 'react';
import { Check } from 'lucide-react';
import type { RunRecord } from '@/types';
import { ApprovalRow } from './ApprovalRow';
import { DoneRow } from './DoneRow';

export interface DoneFeedRow {
  runId: string;
  run: RunRecord;
}

export interface DoneFeedProps {
  completed: DoneFeedRow[];
  awaitingReview: DoneFeedRow[];
  allComplete: boolean;
  onApprove: (runId: string) => void;
  onReject: (runId: string) => void;
}

/**
 * Reverse-chronological feed of completed runs. When `allComplete` is true
 * we render a small gold victory pill at the top. Awaiting-review rows
 * render above the completed list in gold. Each completed row is
 * expandable — we track expansion locally so multiple rows can be open.
 */
export function DoneFeed({
  completed,
  awaitingReview,
  allComplete,
  onApprove,
  onReject,
}: DoneFeedProps) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const toggle = (runId: string) =>
    setExpanded((prev) => ({ ...prev, [runId]: !prev[runId] }));

  // Newest first — sort by ended_at desc, fall back to updated_at.
  const orderedCompleted = useMemo(() => {
    const copy = completed.slice();
    copy.sort((a, b) => sortKey(b.run) - sortKey(a.run));
    return copy;
  }, [completed]);

  if (
    completed.length === 0 &&
    awaitingReview.length === 0 &&
    !allComplete
  ) {
    return (
      <section aria-label="Done">
        <h2 className="font-mono text-[11px] uppercase tracking-[0.3em] text-[color:var(--color-gold-bright)] mb-2 px-5">
          Done
        </h2>
        <div className="glass rounded-lg px-5 py-4 text-[12px] text-[color:var(--color-text-muted)] italic">
          No runs yet.
        </div>
      </section>
    );
  }

  return (
    <section aria-label="Done">
      <div className="flex items-baseline justify-between mb-2 px-5">
        <h2 className="font-mono text-[11px] uppercase tracking-[0.3em] text-[color:var(--color-gold-bright)]">
          Done
        </h2>
        <span className="font-mono text-[11px] tabular-nums text-[color:var(--color-text-muted)]">
          ({completed.length})
        </span>
      </div>

      <div className="flex flex-col gap-2">
        {allComplete ? (
          <div
            className="self-start ml-5 rounded-full px-3 py-1 flex items-center gap-2 bg-[color:var(--color-gold-faint)] border border-[color:var(--color-gold)]/40"
            role="status"
          >
            <Check
              className="w-3.5 h-3.5 text-[color:var(--color-gold-bright)]"
              aria-hidden="true"
            />
            <span className="font-mono text-[11px] uppercase tracking-[0.15em] text-[color:var(--color-gold-bright)]">
              All 42 prompts complete.
            </span>
          </div>
        ) : null}

        {awaitingReview.map((r) => (
          <ApprovalRow
            key={`apr-${r.runId}`}
            run={r.run}
            runId={r.runId}
            onApprove={onApprove}
            onReject={onReject}
          />
        ))}

        {orderedCompleted.map((r) => (
          <DoneRow
            key={r.runId}
            run={r.run}
            runId={r.runId}
            expanded={!!expanded[r.runId]}
            onToggle={toggle}
          />
        ))}
      </div>
    </section>
  );
}

function sortKey(run: RunRecord): number {
  const ended = run.ended_at ? Date.parse(run.ended_at) : NaN;
  if (Number.isFinite(ended)) return ended;
  const updated = Date.parse(run.updated_at);
  return Number.isFinite(updated) ? updated : 0;
}
