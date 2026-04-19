import { CheckCheck } from "lucide-react";
import type { RunRecord } from "@/types";

export interface ApprovalRowProps {
  run: RunRecord;
  /** Prompt id — the rig key this row is bound to. */
  runId: string;
  onApprove: (runId: string) => void;
  onReject: (runId: string) => void;
}

/**
 * Gold-tinted row rendered at the top of the DONE feed when a run is
 * awaiting human review. Two buttons: Approve (gold solid) / Reject
 * (hairline ghost).
 */
export function ApprovalRow({ run, runId, onApprove, onReject }: ApprovalRowProps) {
  const sha = run.commit_sha ? run.commit_sha.slice(0, 7) : null;
  return (
    <div
      className="rounded-md px-4 py-3 border flex items-center gap-3 bg-[color:var(--color-gold-faint)]"
      style={{ borderColor: "rgba(146,132,102,0.45)" }}
      role="region"
      aria-label={`Awaiting review ${runId}`}
    >
      <CheckCheck
        className="w-4 h-4 shrink-0 text-[color:var(--color-gold-bright)]"
        aria-hidden="true"
      />
      <div className="flex-1 min-w-0 flex items-center gap-3 flex-wrap">
        <span className="font-mono text-[12px] text-[color:var(--color-gold-bright)] shrink-0">
          {runId}
        </span>
        <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-[color:var(--color-gold)]">
          awaiting review
        </span>
        {sha ? (
          <span className="font-mono text-[11px] tabular-nums text-[color:var(--color-text-muted)]">
            {sha}
          </span>
        ) : null}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <button
          type="button"
          onClick={() => onApprove(runId)}
          className="rounded-md px-3 py-1 bg-[color:var(--color-gold)] text-[#0a0a0a] hover:bg-[color:var(--color-gold-bright)] font-mono text-[11px] font-semibold uppercase tracking-[0.15em] transition-colors"
        >
          approve
        </button>
        <button
          type="button"
          onClick={() => onReject(runId)}
          className="rounded-md px-3 py-1 border border-[color:var(--color-gold-subtle)] text-[color:var(--color-text-muted)] hover:text-[color:var(--color-gold-bright)] font-mono text-[11px] uppercase tracking-[0.15em] transition-colors"
        >
          reject
        </button>
      </div>
    </div>
  );
}
