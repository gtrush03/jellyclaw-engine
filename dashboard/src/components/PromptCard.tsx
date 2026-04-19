import { Check, CircleDashed, Loader2, Terminal } from "lucide-react";
import type { Prompt } from "@/types";
import { cn } from "@/lib/cn";
import { StatusBadge } from "./StatusBadge";
import { useEnrichedPrompt } from "@/hooks/useEnrichedPrompt";
import { useRigAction } from "@/hooks/useRigAction";
import { RetryChip } from "./autobuild/RetryChip";
import { TestResultBadge } from "./autobuild/TestResultBadge";
import { SelfCheckBadge } from "./autobuild/SelfCheckBadge";
import { SessionPreview } from "./autobuild/SessionPreview";
import { ApprovalGate } from "./autobuild/ApprovalGate";
import { CommitShaLink } from "./autobuild/CommitShaLink";

interface PromptCardProps {
  prompt: Prompt;
  active: boolean;
  onClick: () => void;
}

/**
 * PromptCard — now state-aware. The card merges the prompt's static
 * frontmatter (from `GET /api/prompts`) with the live run record (from
 * `GET /api/runs`) via `useEnrichedPrompt` and renders one of six visual
 * states:
 *   PENDING | RUNNING | FINALIZING | DONE | FAILED | ESCALATED | REVIEW.
 *
 * PENDING is the default and looks identical to the pre-autobuild card.
 * Every other state layers additional chrome (rings, gutters, action rows)
 * without changing the underlying shape — the click behaviour still opens
 * the prompt viewer.
 */
