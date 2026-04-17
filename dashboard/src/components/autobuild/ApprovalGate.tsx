import type { RunRecord } from '@/types';
import { useRigAction } from '@/hooks/useRigAction';
import { CommitShaLink } from './CommitShaLink';

interface ApprovalGateProps {
  runId: string;
  run: RunRecord;
  /** Optional pre-fetched `git diff --stat` output. Omitted for now — backend will supply later. */
  diffStat?: string | null;
}

/**
 * Inline widget shown on the prompt card when the run is in REVIEW state.
 * Two buttons:  Approve & advance  /  Reject
 * Both routed through `useRigAction`. A diff summary line is rendered when
 * the backend supplies one; otherwise we just show the commit SHA.
 */
export function ApprovalGate({ runId, run, diffStat }: ApprovalGateProps) {
  const action = useRigAction();
  const pending = action.isPending;

  return (
    <div className="mt-3 rounded-md border hairline bg-[color:var(--color-gold-faint)]/40 px-3 py-2">
      <div className="flex items-center justify-between gap-3 text-[11px] font-mono text-[color:var(--color-text-muted)]">
        <div className="flex items-center gap-2">
          <span className="uppercase tracking-wider text-[color:var(--color-gold-bright)]">
            awaiting review
          </span>
          <span aria-hidden>·</span>
          <CommitShaLink sha={run.commit_sha} />
          {run.tests.total > 0 && (
            <>
              <span aria-hidden>·</span>
              <span>
                tests {run.tests.passed}/{run.tests.total}
              </span>
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={pending}
            onClick={() => action.mutate({ runId, action: 'approve' })}
            className="rounded-md px-3 py-1.5 bg-[color:var(--color-gold)] text-[#0a0a0a] font-semibold hover:bg-[color:var(--color-gold-bright)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            Approve &amp; advance
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => action.mutate({ runId, action: 'skip' })}
            className="rounded-md px-3 py-1.5 border border-[color:var(--color-danger)]/40 text-[color:var(--color-danger)] hover:bg-[color:var(--color-danger)]/10 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            Reject
          </button>
        </div>
      </div>
      {diffStat && (
        <pre className="mt-2 font-mono text-[10px] text-[color:var(--color-text-muted)] whitespace-pre-wrap">
          {diffStat}
        </pre>
      )}
    </div>
  );
}
