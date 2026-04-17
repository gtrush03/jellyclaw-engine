import type { Tier } from '@/types';
import type { TierCounts } from './TierStrip';
import { cn } from '@/lib/cn';

interface FixPackProgressBarProps {
  counts: Partial<Record<Tier, TierCounts>>;
  className?: string;
  label?: string;
}

const TIERS: Tier[] = [0, 1, 2, 3, 4];

/**
 * Segmented 5-bucket progress bar for the Unfucking v2 tier pack.
 * Each segment fills independently by `done/total` and uses the tier
 * intensity ramp from `autobuild.css` when fully complete.
 */
export function FixPackProgressBar({ counts, className, label = 'Fix pack progress' }: FixPackProgressBarProps) {
  const totals = TIERS.map((t) => {
    const c = counts[t];
    const total = c?.total ?? 0;
    const done = c?.done ?? 0;
    const pct = total === 0 ? 0 : Math.round((done / total) * 100);
    return { tier: t, total, done, pct };
  });

  const overallTotal = totals.reduce((a, b) => a + b.total, 0);
  const overallDone = totals.reduce((a, b) => a + b.done, 0);
  const overallPct = overallTotal === 0 ? 0 : Math.round((overallDone / overallTotal) * 100);

  return (
    <div
      className={cn('w-full', className)}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={overallPct}
    >
      <div className="flex items-stretch gap-[3px] h-[4px]">
        {totals.map((t) => (
          <div
            key={t.tier}
            className="relative flex-1 rounded-full bg-[color:var(--color-gold-faint)] overflow-hidden"
            aria-label={`tier ${t.tier} ${t.done}/${t.total}`}
            title={`T${t.tier} — ${t.done}/${t.total}`}
          >
            <div
              className="absolute inset-y-0 left-0 transition-[width] duration-500 ease-out"
              style={{
                width: `${t.pct}%`,
                background: `var(--color-tier-${t.tier})`,
              }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
