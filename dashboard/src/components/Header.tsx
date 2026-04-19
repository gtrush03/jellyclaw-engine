import { useMemo } from "react";
import { Activity, Beaker, DollarSign, Wifi, WifiOff, Layers, Radio } from "lucide-react";
import { useStatus } from "@/hooks/useStatus";
import { usePrompts } from "@/hooks/usePrompts";
import { useRuns } from "@/hooks/useRuns";
import { useDashboardStore } from "@/store/dashboard";
import { useHashRoute } from "@/hooks/useHashRoute";
import type { Tier } from "@/types";
import { StatusBadge } from "./StatusBadge";
import { ProgressBar } from "./ProgressBar";
import { RigHeartbeatIndicator } from "./autobuild/RigHeartbeatIndicator";
import { TierStrip } from "./autobuild/TierStrip";
import type { TierCounts } from "./autobuild/TierStrip";
import { UNFUCKING_V2_PHASE_ID } from "./PhaseSidebar";
import { cn } from "@/lib/cn";

const TIERS: Tier[] = [0, 1, 2, 3, 4];

export function Header() {
  const { data: status } = useStatus();
  const { data: prompts } = usePrompts();
  const { data: rig } = useRuns();
  const sseConnected = useDashboardStore((s) => s.sseConnected);
  const { route, setRoute } = useHashRoute();
  // v4 is the canonical autobuild surface. `#/autobuild-v4`, `#/autobuild`,
  // and the empty default route all resolve here. `#/phases` (or any other
  // non-empty non-autobuild route) falls back to the phases browser.
  const onAutobuild = route === "autobuild-v4" || route === "autobuild" || route === "";
  const onPhases = !onAutobuild;

  const total = prompts?.length ?? 0;
  const completed = prompts?.filter((p) => p.status === "complete").length ?? 0;
  const currentPhase = status?.currentPhase ?? 0;
  const progress = status?.progressPercent ?? 0;
  const burnRate = status?.burnRateTotal ?? 0;
  const testsPassing = status?.testsPassing ?? 0;
  const testsFailing = status?.testsFailing ?? 0;
  const testsTotal = testsPassing + testsFailing;

  const tierCounts: Partial<Record<Tier, TierCounts>> = useMemo(() => {
    const out: Partial<Record<Tier, TierCounts>> = {};
    for (const t of TIERS) out[t] = { done: 0, total: 0 };
    if (!prompts) return out;
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

  const hasV2 = TIERS.some((t) => (tierCounts[t]?.total ?? 0) > 0);

  // Count running+queued+review for the tab pip.
  const runningCount = useMemo(() => {
    if (!rig) return 0;
    return Object.values(rig.runs).filter((r) =>
      ["working", "prompting", "spawning", "testing", "retrying", "completion_detected"].includes(
        r.status,
      ),
    ).length;
  }, [rig]);

  return (
    <header className="shrink-0 glass-solid border-b hairline">
      <div className="flex items-center justify-between px-5 h-14 gap-3 flex-wrap">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-[color:var(--color-gold)] gold-glow" />
            <h1 className="font-mono text-sm font-semibold tracking-wider text-[color:var(--color-gold-bright)]">
              JELLYCLAW
            </h1>
            <span className="font-mono text-[11px] text-[color:var(--color-text-muted)] tracking-wider">
              / ENGINE
            </span>
          </div>
          {hasV2 && onPhases && (
            <span className="hidden lg:inline-flex items-center gap-2 pl-3 border-l hairline">
              <span className="font-mono text-[10px] text-[color:var(--color-text-muted)] tracking-wider">
                v2
              </span>
              <TierStrip counts={tierCounts} size="md" />
            </span>
          )}

          {/*
           * View tabs — two tabs only: Phases (legacy day-to-day prompt
           * browser) and Autobuild (the v4 single-scroll surface).
           */}
          <div
            role="tablist"
            aria-label="Dashboard view"
            className="ml-2 inline-flex items-center rounded-md border hairline overflow-hidden"
          >
            <HeaderTab
              active={onPhases}
              onClick={() => setRoute("phases")}
              icon={<Layers className="w-3 h-3" />}
              label="Phases"
            />
            <HeaderTab
              active={onAutobuild}
              onClick={() => setRoute("autobuild-v4")}
              icon={<Radio className="w-3 h-3" />}
              label="Autobuild"
              accent={runningCount > 0}
            />
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {/*
           * On Autobuild, the v4 `StatusHeader` owns pid/uptime/budget/
           * heartbeat — anything here would duplicate it. On Phases we keep
           * the rich legacy chrome so the phase-browser stays informative.
           */}
          {onPhases && (
            <>
              <StatusBadge tone="gold" icon={<Activity className="w-3 h-3" />}>
                Phase {String(currentPhase).padStart(2, "0")} · {completed}/{total} ·{" "}
                {Math.round(progress)}%
              </StatusBadge>
              <StatusBadge tone="neutral" icon={<DollarSign className="w-3 h-3" />}>
                ${burnRate.toFixed(2)}
              </StatusBadge>
              <StatusBadge
                tone={testsFailing > 0 ? "danger" : testsPassing > 0 ? "success" : "neutral"}
                icon={<Beaker className="w-3 h-3" />}
              >
                {testsTotal === 0
                  ? "0 tests"
                  : testsFailing === 0
                    ? `✓${testsPassing}`
                    : `✓${testsPassing} ✗${testsFailing}`}
              </StatusBadge>
              <RigHeartbeatIndicator />
            </>
          )}
          <StatusBadge
            tone={sseConnected ? "success" : "danger"}
            icon={sseConnected ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
          >
            {sseConnected ? "live" : "offline"}
          </StatusBadge>
        </div>
      </div>
      {onPhases && <ProgressBar value={progress} />}
    </header>
  );
}

/**
 * Pill-shaped tab rendered inside the Phases/Autobuild toggle group. Active
 * tab fills gold; the inactive sibling is just an outline. `accent` adds a
 * tiny pulsing dot — used on the Autobuild tab when work is in flight.
 */
function HeaderTab({
  active,
  onClick,
  icon,
  label,
  accent,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  accent?: boolean;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-mono",
        "focus:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--color-gold)]",
        "transition-colors",
        active
          ? "bg-[color:var(--color-gold)] text-[#0a0a0a]"
          : "text-[color:var(--color-text-muted)] hover:text-[color:var(--color-gold-bright)]",
      )}
    >
      {icon}
      <span>{label}</span>
      {accent && !active && (
        <span
          aria-hidden
          className="h-1.5 w-1.5 rounded-full bg-[color:var(--color-gold)] pulse-glow"
        />
      )}
    </button>
  );
}
