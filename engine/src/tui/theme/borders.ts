/**
 * Border tokens for the Ink TUI.
 *
 * Ink supports borderStyle: "round"|"single"|"double"|"bold"|
 * "singleDouble"|"doubleSingle"|"classic"|"arrow".
 *
 * We expose three variants:
 * - round: Unicode rounded corners (default for modern terminals)
 * - single: Unicode single-line box drawing
 * - ascii: ASCII-only classic style (for dumb terminals)
 */

import { brand } from "./brand.js";

export type BorderVariant = "round" | "single" | "ascii";

/**
 * Ink `borderStyle` prop accepts one of these string literals. Mirroring the
 * subset here so theme tokens flow through `<Box borderStyle={borders.x.style}>`
 * without a cast.
 */
export type BorderStyleName = "round" | "single" | "double" | "bold" | "classic" | "arrow";

export interface BorderStyle {
  /** Ink borderStyle prop value. */
  readonly style: BorderStyleName;
  /** Border color (hex). */
  readonly color: string;
}

export const borders: Record<BorderVariant, BorderStyle> = {
  round: { style: "round", color: brand.tidewaterDim },
  single: { style: "single", color: brand.tidewaterDim },
  ascii: { style: "classic", color: brand.tidewaterDim },
};

/**
 * Pick the best border variant for the current terminal.
 *
 * Returns "ascii" if:
 * - TERM is "dumb" or "linux" (no Unicode support)
 * - LANG doesn't include UTF-8
 *
 * Otherwise returns "round" for modern terminals.
 */
export function pickBorderForTerm(term?: string, lang?: string): BorderVariant {
  const termEnv = term ?? process.env.TERM ?? "";
  const langEnv = lang ?? process.env.LANG ?? "";

  // Dumb terminals or Linux console don't support Unicode box drawing
  if (termEnv === "dumb" || termEnv === "linux") {
    return "ascii";
  }

  // Check if LANG indicates UTF-8 support
  const hasUtf8 = langEnv.toLowerCase().includes("utf-8") || langEnv.toLowerCase().includes("utf8");

  if (langEnv.length > 0 && !hasUtf8) {
    return "ascii";
  }

  return "round";
}
