/**
 * String-level secret scrubber (Phase 08.03).
 *
 * Applies an ordered list of `SecretPattern`s to a single string and returns
 * the scrubbed text plus per-pattern hit counts. Patterns are applied in the
 * order given — callers build that order via `mergePatterns` so that narrow,
 * high-confidence patterns consume bytes before broader ones see them.
 *
 * Replacement format is exactly `[REDACTED:<name>]` — consumers grep for this
 * marker so nothing else belongs in it.
 */

import type { SecretPattern } from "./secret-patterns.js";

export interface ScrubResult {
  readonly scrubbed: string;
  readonly hits: number;
  readonly byName: Record<string, number>;
}

export interface ScrubOptions {
  /** Skip strings shorter than this. Default 8. */
  readonly minLength?: number;
  /** If true, stop after the first match total. Default false. */
  readonly fast?: boolean;
}

const DEFAULT_MIN_LENGTH = 8;

function marker(name: string): string {
  return `[REDACTED:${name}]`;
}

/**
 * Replace every pattern match in `text` with `[REDACTED:<name>]`. Patterns are
 * applied in-order; earlier narrow patterns consume bytes later broader
 * patterns would otherwise match.
 *
 * When `fast: true`, returns after the first match across all patterns.
 */
export function scrubString(
  text: string,
  patterns: readonly SecretPattern[],
  opts?: ScrubOptions,
): ScrubResult {
  const byName: Record<string, number> = {};
  if (text === "") return { scrubbed: "", hits: 0, byName };

  const minLength = opts?.minLength ?? DEFAULT_MIN_LENGTH;
  if (text.length < minLength) {
    return { scrubbed: text, hits: 0, byName };
  }

  const fast = opts?.fast === true;

  if (fast) {
    // Stop after first match total. Find the earliest-winning pattern.
    for (const pattern of patterns) {
      pattern.re.lastIndex = 0;
      const m = pattern.re.exec(text);
      if (m && m[0] !== undefined && m[0].length > 0) {
        const start = m.index;
        const end = start + m[0].length;
        const scrubbed = `${text.slice(0, start)}${marker(pattern.name)}${text.slice(end)}`;
        byName[pattern.name] = 1;
        return { scrubbed, hits: 1, byName };
      }
    }
    return { scrubbed: text, hits: 0, byName };
  }

  let out = text;
  let hits = 0;
  for (const pattern of patterns) {
    pattern.re.lastIndex = 0;
    out = out.replace(pattern.re, (): string => {
      hits += 1;
      byName[pattern.name] = (byName[pattern.name] ?? 0) + 1;
      return marker(pattern.name);
    });
  }

  return { scrubbed: out, hits, byName };
}
