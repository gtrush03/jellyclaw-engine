import { AlertOctagon } from "lucide-react";
import type { RunRecord } from "@/types";

export interface EscalationRowProps {
  run: RunRecord;
  /** Prompt id — the rig key this row is bound to. */
  runId: string;
  onRetry: (runId: string) => void;
  onSkip: (runId: string) => void;
  onApproveAnyway: (runId: string) => void;
}

const ERROR_TRUNC = 120;

/**
 * Red-tinted row rendered above the up-next queue when a run has
 * escalated. Surfaces the last error message and three resolve actions.
 */
export function EscalationRow({
  run,
  runId,
  onRetry,
  onSkip,
  onApproveAnyway,
}: EscalationRowProps) {
  const errText = run.last_error ?? "No error detail recorded.";
  const truncated =
    errText.length > ERROR_TRUNC ? `${errText.slice(0, ERROR_TRUNC - 1)}…` : errText;

  return (
    <div
      className="rounded-md px-4 py-3 border flex items-start gap-3"
      style={{
        borderColor: "rgba(255,87,87,0.4)",
        background: "rgba(255,87,87,0.05)",
      }}
      role="alert"
      aria-label={`Escalated run ${runId}`}
    >
      <AlertOctagon
        className="w-4 h-4 mt-0.5 shrink-0"
        style={{ color: "#ff5757" }}
        aria-hidden="true"
      />
      <div className="flex-1 min-w-0 flex flex-col gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-mono text-[12px] shrink-0" style={{ color: "#ff5757" }}>
            {runId}
          </span>
          <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-[color:var(--color-text-muted)]">
            escalated
          </span>
        </div>
        <p
          className="text-[12px] leading-relaxed break-words"
          style={{ color: "rgba(255,160,160,0.9)" }}
          title={errText}
        >
          {truncated}
        </p>
        <div className="flex items-center gap-2 flex-wrap">
          <DangerButton onClick={() => onRetry(runId)}>retry</DangerButton>
          <DangerButton onClick={() => onSkip(runId)}>skip</DangerButton>
          <DangerButton onClick={() => onApproveAnyway(runId)}>approve anyway</DangerButton>
        </div>
      </div>
    </div>
  );
}

function DangerButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-md px-2.5 py-1 border text-[11px] font-mono uppercase tracking-[0.15em] transition-colors"
      style={{
        borderColor: "rgba(255,87,87,0.4)",
        color: "rgba(255,160,160,0.95)",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.color = "#ff5757";
        e.currentTarget.style.borderColor = "#ff5757";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.color = "rgba(255,160,160,0.95)";
        e.currentTarget.style.borderColor = "rgba(255,87,87,0.4)";
      }}
    >
      {children}
    </button>
  );
}
