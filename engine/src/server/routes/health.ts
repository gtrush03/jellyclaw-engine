/**
 * Phase 10.02 — `GET /v1/health`.
 *
 * Auth middleware is applied app-wide; this route is authenticated. Returns
 * the engine version, uptime in ms, and active-run count. No PII, no secrets.
 */

import type { Hono } from "hono";

import type { AppVariables, RunManager } from "../types.js";

export interface HealthRouteOptions {
  readonly version: string;
  readonly runManager: RunManager;
  readonly startedAt: number;
}

export function registerHealthRoutes(
  app: Hono<{ Variables: AppVariables }>,
  opts: HealthRouteOptions,
): void {
  app.get("/v1/health", (c) => {
    const snapshot = opts.runManager.snapshot();
    return c.json({
      ok: true,
      version: opts.version,
      uptime_ms: Date.now() - opts.startedAt,
      active_runs: snapshot.activeRuns,
    });
  });
}
