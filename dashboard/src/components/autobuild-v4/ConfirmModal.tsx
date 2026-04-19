import { useEffect, useRef, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/cn";

export interface ConfirmModalProps {
  open: boolean;
  title: string;
  /** User must type this exact string for Confirm to enable. */
  requiredText: string;
  onConfirm: () => void;
  onCancel: () => void;
  /** Optional body copy above the input. */
  body?: React.ReactNode;
}

/**
 * Inline overlay confirmation — NOT a React portal, just an absolute-
 * positioned panel anchored to the nearest relative parent. Operators must
 * type `requiredText` verbatim before Confirm enables.
 *
 * Esc cancels. Enter confirms (only when `requiredText` matches).
 */
export function ConfirmModal({
  open,
  title,
  requiredText,
  onConfirm,
  onCancel,
  body,
}: ConfirmModalProps) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) {
      setValue("");
      return;
    }
    const id = window.setTimeout(() => inputRef.current?.focus(), 0);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(id);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onCancel]);

  if (!open) return null;

  const canConfirm = value === requiredText;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="absolute inset-0 z-40 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 motion-reduce:backdrop-blur-none"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        className={cn(
          "glass-solid rounded-lg border shadow-2xl w-full max-w-sm p-4",
          "border-[color:var(--color-danger)]/40",
        )}
      >
        <div className="flex items-center gap-2 mb-3">
          <AlertTriangle className="w-4 h-4 text-[color:var(--color-danger)]" />
          <h3 className="font-mono text-[12px] uppercase tracking-[0.2em] text-[color:var(--color-danger)]">
            {title}
          </h3>
        </div>
        {body ? (
          <div className="text-[12px] text-[color:var(--color-text)] leading-relaxed mb-3">
            {body}
          </div>
        ) : null}
        <label className="block font-mono text-[10px] uppercase tracking-[0.2em] text-[color:var(--color-text-muted)] mb-1">
          Type <span className="text-[color:var(--color-danger)]">{requiredText}</span> to confirm
        </label>
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && canConfirm) {
              e.preventDefault();
              onConfirm();
            }
          }}
          className="w-full rounded-md bg-[color:var(--color-bg)] border border-[color:var(--color-gold-subtle)] px-3 py-1.5 font-mono text-[12px] text-[color:var(--color-text)] outline-none focus:border-[color:var(--color-gold)]"
          autoComplete="off"
          spellCheck={false}
        />
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md px-3 py-1.5 text-[12px] font-mono border border-[color:var(--color-gold-subtle)] text-[color:var(--color-text-muted)] hover:text-[color:var(--color-gold-bright)]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={!canConfirm}
            className={cn(
              "rounded-md px-3 py-1.5 text-[12px] font-mono font-semibold",
              canConfirm
                ? "bg-[color:var(--color-danger)] text-[#0a0a0a] hover:brightness-110"
                : "bg-[color:var(--color-gold-faint)] text-[color:var(--color-text-muted)] cursor-not-allowed",
            )}
          >
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}
