import { useEffect } from "react";
import { X } from "lucide-react";
import { useRunLog } from "@/hooks/useRunLog";
import { CopyButton } from "@/components/CopyButton";
import { cn } from "@/lib/cn";

interface SessionPreviewProps {
  runId: string;
  /** tmux session name — shown as an attach hint in the full modal. */
  tmuxSession?: string | null;
  /** Compact mode renders the last 3 lines inline; full mode opens a modal. */
  compact?: boolean;
  /** For modal mode only. Called when the user closes the modal. */
  onClose?: () => void;
}

const COMPACT_LINES = 3;

/**
 * Live session log preview backed by `useRunLog` (SSE).
 *   - compact: monospace block, last ~3 lines, fade-masked, 300px max.
 *   - full:    modal with the full 500-line buffer, copy + tmux attach hint.
 */
export function SessionPreview({
  runId,
  tmuxSession,
  compact = false,
  onClose,
}: SessionPreviewProps) {
  const { lines, connected } = useRunLog(runId, true);

  // Esc closes the modal.
  useEffect(() => {
    if (compact || !onClose) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [compact, onClose]);

  if (compact) {
    const tail = lines.slice(-COMPACT_LINES);
    return (
      <div
        className="autobuild-log-fade glass rounded-md border hairline px-3 py-2 font-mono text-[11px] leading-[1.5] text-[color:var(--color-text-muted)] overflow-hidden"
        style={{ maxHeight: "72px" }}
        aria-live="polite"
      >
        {tail.length === 0 ? (
          <span className="opacity-60">{connected ? "waiting for output…" : "connecting…"}</span>
        ) : (
          tail.map((ln, i) => (
            <div key={i} className="truncate">
              {ln}
            </div>
          ))
        )}
      </div>
    );
  }

  // Full modal
  const attachCmd = tmuxSession ? `tmux attach -t ${tmuxSession}` : null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Full session log for ${runId}`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-6"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose?.();
      }}
    >
      <div className="glass-solid rounded-xl border hairline shadow-2xl w-full max-w-4xl max-h-[80vh] flex flex-col overflow-hidden">
        <header className="flex items-center justify-between px-4 py-3 border-b hairline">
          <div className="flex items-center gap-3">
            <h3 className="font-mono text-xs tracking-wider text-[color:var(--color-gold-bright)] uppercase">
              session log
            </h3>
            <span className="font-mono text-[11px] text-[color:var(--color-text-muted)]">
              {runId}
            </span>
            <span
              className={cn(
                "inline-block h-1.5 w-1.5 rounded-full",
                connected
                  ? "bg-[color:var(--color-success)]"
                  : "bg-[color:var(--color-text-muted)]",
              )}
              aria-label={connected ? "connected" : "disconnected"}
            />
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="p-1 text-[color:var(--color-text-muted)] hover:text-[color:var(--color-gold-bright)]"
          >
            <X className="w-4 h-4" />
          </button>
        </header>
        <pre
          className="flex-1 overflow-auto px-4 py-3 font-mono text-[12px] leading-[1.55] text-[color:var(--color-text)] whitespace-pre-wrap"
          aria-live="polite"
        >
          {lines.length === 0 ? (
            <span className="text-[color:var(--color-text-muted)]">
              {connected ? "waiting for output…" : "connecting…"}
            </span>
          ) : (
            lines.join("\n")
          )}
        </pre>
        <footer className="flex items-center justify-between gap-3 px-4 py-3 border-t hairline">
          {attachCmd ? (
            <code className="font-mono text-[11px] text-[color:var(--color-gold-bright)] bg-[color:var(--color-gold-faint)] border border-[color:var(--color-gold-subtle)] rounded px-2 py-1">
              {attachCmd}
            </code>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2">
            {attachCmd && <CopyButton text={attachCmd} label="attach cmd" size="sm" />}
            <CopyButton text={lines.join("\n")} label="copy log" size="sm" />
          </div>
        </footer>
      </div>
    </div>
  );
}
