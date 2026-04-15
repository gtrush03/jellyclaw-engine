/**
 * Phase 10.02 — CORS middleware.
 *
 * Policy (per engine/SECURITY.md §2.3):
 *   - Default allowlist is empty; no origin is CORS-permitted unless the
 *     operator configures one explicitly.
 *   - Never emit `Access-Control-Allow-Origin: *`.
 *   - Never emit `Access-Control-Allow-Credentials: true` — the bearer token
 *     is the only auth factor.
 *   - Preflight (OPTIONS) returns 204 when the origin matches; otherwise we
 *     do not emit allow headers and the browser rejects the request. This
 *     middleware short-circuits preflight BEFORE the auth middleware sees it,
 *     so OPTIONS never 401s.
 *
 * Origin grammar accepted by {@link parseCorsOrigins}:
 *   - exact:              `https://app.example.com`
 *   - localhost wildcard: `http://localhost:*` or `http://127.0.0.1:*` (any port)
 *
 * No other wildcards are permitted.
 */

import type { Context, MiddlewareHandler } from "hono";

import type { AppVariables, CorsOrigin } from "./types.js";

const ALLOWED_METHODS = "GET,POST,OPTIONS";
const ALLOWED_HEADERS = "Authorization, Content-Type";
const PREFLIGHT_MAX_AGE = "600";

/**
 * Parse a comma-separated list of origin patterns into structured
 * {@link CorsOrigin} values. Throws on malformed input so the server refuses
 * to start with a broken CORS config.
 */
export function parseCorsOrigins(raw: string): CorsOrigin[] {
  const trimmed = raw.trim();
  if (trimmed === "") return [];

  const parts = trimmed
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const out: CorsOrigin[] = [];

  for (const part of parts) {
    const match = /^(https?):\/\/(localhost|127\.0\.0\.1):\*$/.exec(part);
    if (match) {
      const scheme = match[1] === "https" ? "https" : "http";
      const host = match[2] === "127.0.0.1" ? "127.0.0.1" : "localhost";
      out.push({ kind: "localhost-wildcard", scheme, host });
      continue;
    }

    if (part.includes("*")) {
      throw new Error(
        `invalid CORS origin "${part}": only "http(s)://localhost:*" and "http(s)://127.0.0.1:*" wildcards are allowed`,
      );
    }

    if (!/^https?:\/\/[^\s]+$/.test(part)) {
      throw new Error(`invalid CORS origin "${part}": must be an absolute http(s) URL`);
    }

    // Strip trailing slash for consistent exact match.
    const normalized = part.replace(/\/+$/, "");
    out.push({ kind: "exact", value: normalized });
  }

  return out;
}

/**
 * Return true if the request `Origin` header matches any allowed origin.
 */
export function matchOrigin(origin: string, allowed: readonly CorsOrigin[]): boolean {
  for (const entry of allowed) {
    if (entry.kind === "exact") {
      if (entry.value === origin) return true;
      continue;
    }
    // localhost-wildcard
    const pattern = new RegExp(`^${entry.scheme}://${entry.host.replace(/\./g, "\\.")}:\\d+$`);
    if (pattern.test(origin)) return true;
  }
  return false;
}

/**
 * Build the Hono middleware. Terminates OPTIONS preflight early (204) so the
 * auth middleware, mounted after this one, never sees a preflight.
 */
export function createCorsMiddleware(
  allowed: readonly CorsOrigin[],
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (c, next) => {
    const origin = c.req.header("Origin");

    if (c.req.method === "OPTIONS") {
      if (origin !== undefined && matchOrigin(origin, allowed)) {
        applyAllowHeaders(c, origin);
        c.header("Access-Control-Allow-Methods", ALLOWED_METHODS);
        c.header("Access-Control-Allow-Headers", ALLOWED_HEADERS);
        c.header("Access-Control-Max-Age", PREFLIGHT_MAX_AGE);
      }
      // Always terminate preflight here (auth middleware must not see it).
      // If the origin didn't match, we return 204 with NO allow headers —
      // browsers treat the absence as rejection.
      return c.body(null, 204);
    }

    if (origin !== undefined && matchOrigin(origin, allowed)) {
      applyAllowHeaders(c, origin);
    }

    await next();
    return;
  };
}

function applyAllowHeaders(c: Context<{ Variables: AppVariables }>, origin: string): void {
  c.header("Access-Control-Allow-Origin", origin);
  c.header("Vary", "Origin");
  // NOTE: never emit Access-Control-Allow-Credentials — the bearer token is
  // the only auth factor and credentialed CORS requests are out of scope.
}
