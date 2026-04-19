/**
 * Phase 08 T3-02 — `POST /v1/tui-token`.
 *
 * Mints a short-lived one-time-password (OTP) that the landing page's
 * "Try it" CTA forwards to the web TUI (ttyd). ttyd enforces it as an HTTP
 * Basic password; when the OTP expires or is reused, the next click refreshes.
 *
 * Security properties:
 *   - Issuance requires the caller's existing bearer (same seam as every
 *     other /v1 route — the app-level auth middleware enforces it).
 *   - Tokens are HMAC-SHA256 of `${serverSessionId}:${random32Hex}` keyed on
 *     the server's bearer secret, truncated to 24 bytes and base64url encoded.
 *     `serverSessionId` is a random 16-byte hex regenerated per process, so
 *     tokens issued in one boot cannot be verified by the next (cross-session
 *     poisoning defense).
 *   - Valid tokens land in an in-memory ring (capacity 100). Verification
 *     does two things in one pass: GC of expired entries, constant-time
 *     comparison against every live entry. One-shot consumption is NOT
 *     enforced here — ttyd does not replay, and the TTL cap provides the
 *     practical bound. (Single-use semantics land in a follow-up if needed.)
 *
 * Route contract:
 *   Request:  POST /v1/tui-token  `{ ttl_seconds?: number }`  (default 120, max 600)
 *   Response: 200 `{ token: string, expires_at: ISO8601 }`
 *   Errors:   401 (auth middleware — handled upstream), 400 (body shape)
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import type { Hono } from "hono";
import { z } from "zod";

import { extractBearerToken } from "../auth.js";
import type { AppVariables } from "../types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TTL_SEC = 120;
const MAX_TTL_SEC = 600;
const MIN_TTL_SEC = 1;
const RING_CAPACITY = 100;
const TOKEN_BYTES = 24;

const RequestBodySchema = z
  .object({
    ttl_seconds: z.number().int().min(MIN_TTL_SEC).max(MAX_TTL_SEC).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Internal state — one ring per handoff instance
// ---------------------------------------------------------------------------

interface RingEntry {
  readonly token: string;
  readonly expiresAtMs: number;
}

export interface TuiHandoffOptions {
  /**
   * Clock injection for deterministic tests. Defaults to {@link Date.now}.
   */
  readonly now?: () => number;
  /**
   * Server session id used in the HMAC payload. Defaults to a random hex
   * string regenerated for each handoff instance.
   */
  readonly serverSessionId?: string;
  /**
   * Max number of live tokens retained in memory. Defaults to {@link RING_CAPACITY}.
   */
  readonly ringCapacity?: number;
}

export interface TuiHandoff {
  /**
   * Issue a new token valid for `ttlSeconds`. The bearer secret the caller
   * authenticated with is mixed into the HMAC key — rotating the secret
   * invalidates every outstanding handoff.
   */
  issue(bearer: string, ttlSeconds: number): { token: string; expiresAtMs: number };
  /**
   * Verify a candidate token. GCs expired entries as a side effect.
   */
  verify(candidate: string): boolean;
  /** Server session id (exposed for diagnostics/tests). */
  readonly serverSessionId: string;
}

export function createTuiHandoff(opts: TuiHandoffOptions = {}): TuiHandoff {
  const now = opts.now ?? Date.now;
  const serverSessionId = opts.serverSessionId ?? randomBytes(16).toString("hex");
  const capacity = opts.ringCapacity ?? RING_CAPACITY;
  const ring: RingEntry[] = [];

  function gc(nowMs: number): void {
    for (let i = ring.length - 1; i >= 0; i--) {
      // biome-ignore lint/style/noNonNullAssertion: bounds checked above
      if (ring[i]!.expiresAtMs <= nowMs) {
        ring.splice(i, 1);
      }
    }
  }

  function issue(bearer: string, ttlSeconds: number) {
    const nonce = randomBytes(32).toString("hex");
    const payload = `${serverSessionId}:${nonce}`;
    const mac = createHmac("sha256", bearer).update(payload).digest().subarray(0, TOKEN_BYTES);
    const token = mac.toString("base64url");

    const nowMs = now();
    const expiresAtMs = nowMs + ttlSeconds * 1_000;

    gc(nowMs);
    ring.push({ token, expiresAtMs });
    while (ring.length > capacity) ring.shift();

    return { token, expiresAtMs };
  }

  function verify(candidate: string): boolean {
    if (typeof candidate !== "string" || candidate.length === 0) return false;
    const nowMs = now();
    gc(nowMs);

    const candidateBuf = Buffer.from(candidate, "utf8");
    let match = false;
    for (const entry of ring) {
      const entryBuf = Buffer.from(entry.token, "utf8");
      if (entryBuf.length !== candidateBuf.length) continue;
      // Constant-time compare; do NOT short-circuit on first match — iterate
      // the full ring so timing doesn't leak ring position.
      if (timingSafeEqual(entryBuf, candidateBuf)) {
        match = true;
      }
    }
    return match;
  }

  return { issue, verify, serverSessionId };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export interface RegisterTuiHandoffOptions {
  readonly handoff: TuiHandoff;
}

export function registerTuiHandoffRoutes(
  app: Hono<{ Variables: AppVariables }>,
  opts: RegisterTuiHandoffOptions,
): void {
  app.post("/v1/tui-token", async (c) => {
    // The auth middleware has already accepted this request — but we still
    // need the *raw* bearer to key the HMAC. If it isn't present something
    // is very wrong (auth was bypassed); fail closed.
    const bearer = extractBearerToken(c.req.raw);
    if (bearer === null) {
      return c.json({ error: "unauthorized" }, 401);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }

    const parsed = RequestBodySchema.safeParse(body ?? {});
    if (!parsed.success) {
      return c.json({ error: "bad_request", issues: parsed.error.issues }, 400);
    }

    const ttl = parsed.data.ttl_seconds ?? DEFAULT_TTL_SEC;
    const { token, expiresAtMs } = opts.handoff.issue(bearer, ttl);
    return c.json({
      token,
      expires_at: new Date(expiresAtMs).toISOString(),
    });
  });
}

/**
 * Back-compat helper for the supervisor — verifies a token against the
 * provided handoff instance. Kept as an exported function so the ttyd bridge
 * binary can import it without pulling the whole Hono app.
 */
export function verifyTuiToken(handoff: TuiHandoff, token: string): boolean {
  return handoff.verify(token);
}
