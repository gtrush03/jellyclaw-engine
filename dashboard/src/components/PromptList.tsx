import { useMemo } from "react";
import { Inbox, AlertTriangle, Flame, Wrench, ChevronDown, ChevronRight } from "lucide-react";
import { usePrompts } from "@/hooks/usePrompts";
import { usePhases } from "@/hooks/usePhases";
import { useDashboardStore } from "@/store/dashboard";
import type { Phase, Prompt, Tier } from "@/types";
import { PromptCard } from "./PromptCard";
import { Skeleton } from "./Skeleton";
import { EmptyState } from "./EmptyState";
import { FixPackProgressBar } from "./autobuild/FixPackProgressBar";
import type { TierCounts } from "./autobuild/TierStrip";
import { UNFUCKING_V2_PHASE_ID } from "./PhaseSidebar";
import { cn } from "@/lib/cn";

const UNFUCKING_PHASE = 99;
const TIERS: Tier[] = [0, 1, 2, 3, 4];

/**
 * Prompts that belong to the Unfucking v2 phase are carried as a synthetic
 * "phase" with id `phase-99b-unfucking-v2`. They're grouped by tier instead
 * of by prompt id so the operator can watch the fix pack advance top-down.
 */
function isUnfuckingV2(id: string): boolean {
  return id.startsWith(`${UNFUCKING_V2_PHASE_ID}/`);
}

