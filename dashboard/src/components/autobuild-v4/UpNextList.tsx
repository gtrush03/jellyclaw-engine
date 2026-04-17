import { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import type { RunRecord } from '@/types';
import { EscalationRow } from './EscalationRow';

export interface QueuedRow {
  id: string;
  title: string;
  tier: number;
  estMin?: number | null;
}

export interface EscalatedRow {
  runId: string;
  run: RunRecord;
}

export interface UpNextListProps {
  queued: QueuedRow[];
  escalated: EscalatedRow[];
  onRetry: (runId: string) => void;
  onSkipEscalation: (runId: string) => void;
  onApproveAnyway: (runId: string) => void;
}

const COLLAPSED = 3;

/**
 * Tier-ordered queue preview. Renders escalated rows in red at the TOP
 * (they block progress), then the next 3 queued prompts. A "+ N more ▾"
 * expander reveals the rest.
 */
export function UpNextList({
  queued,
  escalated,
  onRetry,
  onSkipEscalation,
  onApproveAnyway,
}: UpNextListProps) {
  const [expanded, setExpanded] = useState(false);

  const total = queued.length;
  const hasMore = total > COLLAPSED;
  const visible = expanded ? queued : queued.slice(0, COLLAPSED);
  const hidden = Math.max(0, total - COLLAPSED);

  if (total === 0 && escalated.length === 0) {
    return (
      <section aria-label="Up next">
        <h2 className="font-mono text-[11px] uppercase tracking-[0.3em] text-[color:var(--color-gold-bright)] mb-2 px-5">
          Up Next
        </h2>
        <div className="glass rounded-lg px-5 py-4 text-[12px] text-[color:var(--color-text-muted)] italic">
          Queue empty.
        </div>
      </section>
    );
  }

  return (
    <section aria-label="Up next">
      <div className="flex items-baseline justify-between mb-2 px-5">
        <h2 className="font-mono text-[11px] uppercase tracking-[0.3em] text-[color:var(--color-gold-bright)]">
          Up Next
        </h2>
        <span className="font-mono text-[11px] tabular-nums text-[color:var(--color-text-muted)]">
          ({total})
        </span>
      </div>

      <div className="flex flex-col gap-2">
        {escalated.map((e) => (
          <EscalationRow
            key={`esc-${e.runId}`}
            run={e.run}
            runId={e.runId}
            onRetry={onRetry}
            onSkip={onSkipEscalation}
            onApproveAnyway={onApproveAnyway}
          />
        ))}

        {visible.map((row) => (
          <QueuedRowView key={row.id} row={row} />
        ))}

        {hasMore ? (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            className="self-start ml-5 mt-1 flex items-center gap-1 font-mono text-[11px] text-[color:var(--color-text-muted)] hover:text-[color:var(--color-gold-bright)] transition-colors"
          >
            {expanded ? (
              <>
                <ChevronUp className="w-3 h-3" /> hide
              </>
            ) : (
              <>
                + {hidden} more <ChevronDown className="w-3 h-3" />
              </>
            )}
          </button>
        ) : null}
      </div>
    </section>
  );
}

function QueuedRowView({ row }: { row: QueuedRow }) {
  return (
    <div className="flex items-center gap-3 px-5 py-2 rounded-md hover:bg-[color:var(--color-gold-faint)]/40 transition-colors">
      <span className="font-mono text-[12px] text-[color:var(--color-gold)] shrink-0 tabular-nums">
        {row.id}
      </span>
      <span className="font-sans text-[12px] text-[color:var(--color-text)] flex-1 truncate">
        {row.title}
      </span>
      {typeof row.estMin === 'number' && row.estMin > 0 ? (
        <span className="font-mono text-[11px] tabular-nums text-[color:var(--color-text-muted)] shrink-0">
          est {row.estMin} min
        </span>
      ) : null}
    </div>
  );
}
