/**
 * Phase 10.02 — bearer-token auth middleware.
 *
 * Policy (engine/SECURITY.md §2.2): every HTTP request must carry
 * `Authorization: Bearer <token>`. No localhost shortcut, no origin
 * bypass — CVE-2026-22812 teaches us that browser-origin probing of
 * 127.0.0.1 is defensible only via a secret the browser cannot learn.
 *
 * Timing: we use `crypto.timingSafeEqual` over equal-length buffers. If the
 * provided token differs in length from the configured token, we still run
 * the compare (on a zero-padded copy) so a length-based early return cannot
 * leak token length. A parallel boolean tracks the true length equality and
 * is ANDed with the timingSafe result for the final decision.
 *
 * OPTIONS requests never reach this middleware — the CORS middleware
 * terminates them first. Defense in depth: we still short-circuit here for
 * OPTIONS in case the middleware order is rearranged later.
 */

import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";

import type { MiddlewareHandler } from "hono";

import type { AppVariables } from "./types.js";

export interface AuthMiddlewareOptions {
  readonly authToken: string;
}

/**
 * Build the bearer auth middleware. `authToken` is the expected value; must
 * be non-empty (the CLI/wiring layer is responsible for auto-generating if
 * the operator did not supply one — see patches/002).
 */
export function createAuthMiddleware(
  options: AuthMiddlewareOptions,
): MiddlewareHandler<{ Variables: AppVariables }> {
  const { authToken } = options;
  if (authToken.length === 0) {
    throw new Error("createAuthMiddleware: authToken must be non-empty");
  }
  const expected = Buffer.from(authToken, "utf8");

  return async (c, next) => {
    if (c.req.method === "OPTIONS") {
      // Preflight is terminated by CORS middleware; this is a safety net.
      await next();
      return;
    }

    const header = c.req.header("Authorization") ?? c.req.header("authorization");
    if (header === undefined) {
      return c.json({ error: "unauthorized" }, 401);
    }

    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match) {
      return c.json({ error: "unauthorized" }, 401);
    }

    const provided = match[1] ?? "";
    const allow = constantTimeTokenCompare(provided, expected);
    if (!allow) {
      return c.json({ error: "unauthorized" }, 401);
    }

    c.set("authenticated", true);
    await next();
    return;
  };
}

/**
 * Compare a caller-provided token against the expected buffer in (roughly)
 * constant time. Never short-circuits on length mismatch: a padded buffer of
 * `expected.length` is always compared; a parallel `lengthsEqual` boolean is
 * ANDed into the result so a length-only match cannot succeed.
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
