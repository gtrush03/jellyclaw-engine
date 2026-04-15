import { useCallback, useEffect, useRef, useState } from "react";

export interface ShortcutRow {
  keys: readonly string[];
  description: string;
}

const DEFAULT_SHORTCUTS: ReadonlyArray<ShortcutRow> = [
  { keys: ["⌘", "C"], description: "Copy current prompt" },
  { keys: ["j"], description: "Next prompt" },
  { keys: ["k"], description: "Previous prompt" },
  { keys: ["⌘", "K"], description: "Focus search" },
  { keys: ["Esc"], description: "Close panel" },
  { keys: ["?"], description: "Toggle this help" },
  { keys: ["⌘", "Enter"], description: "Jump to next incomplete prompt" },
];

export interface UseKeyboardShortcutsOptions {
  onCopy?: () => void;
  onNext?: () => void;
  onPrev?: () => void;
  onFocusSearch?: () => void;
  onClose?: () => void;
  onJumpNextIncomplete?: () => void;
  onToggleHelp?: () => void;
  enabled?: boolean;
}

/**
 * useKeyboardShortcuts — registers all dashboard shortcuts globally.
 * Ignores events while user is typing in inputs/textareas/contentEditable,
 * except for ⌘-K (focus search) and Esc.
 */
export function useKeyboardShortcuts(
  opts: UseKeyboardShortcutsOptions,
): void {
  const {
    onCopy,
    onNext,
    onPrev,
    onFocusSearch,
    onClose,
    onJumpNextIncomplete,
    onToggleHelp,
    enabled = true,
  } = opts;

  useEffect(() => {
    if (!enabled) return;

    const isTyping = (target: EventTarget | null): boolean => {
      if (!(target instanceof HTMLElement)) return false;
      const tag = target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
      if (target.isContentEditable) return true;
      return false;
    };

    const handler = (e: KeyboardEvent): void => {
      const meta = e.metaKey || e.ctrlKey;
      const typing = isTyping(e.target);

      // Always-available shortcuts
      if (meta && e.key.toLowerCase() === "k") {
        e.preventDefault();
        onFocusSearch?.();
        return;
      }
      if (e.key === "Escape") {
        onClose?.();
        return;
      }

      if (typing) return;

      if (meta && e.key === "Enter") {
        e.preventDefault();
        onJumpNextIncomplete?.();
        return;
      }
      if (meta && e.key.toLowerCase() === "c") {
        // Only intercept ⌘-C when nothing is selected (let native copy win otherwise)
        const sel = window.getSelection?.()?.toString() ?? "";
        if (sel.length === 0) {
          e.preventDefault();
          onCopy?.();
        }
        return;
      }
      if (e.key === "j") {
        e.preventDefault();
        onNext?.();
        return;
      }
      if (e.key === "k") {
        e.preventDefault();
        onPrev?.();
        return;
      }
      if (e.key === "?" || (e.shiftKey && e.key === "/")) {
        e.preventDefault();
        onToggleHelp?.();
        return;
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    enabled,
    onCopy,
    onNext,
    onPrev,
    onFocusSearch,
    onClose,
    onJumpNextIncomplete,
    onToggleHelp,
  ]);
}

export interface KeyboardHelpProps {
  open: boolean;
  onClose: () => void;
  shortcuts?: ReadonlyArray<ShortcutRow>;
}

/**
 * KeyboardHelp — modal overlay listing all shortcuts.
 * Tailwind classes + inline styles for palette tokens.
 */
export function KeyboardHelp({
  open,
  onClose,
  shortcuts = DEFAULT_SHORTCUTS,
}: KeyboardHelpProps): JSX.Element | null {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState<boolean>(false);

  useEffect(() => {
    if (open) setMounted(true);
  }, [open]);

  const handleBackdrop = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose],
  );

  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => {
      prev?.focus?.();
    };
  }, [open]);

  if (!open && !mounted) return null;

  return (
    <div
      className="fixed inset-0 z-[1000] flex items-center justify-center"
      style={{
        background: open ? "rgba(5, 5, 5, 0.7)" : "rgba(5, 5, 5, 0)",
        backdropFilter: open ? "blur(8px)" : "blur(0px)",
        transition: "background 200ms ease, backdrop-filter 200ms ease",
        pointerEvents: open ? "auto" : "none",
      }}
      onMouseDown={handleBackdrop}
      aria-hidden={!open}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        tabIndex={-1}
        className="kbd-help-panel relative w-[min(480px,92vw)] rounded-2xl p-6 outline-none"
        style={{
          background: "rgba(10, 10, 10, 0.85)",
          border: "1px solid rgba(146, 132, 102, 0.45)",
          boxShadow:
            "0 24px 60px rgba(0,0,0,0.5), 0 0 0 1px rgba(146,132,102,0.2) inset, 0 0 40px rgba(146,132,102,0.08)",
          backdropFilter: "blur(40px)",
          opacity: open ? 1 : 0,
          transform: open ? "scale(1)" : "scale(0.96)",
          transition: "opacity 180ms ease, transform 200ms cubic-bezier(0.22, 1, 0.36, 1)",
        }}
      >
        <header className="mb-4 flex items-center justify-between">
          <h2
            className="text-[11px] uppercase tracking-[0.2em]"
            style={{ color: "#928466", fontFamily: "Inter, ui-sans-serif" }}
          >
            Keyboard Shortcuts
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-xs transition-colors"
            style={{
              color: "rgba(232,230,225,0.7)",
              border: "1px solid rgba(146,132,102,0.25)",
            }}
            aria-label="Close shortcuts"
          >
            Esc
          </button>
        </header>

        <table className="w-full border-collapse text-sm">
          <tbody>
            {shortcuts.map((row, i) => (
              <tr
                key={i}
                className="border-t"
                style={{ borderColor: "rgba(146,132,102,0.12)" }}
              >
                <td className="py-2.5 pr-4">
                  <span className="inline-flex gap-1">
                    {row.keys.map((k, j) => (
                      <kbd
                        key={j}
                        className="inline-flex min-w-[22px] items-center justify-center rounded-md px-1.5 py-0.5 text-[11px] font-medium"
                        style={{
                          background: "rgba(146,132,102,0.08)",
                          border: "1px solid rgba(146,132,102,0.3)",
                          color: "#d4bf8f",
                          fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                        }}
                      >
                        {k}
                      </kbd>
                    ))}
                  </span>
                </td>
                <td
                  className="py-2.5 text-left"
                  style={{ color: "rgba(232,230,225,0.85)" }}
                >
                  {row.description}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <footer
          className="mt-4 text-[10px]"
          style={{ color: "rgba(232,230,225,0.45)" }}
        >
          Press <kbd>?</kbd> anywhere to toggle this panel.
        </footer>
      </div>
    </div>
  );
}

export default KeyboardHelp;