export function PromptCard({ prompt, active, onClick }: PromptCardProps) {
  const enriched = useEnrichedPrompt(prompt.id);
  const state = enriched?.state ?? "PENDING";
  const run = enriched?.run ?? null;
  const action = useRigAction();

  const isRunning = state === "RUNNING" || state === "FINALIZING";
  const isFailed = state === "FAILED";
  const isEscalated = state === "ESCALATED";
  const isReview = state === "REVIEW";
  const isDone = state === "DONE";

  const statusIcon =
    state === "DONE" ? (
      <Check className="w-3.5 h-3.5 text-[color:var(--color-success)]" />
    ) : isRunning ? (
      <Loader2 className="w-3.5 h-3.5 animate-spin text-[color:var(--color-warning)]" />
    ) : (
      <CircleDashed className="w-3.5 h-3.5 text-[color:var(--color-text-muted)]" />
    );

  const statePill = (() => {
    if (isDone) return <StatusBadge tone="success">DONE</StatusBadge>;
    if (isReview) return <StatusBadge tone="gold">REVIEW</StatusBadge>;
    if (isEscalated) return <StatusBadge tone="danger">ESCALATED</StatusBadge>;
    if (isFailed) return <StatusBadge tone="danger">FAILED</StatusBadge>;
    if (state === "RUNNING") return <StatusBadge tone="gold">RUNNING</StatusBadge>;
    if (state === "FINALIZING") return <StatusBadge tone="gold">FINALIZING</StatusBadge>;
    return null;
  })();

  const showDoneMeta = isDone && (run?.commit_sha || (run?.tests?.total ?? 0) > 0 || run?.ended_at);

  return (
    <div
      className={cn(
        "w-full rounded-lg border transition-all duration-150",
        "focus-within:outline-none focus-within:ring-2 focus-within:ring-[color:var(--color-gold)]",
        active
          ? "glass gold-glow border-[color:var(--color-gold)]/60"
          : "glass hairline hover:border-[color:var(--color-gold-subtle)]",
        isRunning && "autobuild-ring-pulse",
        (isFailed || isEscalated) && "autobuild-gutter-red border-[color:var(--color-danger)]/40",
        isReview && "autobuild-review-glow",
        isDone && "opacity-[0.55] hover:opacity-100 transition-opacity",
      )}
      aria-busy={isRunning}
    >
      <button
        type="button"
        onClick={onClick}
        aria-pressed={active}
        className="w-full text-left group p-4 rounded-lg focus:outline-none"
      >
        <div className="flex items-center gap-2 mb-2 flex-wrap">
          <StatusBadge tone="gold">
            P{String(prompt.phase).padStart(2, "0")} · {prompt.subPrompt}
          </StatusBadge>
          {prompt.tier !== undefined && (
            <span
              title={`tier ${prompt.tier}`}
              className="font-mono text-[10px] px-1.5 py-0.5 rounded border border-[color:var(--color-gold-subtle)] text-[color:var(--color-gold-bright)]"
            >
              T{prompt.tier}
            </span>
          )}
          {statePill}
          {run && run.attempt > 1 && (
            <RetryChip
              attempt={run.attempt}
              maxRetries={run.max_retries}
              reasonCode={run.last_retry_reason}
              reasonDetail={run.last_error}
            />
          )}
          {run && <TestResultBadge tests={run.tests} specs={prompt.tests} />}
          {run && <SelfCheckBadge selfCheck={run.self_check} />}
          <div className="ml-auto flex items-center gap-1.5 text-[11px] text-[color:var(--color-text-muted)] font-mono">
            {statusIcon}
            <span>{state.toLowerCase()}</span>
          </div>
        </div>
        <h3 className="text-[15px] font-medium text-[color:var(--color-text)] leading-snug mb-2 group-hover:text-[color:var(--color-gold-bright)] transition-colors">
          {prompt.title}
        </h3>

        {showDoneMeta && run && (
          <div className="flex items-center gap-3 text-[11px] text-[color:var(--color-text-muted)] font-mono flex-wrap">
            {run.commit_sha && <CommitShaLink sha={run.commit_sha} />}
            {run.ended_at && (
              <>
                <span>·</span>
                <span>{new Date(run.ended_at).toLocaleString()}</span>
              </>
            )}
            {run.started_at && run.ended_at && (
              <>
                <span>·</span>
                <span>{formatDuration(run.started_at, run.ended_at)}</span>
              </>
            )}
            {run.tests.total > 0 && (
              <>
                <span>·</span>
                <span>
                  tests {run.tests.passed}/{run.tests.total}
                </span>
              </>
            )}
          </div>
        )}

        {!isDone && (
          <div className="flex items-center gap-3 text-[11px] text-[color:var(--color-text-muted)] font-mono">
            <span className="inline-flex items-center gap-1">
              <Terminal className="w-3 h-3" />
              {prompt.model || "unknown model"}
            </span>
            {prompt.duration && (
              <>
                <span>·</span>
                <span>{prompt.duration}</span>
              </>
            )}
            {prompt.newSession && (
              <>
                <span>·</span>
                <span className="text-[color:var(--color-gold)]">new session</span>
              </>
            )}
          </div>
        )}
      </button>

      {isRunning && run && (
        <div className="px-4 pb-4 space-y-2">
          <SessionPreview runId={prompt.id} tmuxSession={run.tmux_session} compact />
          {run.tmux_session && (
            <code className="block font-mono text-[10px] text-[color:var(--color-gold-bright)] bg-[color:var(--color-gold-faint)] border border-[color:var(--color-gold-subtle)] rounded px-2 py-1 truncate">
              tmux attach -t {run.tmux_session}
            </code>
          )}
        </div>
      )}

      {isFailed && run && (
        <div className="px-4 pb-4 flex items-center gap-2">
          <button
            type="button"
            disabled={action.isPending}
            onClick={() => action.mutate({ runId: prompt.id, action: "retry" })}
            className="rounded-md px-2.5 py-1 text-[11px] border border-[color:var(--color-warning)]/40 text-[color:var(--color-warning)] hover:bg-[color:var(--color-warning)]/10 disabled:opacity-50"
          >
            Retry
          </button>
          <button
            type="button"
            disabled={action.isPending}
            onClick={() => action.mutate({ runId: prompt.id, action: "skip" })}
            className="rounded-md px-2.5 py-1 text-[11px] border border-[color:var(--color-gold-subtle)] text-[color:var(--color-text-muted)] hover:text-[color:var(--color-gold-bright)] disabled:opacity-50"
          >
            Skip
          </button>
          {run.last_error && (
            <span
              className="ml-auto font-mono text-[10px] text-[color:var(--color-danger)] truncate max-w-[50%]"
              title={run.last_error}
            >
              {run.last_error}
            </span>
          )}
        </div>
      )}

      {isEscalated && run && (
        <div className="px-4 pb-4 space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              disabled={action.isPending}
              onClick={() => action.mutate({ runId: prompt.id, action: "retry" })}
              className="rounded-md px-2.5 py-1 text-[11px] border border-[color:var(--color-warning)]/40 text-[color:var(--color-warning)] hover:bg-[color:var(--color-warning)]/10 disabled:opacity-50"
            >
              Retry
            </button>
            <button
              type="button"
              disabled={action.isPending}
              onClick={() => action.mutate({ runId: prompt.id, action: "skip" })}
              className="rounded-md px-2.5 py-1 text-[11px] border border-[color:var(--color-gold-subtle)] text-[color:var(--color-text-muted)] hover:text-[color:var(--color-gold-bright)] disabled:opacity-50"
            >
              Skip
            </button>
            <button
              type="button"
              disabled={action.isPending}
              onClick={() => action.mutate({ runId: prompt.id, action: "approve-anyway" })}
              className="rounded-md px-2.5 py-1 text-[11px] border border-[color:var(--color-danger)]/40 text-[color:var(--color-danger)] hover:bg-[color:var(--color-danger)]/10 disabled:opacity-50"
            >
              Approve anyway
            </button>
          </div>
          {run.retry_history.length > 0 && (
            <details className="font-mono text-[10px] text-[color:var(--color-text-muted)]">
              <summary className="cursor-pointer hover:text-[color:var(--color-gold-bright)]">
                retry history · {run.retry_history.length}
              </summary>
              <ul className="mt-1 space-y-0.5 pl-3">
                {run.retry_history.map((h) => (
                  <li key={`${h.attempt}-${h.ts}`} className="truncate">
                    #{h.attempt} {h.reason_code}: {h.reason_detail} (${h.cost_at_retry.toFixed(2)})
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {isReview && run && (
        <div className="px-4 pb-4">
          <ApprovalGate runId={prompt.id} run={run} />
        </div>
      )}
    </div>
  );
}

function formatDuration(startIso: string, endIso: string): string {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "";
  const deltaSec = Math.max(0, Math.round((end - start) / 1000));
  if (deltaSec < 60) return `${deltaSec}s`;
  const m = Math.floor(deltaSec / 60);
  const s = deltaSec % 60;
  if (m < 60) return `${m}m${s > 0 ? ` ${s}s` : ""}`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h}h ${mm}m`;
}
