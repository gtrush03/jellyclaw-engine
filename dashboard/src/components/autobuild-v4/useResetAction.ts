import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { RigState } from '@/types';

/**
 * Fresh-start reset action for the autobuild-v4 status header.
 *
 * POSTs to `/api/rig/reset` which wipes `.autobuild/state.json` back to an
 * empty skeleton and removes every per-session dir under
 * `.autobuild/sessions/`. `.autobuild/queue.json` is preserved so the next
 * Start re-runs the same queue.
 *
 * Contract:
 *   - `canReset(state)` returns true ONLY when the rig is offline AND there
 *     is *any* history to clear (a run in `state.runs`, or anything in
 *     `completed` / `escalated`). The button should be hidden or disabled
 *     otherwise — resetting a fresh state is a no-op and would only confuse.
 *   - `reset()` throws on any non-2xx response (so the caller can surface a
 *     distinct error toast for 409 — "stop the rig first"). On success it
 *     invalidates both `['runs']` and `['rig', 'running']` so the UI refreshes
 *     immediately rather than waiting for the next SSE fan-out.
 *
 * Pairing: Agent 3 imports this from `StatusHeader.tsx` and wires the result
 * into a trash-icon button gated by a `ConfirmModal` that requires the user
 * to type the word `RESET` before the mutation fires. See the "handoff" note
 * in the dispatch notes.
 */
export interface UseResetAction {
  canReset: (state: RigState | null | undefined) => boolean;
  reset: () => Promise<void>;
}

export function useResetAction(): UseResetAction {
  const queryClient = useQueryClient();

  const canReset = (state: RigState | null | undefined): boolean => {
    if (!state) return false;
    // Rig offline: the embedded rig_process is the source of truth when
    // present; fall back to `halted` as a conservative proxy. Note we treat
    // "process.running === true" as OFF-limits — reset must never race a
    // live dispatcher.
    const running = state.rig_process?.running ?? false;
    if (running) return false;
    const hasRunHistory = Object.keys(state.runs ?? {}).length > 0;
    const hasCompleted = (state.completed ?? []).length > 0;
    const hasEscalated = (state.escalated ?? []).length > 0;
    return hasRunHistory || hasCompleted || hasEscalated;
  };

  const reset = async (): Promise<void> => {
    try {
      const result = await api.rigReset();
      toast.success('Rig reset', {
        description: `Cleared at ${new Date(result.reset_at).toLocaleTimeString()}`,
      });
      void queryClient.invalidateQueries({ queryKey: ['runs'] });
      void queryClient.invalidateQueries({ queryKey: ['rig', 'running'] });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Distinguish the 409 "rig is running" case — it's operator-actionable
      // (press Stop first), not a backend failure.
      if (msg.includes('409')) {
        toast.error('Stop the rig before resetting.', {
          description:
            'The dispatcher is still live. Press Stop, wait for it to exit, then reset.',
        });
      } else {
        toast.error('Reset failed', { description: msg });
      }
      throw err;
    }
  };

  return { canReset, reset };
}
