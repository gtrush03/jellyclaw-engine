/**
 * Secret pattern registry (Phase 08.03).
 *
 * This module is the single source of truth for built-in secret patterns, the
 * loader for user-extended patterns (with a ReDoS smoke test and backreference
 * rejection), and a merger that folds in runtime literals (e.g. the minted
 * `OPENCODE_SERVER_PASSWORD` from Phase 07.01 and MCP server env values).
 *
 * Design notes:
 *   - Every pattern has a stable `name` that appears in the `[REDACTED:<name>]`
 *     marker. Names are snake_case so they survive case-sensitive log search.
 *   - Patterns are applied in the order returned here. Narrow / high-confidence
 *     patterns come first so they consume bytes before broader patterns
 *     (generic bearer, generic password) would otherwise match them.
 *   - The existing `engine/src/plugin/secret-scrub.ts` is the legacy in-plugin
 *     scrubber and stays in place; Phase 10+ consolidates to this module.
 */

export interface SecretPattern {
  /** Stable label used in the [REDACTED:<name>] marker. Must be snake_case. */
  readonly name: string;
  /** Compiled regex. MUST be `/g` (global). MUST NOT use backreferences. */
  readonly re: RegExp;
}

export interface UserPatternSpec {
  readonly name: string;
  readonly regex: string;
  readonly flags?: string;
}

export class ReDoSRejectedError extends Error {
  public readonly patternName: string;
  public readonly elapsedMs: number;

  constructor(patternName: string, elapsedMs: number) {
    super(
      `pattern "${patternName}" rejected: ReDoS probe took ${elapsedMs.toFixed(2)}ms (> 50ms budget)`,
    );
    this.name = "ReDoSRejectedError";
    this.patternName = patternName;
    this.elapsedMs = elapsedMs;
  }
}

export class InvalidPatternError extends Error {
  public readonly patternName: string;

  constructor(patternName: string, reason: string) {
    super(`pattern "${patternName}" invalid: ${reason}`);
    this.name = "InvalidPatternError";
    this.patternName = patternName;
  }
}

const BUILTINS: readonly SecretPattern[] = [
  // Vendor-specific API keys (narrow, high-confidence) first.
  { name: "anthropic_api_key", re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: "openrouter_api_key", re: /sk-or-(?:v1-)?[A-Za-z0-9_-]{20,}/g },
  { name: "openai_api_key", re: /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g },
  { name: "aws_access_key_id", re: /AKIA[0-9A-Z]{16}/g },
  { name: "github_pat_fine", re: /github_pat_[A-Za-z0-9_]{22,}/g },
  { name: "github_pat_legacy", re: /gh[pousr]_[A-Za-z0-9]{30,}/g },
  { name: "stripe_live", re: /(?:sk|rk)_live_[A-Za-z0-9]{20,}/g },
  { name: "stripe_test", re: /(?:sk|rk)_test_[A-Za-z0-9]{20,}/g },
  { name: "slack_bot_token", re: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
  // authorization_bearer runs BEFORE jwt so the full "Authorization: Bearer <jwt>"
  // header (prefix included) is captured rather than leaving the header text
  // behind with just the token body redacted.
  {
    name: "authorization_bearer",
    re: /(?:[Aa]uthorization:\s*)?[Bb]earer\s+[A-Za-z0-9._-]{16,}/g,
  },
  { name: "jwt", re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  {
    name: "generic_password_assignment",
    re: /(?:password|passwd|pwd)\s*[:=]\s*[^\s"'`,}\]]{4,}/gi,
  },
];

/** All built-in patterns, ordered by specificity (narrow first). */
export function builtInPatterns(): SecretPattern[] {
  return BUILTINS.slice();
}

function escapeRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasBackreference(source: string): boolean {
  // Disallow \1..\9 backreferences. We allow \\1 (escaped backslash + digit).
  return /(?<!\\)\\[1-9]/.test(source);
}

function ensureGlobal(flags: string): string {
  return flags.includes("g") ? flags : `${flags}g`;
}

const REDOS_PROBE_SIZE = 1 << 20; // 1 MB
const REDOS_BUDGET_MS = 50;
let PROBE_STRING: string | undefined;
function probeString(): string {
  if (PROBE_STRING === undefined) PROBE_STRING = "a".repeat(REDOS_PROBE_SIZE);
  return PROBE_STRING;
}

function defaultNow(): number {
  return performance.now();
}

interface CompileUserPatternsOptions {
  readonly now?: () => number;
}

interface CompileUserPatternsResult {
  readonly patterns: SecretPattern[];
  readonly rejected: Array<{ name: string; reason: string }>;
}

/**
 * Compile user-supplied patterns. Each regex is smoke-tested against 1 MB of
 * 'a' — if `.test()` takes > 50 ms, we reject with `ReDoSRejectedError`.
 * Backreferences are rejected with `InvalidPatternError`. Regexes without the
 * global flag have `g` added automatically.
 */
export function compileUserPatterns(
  specs: readonly UserPatternSpec[],
  opts?: CompileUserPatternsOptions,
): CompileUserPatternsResult {
  const now = opts?.now ?? defaultNow;
  const patterns: SecretPattern[] = [];
  const rejected: Array<{ name: string; reason: string }> = [];

  for (const spec of specs) {
    if (!spec.name || typeof spec.name !== "string") {
      rejected.push({ name: String(spec.name), reason: "missing name" });
      continue;
    }
    if (hasBackreference(spec.regex)) {
      rejected.push({
        name: spec.name,
        reason: "backreference (\\1..\\9) not allowed",
      });
      continue;
    }
    let re: RegExp;
    try {
      re = new RegExp(spec.regex, ensureGlobal(spec.flags ?? "g"));
    } catch (err) {
      rejected.push({
        name: spec.name,
        reason: `failed to compile: ${(err as Error).message}`,
      });
      continue;
    }
    // ReDoS probe.
    const probe = probeString();
    const start = now();
    try {
      re.lastIndex = 0;
      re.test(probe);
    } catch (err) {
      rejected.push({ name: spec.name, reason: `probe threw: ${(err as Error).message}` });
      continue;
    }
    const elapsed = now() - start;
    if (elapsed > REDOS_BUDGET_MS) {
      rejected.push({
        name: spec.name,
        reason: `ReDoS probe took ${elapsed.toFixed(2)}ms (> ${REDOS_BUDGET_MS}ms)`,
      });
      continue;
    }
    re.lastIndex = 0;
    patterns.push({ name: spec.name, re });
  }

  return { patterns, rejected };
}

/**
 * Merge built-in + user + runtime-literal patterns. Dedup by name (first wins).
 * Ordering: builtins, then user, then literals. Literals are compiled with the
 * stable name `runtime_literal`.
 */
export function mergePatterns(
  builtins: readonly SecretPattern[],
  user: readonly SecretPattern[],
  literals: readonly string[],
): SecretPattern[] {
  const out: SecretPattern[] = [];
  const seen = new Set<string>();
  for (const p of builtins) {
    if (seen.has(p.name)) continue;
    seen.add(p.name);
    out.push(p);
  }
  for (const p of user) {
    if (seen.has(p.name)) continue;
    seen.add(p.name);
    out.push(p);
  }
  for (const literal of literals) {
    if (!literal) continue;
    const re = new RegExp(escapeRegex(literal), "g");
    out.push({ name: "runtime_literal", re });
  }
  return out;
}
