/**
 * Phase 08 T5-03 — Principal type + rate-limit snapshot.
 *
 * The Principal represents the authenticated caller for every request.
 * Self-hosted mode always gets `selfHostedPrincipal()` which has full
 * access (`scopes: ["*"]`) and `tier: "byok"`.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Scope = "threads:read" | "threads:write" | "mcp:write" | "billing:read" | "*";

export interface RateLimitSnapshot {
  readonly runsPerMin: number;
  readonly runsPerDay: number;
  readonly concurrentRuns: number;
  /** null = unmetered (self-hosted or enterprise plan) */
  readonly usdPerDay: number | null;
}

export interface Principal {
  readonly kind: "bearer" | "api_key" | "jwt" | "anon";
  readonly accountId: string;
  readonly orgId: string;
  readonly tier: "anon" | "free" | "paid" | "byok";
  readonly scopes: readonly Scope[];
  readonly rateLimits: RateLimitSnapshot;
  /** BYOK principal holds the passthrough Anthropic key for this request only. Never persisted. */
  readonly byok: { readonly anthropicApiKey: string } | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The Principal returned for all self-hosted (single-user) bearer auth.
 * Full access, no metering.
 */
export function selfHostedPrincipal(): Principal {
  return {
    kind: "bearer",
    accountId: "self-hosted",
    orgId: "self-hosted",
    tier: "byok",
    scopes: ["*"],
    rateLimits: {
      runsPerMin: 300,
      runsPerDay: Number.POSITIVE_INFINITY,
      concurrentRuns: 20,
      usdPerDay: null,
    },
    byok: null,
  };
}

/**
 * Principal for BYOK users who pass their own Anthropic key.
 * Full access, no metering, but the key is attached for provider passthrough.
 */
export function byokPrincipal(accountId: string, anthropicApiKey: string): Principal {
  return {
    kind: "api_key",
    accountId,
    orgId: accountId,
    tier: "byok",
    scopes: ["*"],
    rateLimits: {
      runsPerMin: 300,
      runsPerDay: Number.POSITIVE_INFINITY,
      concurrentRuns: 20,
      usdPerDay: null,
    },
    byok: { anthropicApiKey },
  };
}

/**
 * Principal for free-tier API key users.
 * Limited access, metered.
 */
export function freeTierPrincipal(accountId: string): Principal {
  return {
    kind: "api_key",
    accountId,
    orgId: accountId,
    tier: "free",
    scopes: ["threads:read", "threads:write"],
    rateLimits: {
      runsPerMin: 10,
      runsPerDay: 100,
      concurrentRuns: 2,
      usdPerDay: 1,
    },
    byok: null,
  };
}