export function PromptList() {
  const { data: prompts, isLoading: promptsLoading, error: promptsError } = usePrompts();
  const { data: phases } = usePhases();

  const selectedPromptId = useDashboardStore((s) => s.selectedPromptId);
  const setSelectedPromptId = useDashboardStore((s) => s.setSelectedPromptId);
  const collapsedPhases = useDashboardStore((s) => s.collapsedPhases);
  const togglePhaseCollapsed = useDashboardStore((s) => s.togglePhaseCollapsed);

  // Partition prompts: regular (grouped by numeric phase) vs unfucking-v2 (tiered).
  const { regularPrompts, v2Prompts } = useMemo(() => {
    const regular: Prompt[] = [];
    const v2: Prompt[] = [];
    if (!prompts) return { regularPrompts: regular, v2Prompts: v2 };
    for (const p of prompts) {
      if (isUnfuckingV2(p.id)) v2.push(p);
      else regular.push(p);
    }
    return { regularPrompts: regular, v2Prompts: v2 };
  }, [prompts]);

  const grouped = useMemo(() => {
    if (regularPrompts.length === 0)
      return [] as Array<{ phase: number; meta: Phase | undefined; items: Prompt[] }>;
    const byPhase = new Map<number, Prompt[]>();
    for (const p of regularPrompts) {
      const arr = byPhase.get(p.phase) ?? [];
      arr.push(p);
      byPhase.set(p.phase, arr);
    }
    // Phase 99 (UNFUCKING) is pinned to the top regardless of numeric order.
    const keys = Array.from(byPhase.keys()).sort((a, b) => {
      if (a === UNFUCKING_PHASE) return -1;
      if (b === UNFUCKING_PHASE) return 1;
      return a - b;
    });
    return keys.map((phase) => ({
      phase,
      meta: phases?.find((x) => x.phase === phase),
      items: (byPhase.get(phase) ?? []).sort((a, b) => a.subPrompt.localeCompare(b.subPrompt)),
    }));
  }, [regularPrompts, phases]);

  const v2Grouped = useMemo(() => {
    const byTier = new Map<Tier, Prompt[]>();
    const counts: Partial<Record<Tier, TierCounts>> = {};
    for (const t of TIERS) {
      byTier.set(t, []);
      counts[t] = { done: 0, total: 0 };
    }
    for (const p of v2Prompts) {
      if (p.tier === undefined) continue;
      const arr = byTier.get(p.tier) ?? [];
      arr.push(p);
      byTier.set(p.tier, arr);
      const c = counts[p.tier];
      if (c) {
        c.total += 1;
        if (p.status === "complete") c.done += 1;
      }
    }
    for (const t of TIERS) {
      const arr = byTier.get(t);
      if (arr) arr.sort((a, b) => a.subPrompt.localeCompare(b.subPrompt));
    }
    return {
      byTier,
      counts,
      total: v2Prompts.length,
    };
  }, [v2Prompts]);

  if (promptsLoading) {
    return (
      <div className="p-6 space-y-6">
        {Array.from({ length: 3 }).map((_, gi) => (
          <div key={gi} className="space-y-3">
            <Skeleton className="h-5 w-48" />
            <div className="grid gap-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-24" />
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (promptsError) {
    return (
      <div className="p-6">
        <EmptyState
          icon={<Inbox className="w-6 h-6" />}
          title="Failed to load prompts"
          message={(promptsError as Error).message}
        />
      </div>
    );
  }

  if (!prompts || prompts.length === 0) {
    return (
      <div className="p-6">
        <EmptyState
          icon={<Inbox className="w-6 h-6" />}
          title="No prompts yet"
          message="The backend hasn't discovered any prompt files on disk."
        />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-10 max-w-5xl mx-auto">
      {/* Unfucking v2 tier-grouped section (pinned above the numeric phases). */}
      {v2Grouped.total > 0 && (
        <section
          id={`phase-section-${UNFUCKING_V2_PHASE_ID}`}
          aria-labelledby="phase-h-v2"
          className="relative rounded-2xl border border-[color:var(--color-gold)]/50 bg-[color:var(--color-gold-faint)]/40 p-5"
        >
          <header className="flex items-baseline justify-between mb-4 pb-3 border-b hairline">
            <div className="flex items-baseline gap-3">
              <Wrench className="w-5 h-5 text-[color:var(--color-gold)] self-center" />
              <span className="font-mono text-[11px] tracking-widest text-[color:var(--color-gold)]">
                UNFUCKING v2
              </span>
              <h2
                id="phase-h-v2"
                className="text-lg font-semibold text-[color:var(--color-gold-bright)] uppercase tracking-wide"
              >
                Fix Pack
              </h2>
            </div>
            <div className="font-mono text-[11px] text-[color:var(--color-text-muted)]">
              {TIERS.reduce<number>((a, t) => a + (v2Grouped.counts[t]?.done ?? 0), 0)}/
              {v2Grouped.total} complete
            </div>
          </header>
          <FixPackProgressBar counts={v2Grouped.counts} className="mb-4" />
          <div className="space-y-5">
            {TIERS.map((t) => {
              const items = v2Grouped.byTier.get(t) ?? [];
              if (items.length === 0) return null;
              const sectionKey = 1000 + t; // stable pseudo-phase id for the collapsed-set
              const collapsed = collapsedPhases.has(sectionKey);
              const done = items.filter((p) => p.status === "complete").length;
              return (
                <section key={t} aria-labelledby={`tier-h-${t}`}>
                  <button
                    type="button"
                    onClick={() => togglePhaseCollapsed(sectionKey)}
                    className="w-full flex items-baseline justify-between mb-2 pb-1 border-b hairline text-left"
                  >
                    <div className="flex items-center gap-2">
                      {collapsed ? (
                        <ChevronRight className="w-3 h-3 text-[color:var(--color-text-muted)]" />
                      ) : (
                        <ChevronDown className="w-3 h-3 text-[color:var(--color-text-muted)]" />
                      )}
                      <span
                        id={`tier-h-${t}`}
                        className="font-mono text-[11px] tracking-widest text-[color:var(--color-gold-bright)]"
                      >
                        T{t}
                      </span>
                      <span
                        aria-hidden
                        className="h-1.5 w-6 rounded-full"
                        style={{ background: `var(--color-tier-${t})` }}
                      />
                    </div>
                    <span className="font-mono text-[11px] text-[color:var(--color-text-muted)] tabular-nums">
                      {done}/{items.length}
                    </span>
                  </button>
                  {!collapsed && (
                    <div className="grid gap-3">
                      {items.map((p) => (
                        <PromptCard
                          key={p.id}
                          prompt={p}
                          active={p.id === selectedPromptId}
                          onClick={() => setSelectedPromptId(p.id)}
                        />
                      ))}
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        </section>
      )}

      {grouped.map(({ phase, meta, items }) => {
        const collapsed = collapsedPhases.has(phase);
        const isLegacyUnfucking = phase === UNFUCKING_PHASE;

        if (isLegacyUnfucking) {
          const completed = items.filter((p) => p.status === "complete").length;
          return (
            <section
              key={phase}
              id={`phase-section-${phase}`}
              aria-labelledby={`phase-h-${phase}`}
              className="relative rounded-2xl border-2 border-[color:var(--color-warning,#ff8a00)]/70 p-5 shadow-[0_0_40px_-12px_rgba(255,138,0,0.45)] bg-gradient-to-b from-[rgba(255,138,0,0.08)] to-transparent"
            >
              <div
                aria-hidden
                className="absolute -top-3 left-5 px-3 py-0.5 rounded-full bg-[color:var(--color-warning,#ff8a00)] text-black text-[10px] font-mono font-bold tracking-[0.2em] uppercase flex items-center gap-1.5 shadow-lg"
              >
                <Flame className="w-3 h-3" /> Unfucking · pinned
              </div>
              <header className="flex items-baseline justify-between mb-4 pb-3 border-b border-[color:var(--color-warning,#ff8a00)]/30">
                <div className="flex items-baseline gap-3">
                  <AlertTriangle className="w-5 h-5 text-[color:var(--color-warning,#ff8a00)] self-center" />
                  <span className="font-mono text-[11px] tracking-widest text-[color:var(--color-warning,#ff8a00)]">
                    PHASE 99
                  </span>
                  <h2
                    id={`phase-h-${phase}`}
                    className={cn(
                      "text-lg font-bold uppercase tracking-wide",
                      "text-[color:var(--color-warning,#ff8a00)]",
                    )}
                  >
                    {meta?.name ?? "Unfucking — Make the Engine Real"}
                  </h2>
                </div>
                <div className="font-mono text-[11px] text-[color:var(--color-warning,#ff8a00)]/80">
                  {completed}/{items.length} complete
                  {meta?.duration ? ` · ${meta.duration}` : ""}
                </div>
              </header>
              <p className="text-[12px] text-[color:var(--color-text-muted)] mb-4 leading-relaxed font-mono">
                Pre-written, fresh-session-ready prompts to wire the engine end-to-end so it
                actually powers Genie instead of <code>claude -p</code>. Run sequentially per the
                dependency graph in <code>prompts/phase-99/README.md</code>. Live API key
                pre-validated — paste into each new session.
              </p>
              {!collapsed && (
                <div className="grid gap-3">
                  {items.map((p) => (
                    <PromptCard
                      key={p.id}
                      prompt={p}
                      active={p.id === selectedPromptId}
                      onClick={() => setSelectedPromptId(p.id)}
                    />
                  ))}
                </div>
              )}
            </section>
          );
        }

        return (
          <section key={phase} id={`phase-section-${phase}`} aria-labelledby={`phase-h-${phase}`}>
            <header className="flex items-baseline justify-between mb-3 pb-2 border-b hairline">
              <div className="flex items-baseline gap-3">
                <span className="font-mono text-[11px] tracking-widest text-[color:var(--color-text-muted)]">
                  PHASE {String(phase).padStart(2, "0")}
                </span>
                <h2
                  id={`phase-h-${phase}`}
                  className="text-base font-semibold text-[color:var(--color-gold-bright)]"
                >
                  {meta?.name ?? `Phase ${phase}`}
                </h2>
              </div>
              <div className="font-mono text-[11px] text-[color:var(--color-text-muted)]">
                {items.filter((p) => p.status === "complete").length}/{items.length} complete
                {meta?.duration ? ` · ${meta.duration}` : ""}
              </div>
            </header>
            {!collapsed && (
              <div className="grid gap-3">
                {items.map((p) => (
                  <PromptCard
                    key={p.id}
                    prompt={p}
                    active={p.id === selectedPromptId}
                    onClick={() => setSelectedPromptId(p.id)}
                  />
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
