// SEC-004: credential pattern scrubber for tool results.
//
// Ported from patches/003-secret-scrub-tool-results.patch. The upstream
// opencode-ai binary is compiled, so we cannot patch the TS source;
// instead this module lives inside the jellyclaw engine as first-class
// plugin code and is invoked from the plugin layer before tool output
// reaches the model.
//
// Design:
//   - Each rule has a name (used in the redaction marker) and a regex.
//   - Rules run in declaration order; earlier matches consume bytes that
//     later (broader) patterns won't re-match. Put high-signal rules first.
//   - We redact the WHOLE match, not just the secret suffix, because the
//     prefix ("password=", "Authorization: Bearer") is itself part of
//     what leaks intent.
//   - We increment a counter per rule so hooks can observe redaction
//     pressure without logging the matched bytes.

export interface ScrubStats {
  total: number;
  byRule: Record<string, number>;
}

export interface ScrubOptions {
  /** Additional literal strings (e.g. minted server password) to redact verbatim. */
  extraLiterals?: string[];
}

interface Rule {
  readonly name: string;
  readonly re: RegExp;
}

const RULES: readonly Rule[] = [
  // Vendor-specific API keys (high-confidence, narrow)
  { name: "anthropic", re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: "openrouter", re: /sk-or-(?:v1-)?[A-Za-z0-9_-]{20,}/g },
  { name: "openai", re: /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g },
  { name: "stripe_live", re: /(?:sk|rk)_live_[A-Za-z0-9]{20,}/g },
  { name: "stripe_test", re: /(?:sk|rk)_test_[A-Za-z0-9]{20,}/g },
  { name: "aws_access", re: /AKIA[0-9A-Z]{16}/g },
  { name: "google_api", re: /AIza[0-9A-Za-z_-]{35}/g },
  { name: "github_pat", re: /(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{36,}/g },
  { name: "github_finepat", re: /github_pat_[A-Za-z0-9_]{22,}_[A-Za-z0-9_]{40,}/g },
  { name: "slack", re: /xox[abpr]-[A-Za-z0-9-]{10,}/g },

  // JWT-shaped (three base64url segments joined by dots, starts with eyJ)
  { name: "jwt", re: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g },

  // Authorization headers
  { name: "bearer", re: /Bearer\s+[A-Za-z0-9._~+/=-]{16,}/gi },
  { name: "basic", re: /Basic\s+[A-Za-z0-9+/=]{16,}/gi },

  // .env-style lines for sensitive key names. Anchored to start-of-line
  // so we don't eat narrative prose like "the api_key=..." in a sentence.
  {
    name: "env_line",
    re: /(?:^|\n)\s*(?:[A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|PASS|CREDENTIAL|PRIVATE)[A-Z0-9_]*)\s*=\s*[^\n]+/g,
  },

  // Connection strings with embedded credentials
  {
    name: "url_creds",
    re: /(?:https?|postgres|postgresql|mysql|mongodb|redis|amqp):\/\/[^\s:@/]+:[^\s:@/]+@[^\s]+/g,
  },

  // Generic query-string secrets — keep last, lowest confidence
  {
    name: "qs_secret",
    re: /\b(?:token|api_key|apikey|access_token|refresh_token|secret|password)=[^\s&,;"']{8,}/gi,
  },
];

const REPLACEMENT = (name: string): string => `[REDACTED:${name}]`;
const LITERAL_REPLACEMENT = "[REDACTED:literal]";

function escapeRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function scrubSecrets(input: string, stats?: ScrubStats, opts?: ScrubOptions): string {
  if (!input) return input;
  let out = input;

  // Literal replacements first so subsequent regex rules see the redacted
  // placeholder and don't double-count.
  const extras = opts?.extraLiterals;
  if (extras && extras.length > 0) {
    for (const literal of extras) {
      if (!literal) continue;
      const re = new RegExp(escapeRegex(literal), "g");
      out = out.replace(re, () => {
        if (stats) {
          stats.total += 1;
          stats.byRule.literal = (stats.byRule.literal ?? 0) + 1;
        }
        return LITERAL_REPLACEMENT;
      });
    }
  }

  for (const rule of RULES) {
    out = out.replace(rule.re, (match: string): string => {
      if (stats) {
        stats.total += 1;
        stats.byRule[rule.name] = (stats.byRule[rule.name] ?? 0) + 1;
      }
      // Preserve leading whitespace on env_line matches so line breaks
      // in surrounding output still render correctly.
      if (rule.name === "env_line") {
        const leadingMatch = match.match(/^[\s]*/);
        const leading = leadingMatch?.[0] ?? "";
        return `${leading}${REPLACEMENT(rule.name)}`;
      }
      return REPLACEMENT(rule.name);
    });
  }
  return out;
}

/** Exposed for tests: run scrub and return stats alongside output. */
export function scrubWithStats(
  input: string,
  opts?: ScrubOptions,
): { output: string; stats: ScrubStats } {
  const stats: ScrubStats = { total: 0, byRule: {} };
  const output = scrubSecrets(input, stats, opts);
  return { output, stats };
}

/**
 * Convenience for plugin use — recursively scrubs a structured tool
 * result. Strings are scrubbed in-place-ish (returned as new strings);
 * arrays and plain objects are walked; numbers, booleans, null,
 * undefined, and other primitives are returned untouched.
 */
export function scrubToolResult<T>(result: T, opts?: ScrubOptions): T {
  return walk(result, opts) as T;
}

function walk(value: unknown, opts?: ScrubOptions): unknown {
  if (typeof value === "string") {
    return scrubSecrets(value, undefined, opts);
  }
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((v) => walk(v, opts));
  }
  if (typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src)) {
      out[key] = walk(src[key], opts);
    }
    return out;
  }
  return value;
}
