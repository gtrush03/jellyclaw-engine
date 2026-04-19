import { useMemo } from "react";
import { usePhases } from "@/hooks/usePhases";
import { usePrompts } from "@/hooks/usePrompts";
import { useDashboardStore } from "@/store/dashboard";
import type { Tier } from "@/types";
import { Skeleton } from "./Skeleton";
import { PhaseItem } from "./PhaseItem";
import { EmptyState } from "./EmptyState";
import { Layers, Wrench } from "lucide-react";
import { TierStrip } from "./autobuild/TierStrip";
import type { TierCounts } from "./autobuild/TierStrip";
import { cn } from "@/lib/cn";

export const UNFUCKING_V2_PHASE_ID = "phase-99b-unfucking-v2";
const TIERS: Tier[] = [0, 1, 2, 3, 4];

export function PhaseSidebar() {
  const { data: phases, isLoading, error } = usePhases();
  const { data: prompts } = usePrompts();
  const togglePhaseCollapsed = useDashboardStore((s) => s.togglePhaseCollapsed);
  const collapsedPhases = useDashboardStore((s) => s.collapsedPhases);
  const selectedPromptId = useDashboardStore((s) => s.selectedPromptId);

  /**
   * Tier counts come from the prompt list rather than a dedicated endpoint —
   * we look at prompts whose id starts with `phase-99b-unfucking-v2/` and
   * bucket them by `tier`. Prompts without a tier are omitted.
   */
  const tierCounts: Partial<Record<Tier, TierCounts>> = useMemo(() => {
    const out: Partial<Record<Tier, TierCounts>> = {};
    if (!prompts) return out;
    for (const t of TIERS) out[t] = { done: 0, total: 0 };
    for (const p of prompts) {
      if (!p.id.startsWith(`${UNFUCKING_V2_PHASE_ID}/`)) continue;
      if (p.tier === undefined) continue;
      const bucket = out[p.tier];
      if (!bucket) continue;
      bucket.total += 1;
      if (p.status === "complete") bucket.done += 1;
    }
    return out;
  }, [prompts]);

  const unfuckingActive = selectedPromptId?.startsWith(`${UNFUCKING_V2_PHASE_ID}/`) ?? false;

  const scrollToPhase = (phase: number) => {
    const el = document.getElementById(`phase-section-${phase}`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const scrollToUnfuckingV2 = () => {
    const el = document.getElementById(`phase-section-${UNFUCKING_V2_PHASE_ID}`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
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

  const unfuckingTotal = TIERS.reduce<number>((a, t) => a + (tierCounts[t]?.total ?? 0), 0);

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
            key={p.phaseId}
            phase={p}
            collapsed={collapsedPhases.has(p.phase)}
            active={false}
            onToggleCollapsed={() => togglePhaseCollapsed(p.phase)}
            onClick={() => scrollToPhase(p.phase)}
          />
        ))}

        {/* Synthetic row — Unfucking v2 is not a numeric phase, so it gets its
         * own compact treatment with an inline tier strip. */}
        {unfuckingTotal > 0 && (
          <button
            type="button"
            onClick={scrollToUnfuckingV2}
            aria-label="Unfucking v2"
            className={cn(
              "w-full text-left px-3 py-2 border-l-2 transition-colors",
              "focus:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--color-gold)]",
              unfuckingActive
                ? "border-[color:var(--color-gold)] bg-[color:var(--color-gold-faint)]"
                : "border-transparent hover:bg-[color:var(--color-gold-faint)]",
            )}
          >
            <div className="flex items-center gap-2 mb-1.5">
              <Wrench className="w-3 h-3 text-[color:var(--color-gold)]" />
              <span className="font-mono text-[10px] text-[color:var(--color-text-muted)] tracking-wider">
                UNFUCKING v2
              </span>
              <span className="ml-auto font-mono text-[10px] text-[color:var(--color-gold)] tabular-nums">
                {TIERS.reduce<number>((a, t) => a + (tierCounts[t]?.done ?? 0), 0)}/{unfuckingTotal}
              </span>
            </div>
            <TierStrip counts={tierCounts} size="sm" />
          </button>
        )}
      </div>
    </div>
  );
}
