/**
 * Substitution rules for skill bodies.
 *
 * Applied after discovery/parsing, before a skill body is injected into the
 * model prompt. Pure over strings — no I/O, no clock. See Phase 05 step 4.
 *
 * Order of operations matters:
 *   1. Protect `\$` escapes with a sentinel so they cannot be consumed.
 *   2. Substitute `$ARGUMENTS` (full arg string).
 *   3. Substitute `$1`..`$9` positional args (with a trailing-digit guard so
 *      `$10` is NOT parsed as `$1` + `0`; unsupported forms stay literal).
 *   4. Substitute `$CLAUDE_PROJECT_DIR` (kept with `CLAUDE_` prefix for
 *      upstream Genie compatibility).
 *   5. Sweep for unknown `$VAR` (uppercase-leading) names and record them.
 *   6. Restore `\$` escapes to literal `$`.
 */

const ESCAPE_SENTINEL = "\u0000ESCDOLLAR\u0000";
const UNKNOWN_VAR_RE = /\$([A-Z_][A-Z0-9_]*)/g;
const POSITIONAL_RE = /\$([1-9])(?!\d)/g;
const ARGUMENTS_RE = /\$ARGUMENTS/g;
const PROJECT_DIR_RE = /\$CLAUDE_PROJECT_DIR/g;

export interface SubstituteOptions {
  /** Full arg string, e.g. "alpha beta gamma". */
  args?: string;
  /** Used for `$CLAUDE_PROJECT_DIR`. */
  projectDir: string;
}

export interface SubstituteResult {
  output: string;
  /** Deduped list of unknown `$VAR` names (without the `$`), first-seen order. */
  unknown: string[];
}

/**
 * Apply skill-body substitutions.
 *
 * Pure function — same inputs always produce same outputs. Unknown uppercase
 * `$VAR` references are left in the output as literals and reported in
 * `result.unknown` so the caller can warn the author.
 */
export function substitute(body: string, opts: SubstituteOptions): SubstituteResult {
  const args = opts.args ?? "";
  const positional = args.trim().length === 0 ? [] : args.trim().split(/\s+/);

  // Step 1: protect `\$` escapes.
  let out = body.replace(/\\\$/g, ESCAPE_SENTINEL);

  // Step 2: $ARGUMENTS → full arg string.
  out = out.replace(ARGUMENTS_RE, args);

  // Step 3: $1..$9 positional, with trailing-digit guard.
  out = out.replace(POSITIONAL_RE, (_match, digit: string) => {
    const idx = Number.parseInt(digit, 10) - 1;
    return positional[idx] ?? "";
  });

  // Step 4: $CLAUDE_PROJECT_DIR.
  out = out.replace(PROJECT_DIR_RE, opts.projectDir);

  // Step 5: sweep for unknown uppercase $VAR refs.
  const unknown: string[] = [];
  const seen = new Set<string>();
  for (const match of out.matchAll(UNKNOWN_VAR_RE)) {
    const name = match[1];
    if (name === undefined) continue;
    if (name === "ARGUMENTS" || name === "CLAUDE_PROJECT_DIR") continue;
    if (seen.has(name)) continue;
    seen.add(name);
    unknown.push(name);
  }

  // Step 6: restore escape sentinels to literal `$`.
  out = out.replaceAll(ESCAPE_SENTINEL, "$");

  return { output: out, unknown };
}
