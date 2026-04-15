import { Activity, Beaker, DollarSign, Wifi, WifiOff } from 'lucide-react';
import { useStatus } from '@/hooks/useStatus';
import { usePrompts } from '@/hooks/usePrompts';
import { useDashboardStore } from '@/store/dashboard';
import { StatusBadge } from './StatusBadge';
import { ProgressBar } from './ProgressBar';

export function Header() {
  const { data: status } = useStatus();
  const { data: prompts } = usePrompts();
  const sseConnected = useDashboardStore((s) => s.sseConnected);

  const total = prompts?.length ?? 0;
  const completed = prompts?.filter((p) => p.status === 'complete').length ?? 0;
  const currentPhase = status?.currentPhase ?? 0;
  const progress = status?.progressPercent ?? 0;
  const burnRate = status?.burnRateTotal ?? 0;
  const testsPassing = status?.testsPassing ?? 0;
  const testsFailing = status?.testsFailing ?? 0;
  const testsTotal = testsPassing + testsFailing;

  return (
    <header className="shrink-0 glass-solid border-b hairline">
      <div className="flex items-center justify-between px-5 h-14">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-[color:var(--color-gold)] gold-glow" />
            <h1 className="font-mono text-sm font-semibold tracking-wider text-[color:var(--color-gold-bright)]">
              JELLYCLAW
            </h1>
            <span className="font-mono text-[11px] text-[color:var(--color-text-muted)] tracking-wider">
              / ENGINE
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <StatusBadge tone="gold" icon={<Activity className="w-3 h-3" />}>
            Phase {String(currentPhase).padStart(2, '0')} · {completed}/{total} · {Math.round(progress)}%
          </StatusBadge>
          <StatusBadge tone="neutral" icon={<DollarSign className="w-3 h-3" />}>
            ${burnRate.toFixed(2)}
          </StatusBadge>
          <StatusBadge
            tone={testsFailing > 0 ? 'danger' : testsPassing > 0 ? 'success' : 'neutral'}
            icon={<Beaker className="w-3 h-3" />}
          >
            {testsTotal === 0
              ? '0 tests'
              : testsFailing === 0
                ? `✓${testsPassing}`
                : `✓${testsPassing} ✗${testsFailing}`}
          </StatusBadge>
          <StatusBadge
            tone={sseConnected ? 'success' : 'danger'}
            icon={
              sseConnected ? (
                <Wifi className="w-3 h-3" />
              ) : (
                <WifiOff className="w-3 h-3" />
              )
            }
          >
            {sseConnected ? 'live' : 'offline'}
          </StatusBadge>
        </div>
      </div>
      <ProgressBar value={progress} />
    </header>
  );
}
