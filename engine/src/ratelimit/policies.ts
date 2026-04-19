/**
 * Rate-limit policy resolver (Phase 08.03).
 *
 * Maps an incoming `ToolCall` to a `{ key, bucketConfig }` pair. The registry
 * then fetches/creates a `TokenBucket` for the key and the caller acquires a
 * token before executing the tool.
 *
 * Current coverage: browser tools (MCP `mcp__playwright__browser_*`).
 *   - `browser_navigate` keys by parsed hostname from `input.url`.
 *   - Other browser tools inherit `session.lastBrowserHost` — a per-session
 *     cursor updated by the caller after a successful navigate. A call
 *     before any navigate falls back to the sentinel host `_unknown` so it
 *     still gets the default policy applied rather than passing through
 *     unlimited.
 *
 * All other tools are passthrough (no limit) — additional policies can be
 * layered here as the threat model expands.
 *
 * Phase 07.5: Added global browser rate limit bucket (BROWSER_BUCKET) that
 * gates ALL browser MCP tools regardless of domain. This is pure runaway
 * protection — the only safety gate since browser tools run fully autonomous.
 */

import { createLogger, type Logger } from "../logger.js";
import type { ToolCall } from "../permissions/types.js";

// ---------------------------------------------------------------------------
// Global browser rate limit bucket (Phase 07.5)
// ---------------------------------------------------------------------------

/**
 * Global rate limit bucket for all browser MCP tools.
 * 60 requests per minute, burst of 10.
 *
 * This is the ONLY safety gate for autonomous browser tools — prevents
 * runaway tool calls while allowing normal usage patterns.
 */
export const BROWSER_BUCKET = {
  name: "browser",
  /** Max tokens (burst capacity). */
  capacity: 10,
  /** Refill rate: 60/min = 1/sec. */
  refillPerSecond: 1,
} as const;

/**
 * Pattern matching browser MCP tools that should be rate-limited.
 * Covers playwright, playwright-extension, and chrome-devtools servers.
 */
const BROWSER_RATE_LIMITED_PATTERN = /^mcp__(playwright|playwright-extension|chrome-devtools)__/;

/**
 * Check if a tool name should be rate-limited by the global browser bucket.
 */
export function isBrowserRateLimited(toolName: string): boolean {
  return BROWSER_RATE_LIMITED_PATTERN.test(toolName);
}

// ---------------------------------------------------------------------------
// Domain-based rate limiting (existing implementation)
// ---------------------------------------------------------------------------

export interface RateLimitBucketConfig {
  readonly capacity: number;
  readonly refillPerSecond: number;
}

export interface RateLimitPolicy {
  readonly browser?: {
    readonly default?: RateLimitBucketConfig;
    readonly perDomain?: Readonly<Record<string, RateLimitBucketConfig>>;
  };
  readonly strict?: boolean;
  readonly maxWaitMs?: number;
}

export interface RateLimitSessionState {
  lastBrowserHost: string | null;
}

export interface PolicyResolution {
  readonly key: string | null;
  readonly bucketConfig: RateLimitBucketConfig | null;
}

const PASSTHROUGH: PolicyResolution = { key: null, bucketConfig: null };

const BROWSER_NAVIGATE = "mcp__playwright__browser_navigate";

/** Browser tools that inherit the last navigated host. */
const BROWSER_INHERIT_TOOLS: ReadonlySet<string> = new Set([
  "mcp__playwright__browser_click",
  "mcp__playwright__browser_type",
  "mcp__playwright__browser_snapshot",
  "mcp__playwright__browser_fill_form",
  "mcp__playwright__browser_select_option",
  "mcp__playwright__browser_press_key",
  "mcp__playwright__browser_hover",
  "mcp__playwright__browser_drag",
  "mcp__playwright__browser_evaluate",
  "mcp__playwright__browser_file_upload",
  "mcp__playwright__browser_take_screenshot",
  "mcp__playwright__browser_tabs",
  "mcp__playwright__browser_navigate_back",
  "mcp__playwright__browser_wait_for",
  "mcp__playwright__browser_close",
  "mcp__playwright__browser_run_code",
  "mcp__playwright__browser_resize",
  "mcp__playwright__browser_handle_dialog",
  "mcp__playwright__browser_console_messages",
  "mcp__playwright__browser_network_requests",
]);

const UNKNOWN_HOST = "_unknown";

let defaultLogger: Logger | null = null;
function log(): Logger {
  if (!defaultLogger) defaultLogger = createLogger({ name: "ratelimit" });
  return defaultLogger;
}

function parseHost(urlStr: unknown): string | null {
  if (typeof urlStr !== "string" || urlStr.length === 0) return null;
  try {
    return new URL(urlStr).hostname || null;
  } catch {
    return null;
  }
}

function pickBucket(policy: RateLimitPolicy, host: string): RateLimitBucketConfig | null {
  const browser = policy.browser;
  if (!browser) return null;
  const perDomain = browser.perDomain?.[host];
  if (perDomain) return perDomain;
  return browser.default ?? null;
}

/**
 * Resolve the rate-limit key and bucket config for a tool call. Pure —
 * does not mutate `session`.
 */
export function resolveRateLimitKey(
  call: ToolCall,
  policy: RateLimitPolicy,
  session: RateLimitSessionState,
): PolicyResolution {
  if (!policy.browser) return PASSTHROUGH;

  if (call.name === BROWSER_NAVIGATE) {
    const host = parseHost(call.input.url);
    if (!host) {
      log().warn(
        { tool: call.name, url: call.input.url },
        "ratelimit: could not parse URL for browser_navigate; passing through",
      );
      return PASSTHROUGH;
    }
    const bucketConfig = pickBucket(policy, host);
    if (!bucketConfig) return { key: `browser:${host}`, bucketConfig: null };
    return { key: `browser:${host}`, bucketConfig };
  }

  if (BROWSER_INHERIT_TOOLS.has(call.name)) {
    const host = session.lastBrowserHost ?? UNKNOWN_HOST;
    const bucketConfig = pickBucket(policy, host);
    if (!bucketConfig) return { key: `browser:${host}`, bucketConfig: null };
    return { key: `browser:${host}`, bucketConfig };
  }

  return PASSTHROUGH;
}

/**
 * Update `session.lastBrowserHost` from a successful `browser_navigate` call.
 * Caller is responsible for only invoking this after the navigate actually
 * succeeded (the function itself just extracts the hostname from the call's
 * input URL). No-op for other tools or unparseable URLs.
 */
export function noteBrowserHost(session: RateLimitSessionState, call: ToolCall): void {
  if (call.name !== BROWSER_NAVIGATE) return;
  const host = parseHost(call.input.url);
  if (!host) return;
  session.lastBrowserHost = host;
}
