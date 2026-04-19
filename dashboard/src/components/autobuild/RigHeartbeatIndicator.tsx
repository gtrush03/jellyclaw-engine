import { useEffect, useState } from "react";
import { useRuns } from "@/hooks/useRuns";
import { cn } from "@/lib/cn";

const STALE_THRESHOLD_SEC = 45; // amber once the heartbeat is older than this
const DOWN_THRESHOLD_SEC = 180; // red once it's older than this

/**
 * Pill rendered next to the existing LiveIndicator in the header. The rig's
 * last heartbeat comes from `GET /api/runs` → `rig_heartbeat` (ISO timestamp).
 *   - null  or age >= 180s → red "rig down Xmin"
 *   - age >= 45s           → amber "rig stale Ns"
 *   - age <  45s           → green "rig online"
 */
export function RigHeartbeatIndicator({ className }: { className?: string }) {
  const { data: rig } = useRuns();
  // Re-render once a second so the "stale Ns" label stays fresh without
  // waiting for the next SSE invalidation.
  const [, tick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, []);

  const hb = rig?.rig_heartbeat ?? null;
  const now = Date.now();
  const ageSec = hb ? Math.max(0, Math.round((now - Date.parse(hb)) / 1000)) : null;

  let state: "online" | "stale" | "down" = "down";
  let label = "rig down";
  let title = "No heartbeat from the autobuild rig yet";

  if (hb !== null && ageSec !== null && Number.isFinite(ageSec)) {
    if (ageSec < STALE_THRESHOLD_SEC) {
      state = "online";
      label = "rig online";
      title = `Heartbeat ${ageSec}s ago`;
    } else if (ageSec < DOWN_THRESHOLD_SEC) {
      state = "stale";
      label = `rig stale ${ageSec}s`;
      title = `Heartbeat ${ageSec}s ago — expected <${STALE_THRESHOLD_SEC}s`;
    } else {
      state = "down";
      const mins = Math.round(ageSec / 60);
      label = `rig down ${mins}min`;
      title = `Last heartbeat ${mins} minute${mins === 1 ? "" : "s"} ago`;
    }
  }

  const toneClass =
    state === "online"
      ? "text-[color:var(--color-success)] border-[color:var(--color-success)]/40 bg-[color:var(--color-success)]/10"
      : state === "stale"
        ? "text-[color:var(--color-warning)] border-[color:var(--color-warning)]/40 bg-[color:var(--color-warning)]/10"
        : "text-[color:var(--color-danger)] border-[color:var(--color-danger)]/40 bg-[color:var(--color-danger)]/10";

  const dotClass =
    state === "online"
      ? "bg-[color:var(--color-success)]"
      : state === "stale"
        ? "bg-[color:var(--color-warning)]"
        : "bg-[color:var(--color-danger)]";

  return (
    <span
      role="status"
      title={title}
      aria-label={title}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-mono uppercase tracking-[0.2em]",
        toneClass,
        className,
      )}
    >
      <span aria-hidden className={cn("h-1.5 w-1.5 rounded-full", dotClass)} />
      <span>{label}</span>
    </span>
  );
}
