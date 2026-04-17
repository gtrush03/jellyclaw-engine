import { useEffect } from 'react';
import type { RigState, RunRecord } from '@/types';

interface Handlers {
  onToggleStart: () => void;
  onTogglePause: () => void;
  onTick: () => void;
  onApprove: (runId: string) => void;
  onRetry: (runId: string) => void;
  onAbort: (runId: string) => void;
  onSkip: (runId: string) => void;
  onMove: (dir: 1 | -1) => void;
  onShowHelp: () => void;
  onEscape: () => void;
}

interface Opts {
  enabled: boolean;
  rig: RigState | null | undefined;
  selectedRunId: string | null;
  handlers: Handlers;
}

/**
 * Global keyboard dispatch for the autobuild-v3 page. Owned by the page
 * itself so it only listens while the operator is on `/autobuild` — other
 * views keep their j/k/a bindings intact.
 *
 * Matrix of behaviors lives in `logic.ts` as `V3_KEY_HINTS` and stays in
 * sync with the help overlay rendered by `KeyboardHelp`.
 */
export function useAutobuildHotkeys({ enabled, rig, selectedRunId, handlers }: Opts): void {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      ) {
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const selectedRun: RunRecord | null = selectedRunId && rig?.runs
        ? rig.runs[selectedRunId] ?? null
        : null;

      switch (e.key) {
        case 's':
        case 'S':
          e.preventDefault();
          handlers.onToggleStart();
          return;
        case 'p':
        case 'P':
          e.preventDefault();
          handlers.onTogglePause();
          return;
        case 't':
        case 'T':
          e.preventDefault();
          handlers.onTick();
          return;
        case 'a':
        case 'A':
          if (selectedRun?.needs_review && selectedRunId) {
            e.preventDefault();
            handlers.onApprove(selectedRunId);
          }
          return;
        case 'r':
        case 'R':
          if (selectedRun?.status === 'escalated' && selectedRunId) {
            e.preventDefault();
            handlers.onRetry(selectedRunId);
          }
          return;
        case 'x':
        case 'X':
          if (selectedRun && selectedRunId && isAbortable(selectedRun)) {
            e.preventDefault();
            handlers.onAbort(selectedRunId);
          }
          return;
        case 'k':
          if (selectedRun && selectedRunId) {
            e.preventDefault();
            handlers.onSkip(selectedRunId);
          }
          return;
        case 'j':
          e.preventDefault();
          handlers.onMove(1);
          return;
        case 'J':
          e.preventDefault();
          handlers.onMove(-1);
          return;
        case '?':
          e.preventDefault();
          handlers.onShowHelp();
          return;
        case 'Escape':
          e.preventDefault();
          handlers.onEscape();
          return;
        default:
          return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled, rig, selectedRunId, handlers]);
}

function isAbortable(run: RunRecord): boolean {
  return (
    run.status === 'working' ||
    run.status === 'prompting' ||
    run.status === 'spawning' ||
    run.status === 'testing' ||
    run.status === 'retrying' ||
    run.status === 'completion_detected'
  );
}
