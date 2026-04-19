import { cn } from "@/lib/cn";

interface RetryChipProps {
  attempt: number;
  maxRetries: number;
  reasonCode?: string | null;
  reasonDetail?: string | null;
  className?: string;
}

/**
 * Codes the backend classifies as *retryable* — amber. Anything else
 * (including unknown codes) is treated as non-retryable / terminal — red.
 */
const RETRYABLE_PREFIXES = ["stall", "timeout", "rate_limit", "network", "transient", "retry"];

function isRetryable(code: string | null | undefined): boolean {
  if (!code) return true; // default optimistic — no code yet
  const lowered = code.toLowerCase();
  return RETRYABLE_PREFIXES.some((p) => lowered.startsWith(p));
}

export function RetryChip({
  attempt,
  maxRetries,
  reasonCode,
  reasonDetail,
  className,
}: RetryChipProps) {
  const retryable = isRetryable(reasonCode ?? null);
  const reason = reasonCode ? reasonCode.replace(/_/g, " ") : null;
  const title = reasonDetail ?? (reason ? `last retry reason: ${reason}` : "retry in flight");

  const toneClass = retryable
    ? "text-[color:var(--color-warning)] border-[color:var(--color-warning)]/40 bg-[color:var(--color-warning)]/10"
    : "text-[color:var(--color-danger)] border-[color:var(--color-danger)]/40 bg-[color:var(--color-danger)]/10";

  return (
    <span
      title={title}
      aria-label={title}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-mono tabular-nums",
        toneClass,
        className,
      )}
    >
      <span className="uppercase tracking-wider">retry</span>
      <span>
        {attempt}/{maxRetries}
      </span>
      {reason && (
        <>
          <span aria-hidden className="opacity-60">
            ·
          </span>
          <span className="truncate max-w-[80px]">{reason}</span>
        </>
      )}
    </span>
  );
}
