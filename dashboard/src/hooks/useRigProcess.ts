import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useRuns } from '@/hooks/useRuns';
import type { RigProcessStatus } from '@/types';

/**
 * Tracks the autobuild daemon's process supervision status. Pulls from
 * `GET /api/rig/running`. Two belts-and-braces behaviors:
 *
 *   1. `staleTime` is 5s — short, because the operator cares about this
 *      refreshing fast when they hit Start/Stop. The SSE `rig-updated`
 *      event in `useSSE` invalidates `['runs']`, which _also_ invalidates
 *      this query via the shared `rig_process` field.
 *   2. If the dedicated `/rig/running` endpoint 404s (older server), we
 *      fall back to the `rig_process` object embedded in `/api/runs`.
 */
export function useRigProcess() {
  const { data: rig } = useRuns();
  const fallback: RigProcessStatus | null = rig?.rig_process
    ? rig.rig_process
    : rig
      ? { running: false, pid: null, since: null }
      : null;

  return useQuery<RigProcessStatus>({
    queryKey: ['rig', 'running'],
    queryFn: async () => {
      try {
        return await api.rigRunning();
      } catch {
        if (fallback) return fallback;
        throw new Error('rig-process endpoint unavailable and no snapshot fallback');
      }
    },
    staleTime: 5_000,
    retry: 0,
    // Placeholder keeps the UI from flashing "offline" between reconnects.
    placeholderData: fallback ?? undefined,
  });
}
