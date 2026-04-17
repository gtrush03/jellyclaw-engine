import type { Tier } from '@/types';
import { cn } from '@/lib/cn';

export interface TierCounts {
  done: number;
  total: number;
}

interface TierStripProps {
  /** Keyed by tier (0–4); missing tiers render as empty cells. */
  counts: Partial<Record<Tier, TierCounts>>;
  className?: string;
  /** `sm` is used in the sidebar, `md` in the header. */
  size?: 'sm' | 'md';
}

const TIERS: Tier[] = [0, 1, 2, 3, 4];

/**
 * 5-cell horizontal strip T0…T4 showing completion counts. Filled cells use
 * the tier intensity ramp from `autobuild.css`; empty cells remain outlined.
 */
export function TierStrip({ counts, className, size = 'sm' }: TierStripProps) {
  return (
    <div
      role="list"
      aria-label="Tier completion"
      className={cn(
        'inline-flex items-stretch gap-1 font-mono tabular-nums',
        size === 'sm' ? 'text-[10px]' : 'text-[11px]',
        className,
      )}
    >
      {TIERS.map((t) => {
        const c = counts[t];
        const total = c?.total ?? 0;
        const done = c?.done ?? 0;
        const filled = total > 0 && done === total;
        const started = total > 0 && done > 0 && done < total;
        return (
          <div
            key={t}
            role="listitem"
            aria-label={`Tier ${t}: ${done} of ${total} complete`}
            className={cn(
              'flex items-center gap-1 rounded-[3px] border px-1.5',
              size === 'sm' ? 'h-5' : 'h-6',
              filled
                ? 'border-transparent text-[color:var(--color-bg)]'
                : started
                  ? 'border-[color:var(--color-gold)]/60 text-[color:var(--color-gold-bright)]'
                  : 'border-[color:var(--color-gold-subtle)] text-[color:var(--color-text-muted)]',
            )}
            style={
              filled
                ? {
                    background: `var(--color-tier-${t})`,
                  }
                : undefined
            }
          >
            <span className="font-semibold tracking-wider">T{t}</span>
            <span className="opacity-80">
              {done}/{total}
            </span>
          </div>
        );
      })}
    </div>
  );
}
