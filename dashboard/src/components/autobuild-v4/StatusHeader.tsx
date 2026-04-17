import { useEffect, useState } from 'react';
import { Play, Square, Trash2 } from 'lucide-react';
import type { RigProcessStatus } from '@/types';
import { cn } from '@/lib/cn';
import { ConfirmModal } from './ConfirmModal';

export interface StatusHeaderProps {
  rigProcess: RigProcessStatus | null;
  paused: boolean;
  halted: boolean;
  dailyBudget: { spent: number; cap: number };
  onStart: () => void;
  onStop: () => void;
  onReset: () => void;
  /** When false, the reset trash icon is hidden (rig running OR no history). */
  canReset: boolean;
  /** Ms since heartbeat — when > 180_000, tint the pill amber. Default 0. */
  heartbeatAgeMs?: number;
  /** True if all 42 prompts complete — dims the Start button to "Rig done". */
  allComplete?: boolean;
}

const STALE_HEARTBEAT_MS = 180_000;

/**
 * Single-row strip at the top of the v4 page. Renders:
 *   AUTOBUILD · ● ONLINE · pid 12345 · 12m up · $5.07/$25 today · [Start|Stop] [Reset]
 *
 * Pill colors:
 *   green (#5fb75f) when rig online + heartbeat fresh
 *   amber (#d4a04a) when heartbeat > 180s (stale) or paused
 *   red (#ff5757)   when halted
 */
export function StatusHeader({
  rigProcess,
  paused,
  halted,
  dailyBudget,
  onStart,
  onStop,
  onReset,
  canReset,
  heartbeatAgeMs = 0,
  allComplete = false,
}: StatusHeaderProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // Tick once per second so the uptime string stays accurate.
  useEffect(() => {
    if (!rigProcess?.running) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [rigProcess?.running]);

  const running = rigProcess?.running === true;
  const stale = heartbeatAgeMs > STALE_HEARTBEAT_MS;

  const tone: 'green' | 'amber' | 'red' =
    halted ? 'red' : paused || stale ? 'amber' : running ? 'green' : 'amber';

  const toneColor =
    tone === 'green' ? '#5fb75f' : tone === 'amber' ? '#d4a04a' : '#ff5757';

  const label = halted
    ? 'HALTED'
    : paused
      ? 'PAUSED'
      : running
        ? stale
          ? 'STALE'
          : 'ONLINE'
        : 'OFFLINE';

  const uptime = running && rigProcess?.since ? formatUptime(now - Date.parse(rigProcess.since)) : null;

  const doReset = () => {
    setConfirmOpen(false);
    onReset();
  };

  return (
    <div className="relative">
      <div className="flex items-center gap-4 py-3 px-5 glass-solid rounded-lg border hairline">
        <h1 className="font-mono text-[13px] tracking-[0.3em] uppercase text-[color:var(--color-gold-bright)] shrink-0">
          Autobuild
        </h1>

        <div className="flex items-center gap-2 text-[12px] font-mono text-[color:var(--color-text-muted)] flex-1 min-w-0">
          <span
            className={cn(
              'inline-block w-2 h-2 rounded-full shrink-0',
              running && tone === 'green' && 'pulse-glow motion-reduce:animate-none',
            )}
            style={{ background: toneColor }}
            aria-hidden="true"
          />
          <span
            className="uppercase tracking-[0.2em] tabular-nums shrink-0"
            style={{ color: toneColor }}
            role="status"
            aria-label={`rig status ${label.toLowerCase()}`}
          >
            {label}
          </span>

          {running && rigProcess?.pid != null ? (
            <>
              <span className="text-[color:var(--color-text-muted)]/60 shrink-0">·</span>
              <span className="tabular-nums shrink-0">pid {rigProcess.pid}</span>
            </>
          ) : null}

          {uptime ? (
            <>
              <span className="text-[color:var(--color-text-muted)]/60 shrink-0">·</span>
              <span className="tabular-nums shrink-0">{uptime} up</span>
            </>
          ) : null}

          <span className="text-[color:var(--color-text-muted)]/60 shrink-0">·</span>
          <BudgetChip spent={dailyBudget.spent} cap={dailyBudget.cap} />
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {running ? (
            <button
              type="button"
              onClick={onStop}
              className="flex items-center gap-1.5 rounded-md px-3 py-1.5 bg-[color:var(--color-gold)] text-[#0a0a0a] hover:bg-[color:var(--color-gold-bright)] font-mono text-[11px] font-semibold uppercase tracking-[0.15em] transition-colors"
              aria-label="Stop rig"
            >
              <Square className="w-3 h-3" fill="currentColor" />
              Stop
            </button>
          ) : (
            <button
              type="button"
              onClick={onStart}
              disabled={allComplete}
              className={cn(
                'flex items-center gap-1.5 rounded-md px-3 py-1.5 font-mono text-[11px] font-semibold uppercase tracking-[0.15em] transition-colors',
                allComplete
                  ? 'bg-[color:var(--color-gold-faint)] text-[color:var(--color-text-muted)] cursor-not-allowed'
                  : 'bg-[color:var(--color-gold)] text-[#0a0a0a] hover:bg-[color:var(--color-gold-bright)] gold-glow',
              )}
              aria-label={allComplete ? 'Rig done' : 'Start rig'}
            >
              <Play className="w-3 h-3" fill="currentColor" />
              {allComplete ? 'Rig done' : 'Start'}
            </button>
          )}

          {canReset ? (
            <button
              type="button"
              onClick={() => setConfirmOpen(true)}
              className="rounded-md p-1.5 border border-[color:var(--color-gold-subtle)] text-[color:var(--color-gold)] hover:text-[color:var(--color-warning)] hover:border-[color:var(--color-warning)]/40 transition-colors"
              aria-label="Reset run history"
              title="Reset run history"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          ) : null}
        </div>
      </div>

      <ConfirmModal
        open={confirmOpen}
        title="Reset run history"
        requiredText="RESET"
        onCancel={() => setConfirmOpen(false)}
        onConfirm={doReset}
        body={
          <p>
            This wipes <code>.autobuild/state.json</code> and all session
            directories. The queue is preserved. The rig must be stopped
            first.
          </p>
        }
      />
    </div>
  );
}

function BudgetChip({ spent, cap }: { spent: number; cap: number }) {
  const pct = cap > 0 ? Math.min(1, spent / cap) : 0;
  const tone = pct >= 1 ? 'danger' : pct >= 0.8 ? 'warning' : 'muted';
  const color =
    tone === 'danger'
      ? '#ff5757'
      : tone === 'warning'
        ? '#d4a04a'
        : 'var(--color-text-muted)';
  return (
    <span
      className="tabular-nums shrink-0"
      style={{ color }}
      aria-label={`daily budget ${spent.toFixed(2)} of ${cap.toFixed(2)}`}
    >
      ${spent.toFixed(2)}/${cap.toFixed(0)} today
    </span>
  );
}

function formatUptime(ms: number): string {
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
