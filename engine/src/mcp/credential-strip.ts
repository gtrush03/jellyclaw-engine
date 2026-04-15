/**
 * Credential scrubber for MCP stdio server output.
 *
 * Per SECURITY.md §2.4 (secret isolation), stdio MCP servers are spawned with
 * secret values in their `env` map. Any stderr/stdout/error text emitted by
 * those processes must have those values redacted before reaching a logger.
 *
 * This module builds a compiled RegExp once per scrubber and replaces every
 * occurrence of any secret value with the literal `[REDACTED]`.
 */

export const REDACTED = "[REDACTED]";

const MIN_SECRET_LENGTH = 6;

export type OnSkipped = (secret: string, reason: "empty" | "too_short") => void;

export interface BuildScrubberOptions {
  onSkipped?: OnSkipped;
}

/** Escape regex metacharacters so a raw string can be embedded in a RegExp. */
function escapeRegex(raw: string): string {
  return raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Builds a scrubber that replaces every occurrence of each value with `[REDACTED]`. */
export function buildCredentialScrubber(
  secrets: Iterable<string>,
  options: BuildScrubberOptions = {},
): (text: string) => string {
  const onSkipped = options.onSkipped;
  const kept: string[] = [];
  const seen = new Set<string>();

  for (const secret of secrets) {
    if (secret.length === 0) {
      onSkipped?.(secret, "empty");
      continue;
    }
    if (secret.length < MIN_SECRET_LENGTH) {
      onSkipped?.(secret, "too_short");
      continue;
    }
    if (seen.has(secret)) continue;
    seen.add(secret);
    kept.push(secret);
  }

  if (kept.length === 0) {
    return (text: string) => text;
  }

  // Longest-first so superstrings win over their prefixes.
  kept.sort((a, b) => b.length - a.length);

  const pattern = new RegExp(kept.map(escapeRegex).join("|"), "g");

  return (text: string): string => {
    // Reset lastIndex defensively even though `.replace` with a global RegExp
    // handles it; protects against any future refactor to `.exec` loops.
    pattern.lastIndex = 0;
    return text.replace(pattern, REDACTED);
  };
}

/** Convenience: one-shot scrub. Equivalent to `buildCredentialScrubber(secrets)(text)`. */
export function scrubCredentials(text: string, secrets: Iterable<string>): string {
  return buildCredentialScrubber(secrets)(text);
}
