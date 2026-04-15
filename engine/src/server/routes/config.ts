/**
 * Phase 10.02 — `GET /v1/config`.
 *
 * Returns the **already-redacted** config snapshot the caller constructed at
 * app build time. We never re-redact here (single source of truth lives in
 * `shared/src/events.ts`'s `redactConfig`). As a defense-in-depth check the
 * route strips `authToken` from the output if somehow present.
 */

import type { Hono } from "hono";

import type { AppVariables } from "../types.js";

export interface ConfigRouteOptions {
  /**
   * Pre-redacted snapshot produced by the caller (e.g. via
   * `redactConfig(effectiveConfig)`). The route does not walk this; it only
   * ensures the top-level `authToken` key is never echoed.
   */
  readonly configSnapshot: Record<string, unknown>;
}

export function registerConfigRoutes(
  app: Hono<{ Variables: AppVariables }>,
  opts: ConfigRouteOptions,
): void {
  const safe = stripAuthToken(opts.configSnapshot);
  app.get("/v1/config", (c) => c.json(safe));
}

function stripAuthToken(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (k === "authToken" || k === "auth_token") continue;
    out[k] = v;
  }
  return out;
}
