import { useMemo } from 'react';
import { useRuns } from '@/hooks/useRuns';
import { useRigProcess } from '@/hooks/useRigProcess';
import { useDashboardStore } from '@/store/dashboard';

/**
 * Elapsed seconds between an ISO timestamp and now, or null if the input
 * can't be parsed. Inlined here (was in the deleted autobuild-v3/logic.ts)
 * so this hook has no external dependency beyond the zustand store.
 */
function elapsedSinceISO(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 1000));
}

/**
 * Derive the stack of alert banners that should render above the content.
 * Priority order (highest first, per §7):
 *   halt > parse-error > backend-unreachable > stale-heartbeat >
 *   sse-dropped > budget-warning
 */
export type AlertKind =
  | 'halt'
  | 'backend-unreachable'
  | 'stale-heartbeat'
  | 'sse-dropped'
  | 'budget-warning';

export interface RigAlert {
  id: string;
  kind: AlertKind;
  title: string;
  body: string;
  dismissable: boolean;
  tone: 'danger' | 'warning' | 'muted';
}

/**
 * How old is the dispatcher's last heartbeat, in three coarse buckets that
 * drive the StatusHeader "online pill" tint color in autobuild-v4:
 *   - green : <180s — healthy. Claude tool calls (e.g. Read/Edit/Bash on a
 *             large file, or a long-running test) can block the tick loop
 *             for 2–3 min legitimately, so we refuse to warn before 180s.
 *   - amber : 180s–600s — pulse-warn. The dispatcher MIGHT be wedged on a
 *             tool call; the operator should glance at the NOW card's live
 *             log to decide.
 *   - red   : >600s — treat as dead. The pid file probably points at a
 *             ghost that exited without cleaning up, or the dispatcher is
 *             genuinely hung. A Stop / Start cycle is the right next move.
 */
export type StaleTint = 'green' | 'amber' | 'red';

export interface UseRigAlertsResult {
  alerts: RigAlert[];
  staleTint: StaleTint;
}

// 180s — claude tool calls can legitimately block 2-3min
const STALE_WARN_SEC = 180;
// 600s — well past any legitimate tool call; assume dispatcher is dead
const STALE_DEAD_SEC = 600;

export function useRigAlerts(): UseRigAlertsResult {
  const { data: rig, error: rigError } = useRuns();
  const { data: rigProcess } = useRigProcess();
  const sseConnected = useDashboardStore((s) => s.sseConnected);

  return useMemo(() => {
    const alerts: RigAlert[] = [];

    // 1. Halt (highest priority)
    if (rig?.halted) {
      alerts.push({
        id: 'halt',
        kind: 'halt',
        title: 'RIG HALTED',
        body: 'Dispatcher stopped. In-flight tmux sessions continue until claude-code exits. No new runs will spawn until you Unhalt.',
        dismissable: false,
        tone: 'danger',
      });
    }

    // 2. Backend unreachable — the /api/runs query itself failed
    if (rigError && !rig) {
      alerts.push({
        id: 'backend-unreachable',
        kind: 'backend-unreachable',
        title: 'DASHBOARD BACKEND UNREACHABLE',
        body: `Lost connection to the dashboard server. The rig may still be running. Will retry automatically. ${rigError instanceof Error ? rigError.message : ''}`,
        dismissable: false,
        tone: 'danger',
      });
    }

    // 3. Stale heartbeat — rig claims running but hasn't ticked recently.
    //    Threshold bumped from 45s to 180s because claude tool calls legitimately
    //    block for 2-3 minutes on long Bash / Read / Edit calls. Firing at 45s
    //    produced false alarms during every single live run.
    let staleTint: StaleTint = 'green';
    if (rigProcess?.running && rig?.rig_heartbeat) {
      const age = elapsedSinceISO(rig.rig_heartbeat);
      if (age !== null) {
        if (age > STALE_DEAD_SEC) {
          staleTint = 'red';
        } else if (age > STALE_WARN_SEC) {
          staleTint = 'amber';
        }
        // Only emit the banner when we're into amber/red; green is silent.
        if (age > STALE_WARN_SEC) {
          alerts.push({
            id: 'stale-heartbeat',
            kind: 'stale-heartbeat',
            title: 'STALE HEARTBEAT',
            body: `Dispatcher claims running but hasn't ticked in ${age}s. Claude tool calls can legitimately block 2-3min; if this keeps climbing the rig may be wedged.`,
            dismissable: true,
            tone: age > STALE_DEAD_SEC ? 'danger' : 'warning',
          });
        }
      }
    }

    // 4. SSE dropped — intentionally SILENT per DESIGN-SPEC.md §11.3:
    // "No banner. Just a small yellow indicator in the Mission Strip next
    // to the rig status." The polling-fallback is fully functional — shouting
    // about SSE is pure noise. The degraded indicator in the status row is
    // enough signal.
    void sseConnected;

    // 5. Budget warning (≥95% of cap)
    if (rig?.daily_budget_usd) {
      const { spent, cap } = rig.daily_budget_usd;
      if (cap > 0 && spent / cap >= 0.95 && !rig.halted) {
        alerts.push({
          id: 'budget-warning',
          kind: 'budget-warning',
          title: 'BUDGET NEAR CAP',
          body: `At ${Math.round((spent / cap) * 100)}% of daily cap ($${spent.toFixed(2)} / $${cap.toFixed(2)}). Rig will halt at 100%.`,
          dismissable: true,
          tone: 'warning',
        });
      }
    }

    return { alerts, staleTint };
  }, [rig, rigError, rigProcess, sseConnected]);
}
