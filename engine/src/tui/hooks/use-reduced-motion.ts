/**
 * Phase 99-06 — `useReducedMotion` hook.
 *
 * Returns `true` when the spinner / animation layer should render its static
 * fallback. Reuses `isReducedMotion()` from `jellyfish-spinner.ts` so the
 * env-var policy stays consistent across the spinner and the wider TUI.
 *
 * Evaluated once at mount via `useState` initializer — env vars and TTY
 * status do not change mid-process, so re-evaluating per-render would be wasted
 * work.
 */

import { useState } from "react";

import { isReducedMotion } from "../jellyfish-spinner.js";

export function useReducedMotion(): boolean {
  const [reduced] = useState<boolean>(() => isReducedMotion());
  return reduced;
}
