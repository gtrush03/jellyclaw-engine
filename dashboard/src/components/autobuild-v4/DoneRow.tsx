import { Check, ChevronDown, ChevronRight } from 'lucide-react';
import type { RunRecord } from '@/types';
import { cn } from '@/lib/cn';
import { DoneDetail } from './DoneDetail';

export interface DoneRowProps {
  run: RunRecord;
  /** Prompt id — the rig key this row is bound to. */
  runId: string;
  expanded: boolean;
  onToggle: (runId: string) => void;
}

/**
 * One completed-run row in the DONE feed. Shows:
 *   ✓  T0-02-serve…   abc1234   10m 23s   $1.25
 * Click to toggle — expanded state reveals <DoneDetail /> inline with a
 * slide-down transition (honors `prefers-reduced-motion` via CSS).
 */
export function DoneRow({ run, runId, expanded, onToggle }: DoneRowProps) {
  const sha = run.commit_sha ? run.commit_sha.slice(0, 7) : '—';
  const elapsed =
    run.started_at && run.ended_at
      ? formatElapsed(Date.parse(run.ended_at) - Date.parse(run.started_at))
      : '—';
  const cost = typeof run.cost_usd === 'number' ? `$${run.cost_usd.toFixed(2)}` : '—';

  return (
    <div
      className={cn(
        'rounded-md border hairline overflow-hidden transition-colors',
        expanded && 'bg-[color:var(--color-gold-faint)]/30',
      )}
    >
      <button
        type="button"
        onClick={() => onToggle(runId)}
        aria-expanded={expanded}
        aria-controls={`done-detail-${runId}`}
        className="w-full flex items-center gap-3 px-5 py-2.5 text-left hover:bg-[color:var(--color-gold-faint)]/40 transition-colors"
      >
        <span
          className="shrink-0 inline-flex items-center justify-center w-4 h-4 text-[color:var(--color-gold-bright)]"
          aria-hidden="true"
        >
          {expanded ? (
            <ChevronDown className="w-3.5 h-3.5" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5" />
          )}
        </span>
        <Check className="w-3.5 h-3.5 shrink-0" style={{ color: '#5fb75f' }} aria-hidden="true" />
        <span className="font-mono text-[12px] text-[color:var(--color-gold-bright)] tabular-nums shrink-0">
          {runId}
        </span>
        <span className="font-mono text-[11px] tabular-nums text-[color:var(--color-text-muted)] shrink-0 ml-auto">
          {sha}
        </span>
        <span className="font-mono text-[11px] tabular-nums text-[color:var(--color-text-muted)] shrink-0 min-w-[4rem] text-right">
          {elapsed}
        </span>
        <span className="font-mono text-[11px] tabular-nums text-[color:var(--color-gold)] shrink-0 min-w-[4rem] text-right">
          {cost}
        </span>
      </button>

      <div
        id={`done-detail-${runId}`}
        className={cn(
          'transition-[max-height,opacity] duration-300 ease-out overflow-hidden motion-reduce:transition-opacity',
          expanded
            ? 'max-h-[1200px] opacity-100'
            : 'max-h-0 opacity-0 pointer-events-none',
        )}
      >
        {expanded ? <DoneDetail run={run} runId={runId} /> : null}
      </div>
    </div>
  );
}

function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) {
    const rs = s % 60;
    return rs === 0 ? `${m}m` : `${m}m ${rs}s`;
  }
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm === 0 ? `${h}h` : `${h}h ${rm}m`;
}
