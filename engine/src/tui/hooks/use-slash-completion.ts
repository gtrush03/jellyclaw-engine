/**
 * Slash-command autocomplete hook (T1-04).
 *
 * Pure matcher plus a thin React wrapper. Given a live input string and the
 * command registry, returns up to 5 candidates to render in the hint strip
 * below the input box.
 *
 * Matching rules:
 *   - Input must begin with `/`. Any other prefix returns no matches.
 *   - A bare `/` surfaces the first 5 commands — useful for discovery.
 *   - Prefix is matched case-insensitively against each command's `name` and
 *     every alias.
 *   - An exact name match (case-insensitive equality, not just prefix) sorts
 *     first so `/end` pins above `/end-session` even though both match.
 *   - Aliases only contribute ranking; the canonical command name is always
 *     what the hint strip labels the row with.
 */

import { useMemo } from "react";
import type { CommandDefinition } from "../commands/registry.js";

export interface CompletionMatch {
  readonly name: string;
  readonly description: string;
}

/** Upper bound on returned matches — matches the hint strip row budget. */
export const MAX_MATCHES = 5;

interface RankedMatch extends CompletionMatch {
  readonly rank: number;
}

function candidateRank(prefix: string, name: string, aliases: readonly string[]): number | null {
  const lowered = name.toLowerCase();
  if (lowered === prefix) return 0;
  if (lowered.startsWith(prefix)) return 1;
  for (const alias of aliases) {
    const a = alias.toLowerCase();
    if (a === prefix) return 2;
    if (a.startsWith(prefix)) return 3;
  }
  return null;
}

/**
 * Pure matching — exported for tests and the React hook below.
 */
export function matchCommands(
  input: string,
  commands: readonly CommandDefinition[],
): readonly CompletionMatch[] {
  if (!input.startsWith("/")) return [];

  const prefix = input.slice(1).split(/\s/, 1)[0]?.toLowerCase() ?? "";
  if (prefix.length === 0) {
    return commands
      .slice(0, MAX_MATCHES)
      .map((c) => ({ name: c.name, description: c.description }));
  }

  const ranked: RankedMatch[] = [];
  for (const cmd of commands) {
    const rank = candidateRank(prefix, cmd.name, cmd.aliases ?? []);
    if (rank === null) continue;
    ranked.push({ name: cmd.name, description: cmd.description, rank });
  }
  ranked.sort((a, b) => a.rank - b.rank);
  return ranked.slice(0, MAX_MATCHES).map(({ name, description }) => ({ name, description }));
}

/**
 * React wrapper — memoises `matchCommands` against its two inputs.
 */
export function useSlashCompletion(
  input: string,
  commands: readonly CommandDefinition[],
): readonly CompletionMatch[] {
  return useMemo(() => matchCommands(input, commands), [input, commands]);
}
