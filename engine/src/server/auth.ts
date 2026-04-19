/**
 * Phase 10.02 — bearer-token auth middleware (Phase 08 T5-03 update).
 *
 * Policy (engine/SECURITY.md §2.2): every HTTP request must carry
 * authentication. No localhost shortcut, no origin bypass — CVE-2026-22812
 * teaches us that browser-origin probing of 127.0.0.1 is defensible only
 * via a secret the browser cannot learn.
 *
 * Phase 08 T5-03: refactored to use pluggable AuthProvider. The middleware
 * calls `provider.authenticate(req, ip)`, sets both `c.var.principal` (new)
 * and `c.var.authenticated = true` (back-compat) on success.
 *
 * Phase 08 T3-02 (this file): exposes {@link extractBearerToken} so feature
 * routes (see `routes/tui-handoff.ts`) can reason about the raw bearer
 * secret when they derive downstream keys (HMAC-signed OTPs, in that case)
 * without having to re-implement the Authorization header parsing.
 *
 * OPTIONS requests never reach the auth check — the CORS middleware
 * terminates them first. Defense in depth: we still short-circuit here for
 * OPTIONS in case the middleware order is rearranged later.
 */

import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";

import type { MiddlewareHandler } from "hono";

import { type AuthProvider, createBearerAuthProvider } from "./auth/index.js";
import type { AppVariables } from "./types.js";

export interface AuthMiddlewareOptions {
  /** @deprecated Pass `provider` instead. Kept for one-release back-compat. */
  readonly authToken?: string;
  readonly provider?: AuthProvider;
}

/**
 * Extract client IP address from request headers.
 * Priority: Fly-Client-IP → X-Forwarded-For first hop → fallback "0.0.0.0"
 */
function extractClientIp(req: Request): string {
  // Fly.io sets this header authoritatively
  const flyClientIp = req.headers.get("Fly-Client-IP");
  if (flyClientIp !== null && flyClientIp.length > 0) {
    return flyClientIp;
  }

  // Standard proxy header — take first hop only
  const xff = req.headers.get("X-Forwarded-For");
  if (xff !== null && xff.length > 0) {
    const firstHop = xff.split(",")[0]?.trim();
    if (firstHop !== undefined && firstHop.length > 0) {
      return firstHop;
    }
  }

  return "0.0.0.0";
}

/**
 * Build the auth middleware. Accepts either a pre-built `provider` or a
 * legacy `authToken` string (which will be wrapped in BearerAuthProvider).
 *
 * @throws Error if neither `provider` nor `authToken` is provided
 */
export function createAuthMiddleware(
  options: AuthMiddlewareOptions,
): MiddlewareHandler<{ Variables: AppVariables }> {
  // Derive provider from options
  let provider: AuthProvider;
  if (options.provider !== undefined) {
    provider = options.provider;
  } else if (options.authToken !== undefined && options.authToken.length > 0) {
    provider = createBearerAuthProvider({ authToken: options.authToken });
  } else {
    throw new Error("createAuthMiddleware: either provider or non-empty authToken required");
  }

  return async (c, next) => {
    if (c.req.method === "OPTIONS") {
      // Preflight is terminated by CORS middleware; this is a safety net.
      await next();
      return;
    }

    const ip = extractClientIp(c.req.raw);
    const principal = await provider.authenticate(c.req.raw, ip);

    if (principal === null) {
      return c.json({ error: "unauthorized" }, 401);
    }

    // Set both for back-compat and new Principal-aware code
    c.set("authenticated", true);
    c.set("principal", principal);
    await next();
    return;
  };
}

/**
 * Compare a caller-provided token against the expected buffer in (roughly)
 * constant time. Never short-circuits on length mismatch: a padded buffer of
 * `expected.length` is always compared; a parallel `lengthsEqual` boolean is
 * ANDed into the result so a length-only match cannot succeed.
 *
 * @deprecated Use BearerAuthProvider instead. Exported for test compatibility.
 */
export function constantTimeTokenCompare(provided: string, expected: Buffer): boolean {
  const providedBuf = Buffer.from(provided, "utf8");
  const lengthsEqual = providedBuf.length === expected.length;

  // Always allocate expected.length and copy whatever fits. Node's
  // timingSafeEqual requires equal-length buffers, so we pad.
  const padded = Buffer.alloc(expected.length);
  providedBuf.copy(padded, 0, 0, Math.min(providedBuf.length, expected.length));

  const bytesEqual = timingSafeEqual(padded, expected);
  return bytesEqual && lengthsEqual;
}

/**
 * Parse a raw Bearer token out of the request's Authorization header.
 *
 * Returns `null` when the header is absent, the scheme is not `Bearer`, or
 * the token portion is empty. Whitespace is trimmed; no other normalization
 * is performed — callers that need constant-time comparison should feed the
 * result into {@link constantTimeTokenCompare} (or the auth provider).
 *
 * Used by `routes/tui-handoff.ts` to derive the HMAC key from the same
 * bearer secret the caller authenticated with.
 */
export function extractBearerToken(req: Request): string | null {
  const header = req.headers.get("authorization") ?? req.headers.get("Authorization");
  if (header === null) return null;

  const [scheme, ...rest] = header.split(/\s+/);
  if (scheme?.toLowerCase() !== "bearer") return null;

  const token = rest.join(" ").trim();
  return token.length > 0 ? token : null;
}
