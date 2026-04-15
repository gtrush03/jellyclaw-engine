import { usePhases } from '@/hooks/usePhases';
import { useDashboardStore } from '@/store/dashboard';
import { Skeleton } from './Skeleton';
import { PhaseItem } from './PhaseItem';
import { EmptyState } from './EmptyState';
import { Layers } from 'lucide-react';

export function PhaseSidebar() {
  const { data: phases, isLoading, error } = usePhases();
  const togglePhaseCollapsed = useDashboardStore((s) => s.togglePhaseCollapsed);
  const collapsedPhases = useDashboardStore((s) => s.collapsedPhases);

  const scrollToPhase = (phase: number) => {
    const el = document.getElementById(`phase-section-${phase}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  if (isLoading) {
    return (
      <div className="p-3 space-y-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-14 w-full" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-3">
        <EmptyState
          icon={<Layers className="w-6 h-6" />}
          title="Failed to load phases"
          message={(error as Error).message}
        />
      </div>
    );
  }

  if (!phases || phases.length === 0) {
    return (
      <div className="p-3">
        <EmptyState
          icon={<Layers className="w-6 h-6" />}
          title="No phases yet"
          message="Backend hasn't discovered any phases."
        />
      </div>
    );
  }

  return (
    <div className="py-2">
      <div className="px-3 pb-2 pt-1">
        <div className="font-mono text-[10px] tracking-widest text-[color:var(--color-text-muted)]">
          PHASES · {phases.length}
        </div>
      </div>
      <div>
        {phases.map((p) => (
          <PhaseItem
            key={p.phase}
            phase={p}
            collapsed={collapsedPhases.has(p.phase)}
            active={false}
            onToggleCollapsed={() => togglePhaseCollapsed(p.phase)}
            onClick={() => scrollToPhase(p.phase)}
          />
        ))}
      </div>
    </div>
  );
}
