import { cn } from '@/lib/cn';

export interface TierTrackProps {
  /**
   * One entry per tier (typically T0..T4). `done`/`total` counts computed
   * upstream by `tierCountsV4()` (agent 5) from the JOIN of
   * `rig.completed` against the prompt list.
   */
  tierCounts: Array<{ tier: number; done: number; total: number }>;
  totalDone: number;
  totalAll: number;
}

/**
 * Five-segment horizontal tier-progress strip. Each segment fills
 * proportionally from left → right based on `done / total`. Right of the
 * segments: a monospace `totalDone/totalAll` overall counter.
 *
 * Segments with `total === 0` render hairline-dashed (no prompts in tier).
 * Fully-complete segments use the bright-gold accent.
 */
export function TierTrack({ tierCounts, totalDone, totalAll }: TierTrackProps) {
  return (
    <div
      className="flex items-center gap-3 py-2 px-5"
      role="progressbar"
      aria-label="Tier progress"
      aria-valuemin={0}
      aria-valuemax={totalAll}
      aria-valuenow={totalDone}
    >
      <div className="flex items-stretch gap-2 flex-1 min-w-0">
        {tierCounts.map((b) => (
          <TierSegment key={b.tier} tier={b.tier} done={b.done} total={b.total} />
        ))}
      </div>
      <span className="shrink-0 font-mono text-[12px] tabular-nums text-[color:var(--color-gold-bright)]">
        {totalDone}/{totalAll}
      </span>
    </div>
  );
}

function TierSegment({
  tier,
  done,
  total,
}: {
  tier: number;
  done: number;
  total: number;
}) {
  const empty = total === 0;
  const filled = total > 0 && done === total;
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  const tooltip = empty
    ? `T${tier} · no prompts`
    : `T${tier} · ${done}/${total} (${pct}%)`;

  return (
    <div
      className="flex-1 min-w-[56px] flex flex-col gap-1"
      title={tooltip}
      role="progressbar"
      aria-label={`Tier ${tier}: ${done} of ${total} complete`}
      aria-valuemin={0}
      aria-valuemax={total || 100}
      aria-valuenow={done}
    >
      <div className="flex items-center justify-between font-mono text-[10px] tabular-nums">
        <span
          className={cn(
            'uppercase tracking-wider',
            filled
              ? 'text-[color:var(--color-gold-bright)]'
              : 'text-[color:var(--color-text-muted)]',
          )}
        >
          T{tier}
        </span>
        <span
          className={cn(
            filled
              ? 'text-[color:var(--color-gold-bright)]'
              : 'text-[color:var(--color-text-muted)]',
          )}
        >
          {done}/{total}
        </span>
      </div>
      <div
        className={cn(
          'relative rounded-full overflow-hidden h-[5px]',
          empty
            ? 'bg-transparent border border-dashed border-[color:var(--color-gold-subtle)]'
            : 'bg-[color:var(--color-gold-faint)]',
        )}
      >
        <div
          className={cn(
            'absolute inset-y-0 left-0 transition-[width] duration-500 ease-out motion-reduce:transition-none',
            filled
              ? 'bg-[color:var(--color-gold-bright)]'
              : 'bg-[color:var(--color-gold)]',
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
