import { useCallback, useEffect, useRef } from "react";

/**
 * Accessibility helpers for the Jellyclaw dashboard.
 *
 * - useFocusTrap:   trap focus within a container while a modal is open
 * - useAnnouncer:   imperative SR-only polite announcer
 * - SkipLink:       render helper (as a render-prop-free utility below)
 * - FOCUS_RING_CSS: raw CSS string you can inject once (see animations.ts)
 */

/** Selectors considered focusable inside a modal. */
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "button:not([disabled])",
  "iframe",
  "object",
  "embed",
  "[contenteditable]",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function getFocusable(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((el) => {
    // Filter out visually hidden / aria-hidden trees
    if (el.hasAttribute("disabled")) return false;
    if (el.getAttribute("aria-hidden") === "true") return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0;
  });
}

/**
 * useFocusTrap — traps Tab/Shift+Tab within `ref` while `active` is true.
 * Restores focus to the previously focused element on deactivation.
 */
export function useFocusTrap<T extends HTMLElement>(
  ref: React.RefObject<T>,
  active: boolean,
): void {
  const previousRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!active || !ref.current) return;
    const container = ref.current;
    previousRef.current = document.activeElement as HTMLElement | null;

    // Focus first focusable, or the container itself
    const focusables = getFocusable(container);
    (focusables[0] ?? container).focus({ preventScroll: false });

    const handler = (e: KeyboardEvent): void => {
      if (e.key !== "Tab") return;
      const items = getFocusable(container);
      if (items.length === 0) {
        e.preventDefault();
        container.focus();
        return;
      }
      // items.length === 0 is guarded above, so these are always defined.
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const activeEl = document.activeElement as HTMLElement | null;

      if (e.shiftKey) {
        if (activeEl === first || !container.contains(activeEl)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (activeEl === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    container.addEventListener("keydown", handler);
    return () => {
      container.removeEventListener("keydown", handler);
      previousRef.current?.focus?.();
    };
  }, [ref, active]);
}

// Lazy-created SR-only live region, singleton per page.
let announcerEl: HTMLDivElement | null = null;
function ensureAnnouncer(): HTMLDivElement {
  if (typeof document === "undefined") {
    throw new Error("useAnnouncer requires a DOM");
  }
  if (announcerEl && announcerEl.isConnected) return announcerEl;
  const el = document.createElement("div");
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");
  el.setAttribute("aria-atomic", "true");
  el.setAttribute("data-a11y-announcer", "");
  el.style.cssText =
    "position:absolute;left:-10000px;top:auto;width:1px;height:1px;overflow:hidden;";
  document.body.appendChild(el);
  announcerEl = el;
  return el;
}

/**
 * useAnnouncer — returns an `announce(msg)` function that posts to a
 * polite ARIA live region so screen readers announce updates without
 * stealing focus.
 */
export function useAnnouncer(): (message: string) => void {
  const announce = useCallback((message: string) => {
    if (!message || typeof document === "undefined") return;
    const el = ensureAnnouncer();
    // Toggle textContent to force re-announce of identical strings
    el.textContent = "";
    window.setTimeout(() => {
      el.textContent = message;
    }, 30);
  }, []);
  return announce;
}

/**
 * renderSkipLink — helper JSX string shape (returned, not rendered here).
 * Consumers embed <a href="#main" className={SKIP_LINK_CLASS}>Skip to content</a>
 * as the first child of <body>.
 */
export const SKIP_LINK_CLASS = "jellyclaw-skip-link";

/**
 * Raw CSS for the skip-to-content link + focus ring. Inject once, e.g. in
 * a top-level `<style>` block or `src/styles/a11y.css`.
 */
export const A11Y_CSS = `
.${SKIP_LINK_CLASS} {
  position: absolute;
  left: 12px;
  top: -40px;
  z-index: 2000;
  padding: 8px 14px;
  background: #050505;
  color: #d4bf8f;
  border: 1px solid #928466;
  border-radius: 8px;
  font-family: Inter, ui-sans-serif, system-ui, sans-serif;
  font-size: 13px;
  text-decoration: none;
  transition: top 160ms ease;
}
.${SKIP_LINK_CLASS}:focus,
.${SKIP_LINK_CLASS}:focus-visible {
  top: 12px;
  outline: 2px solid #928466;
  outline-offset: 2px;
}

:where(button, a, input, select, textarea, [role="button"], [tabindex]:not([tabindex="-1"]))
  :focus-visible {
  outline: 2px solid #928466 !important;
  outline-offset: 2px !important;
  border-radius: 6px;
}
`;
