/**
 * Phase 10.5 — `/v1/sessions` HTTP routes.
 *
 * The TUI (via {@link engine/src/tui/sdk-adapter.ts}) uses these for the
 * session picker, the "continue / resume" flows, and the session-delete
 * command. Shape is dictated by the adapter's Zod schemas in
 * `sdk-adapter.ts` — list returns an array of `{id, title?, createdAt?}` and
 * get returns the same shape as one entry.
 *
 * `POST /v1/sessions` creates a new session by proxying into the existing
 * `RunManager.create` — the response shape still follows the adapter's
 * `CreateRunResponseSchema` (`{runId, sessionId}`) so the TUI's unified
 * client stays happy.
 */

import type { Hono } from "hono";
import { z } from "zod";

import type { Logger } from "../../logger.js";
import type { SessionManager } from "../session-manager.js";
import {
  type AppVariables,
  type CreateRunOptions,
  type RunManager,
} from "../types.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const CreateSessionBodySchema = z
  .object({
    prompt: z.string().min(1),
    sessionId: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    cwd: z.string().min(1).optional(),
  })
  .strict();

const SessionSummaryResponseSchema = z.object({
  id: z.string(),
  createdAt: z.number(),
  status: z.enum(["running", "idle", "completed", "failed", "cancelled"]),
  latestRunId: z.string(),
});

const SessionListResponseSchema = z.array(SessionSummaryResponseSchema);

const CreateSessionResponseSchema = z
  .object({
    runId: z.string(),
    sessionId: z.string(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export interface RegisterSessionRoutesDeps {
  readonly runManager: RunManager;
  readonly sessionManager: SessionManager;
  readonly logger: Logger;
}

export function registerSessionRoutes(
  app: Hono<{ Variables: AppVariables }>,
  deps: RegisterSessionRoutesDeps,
): void {
  const { runManager, sessionManager, logger } = deps;

  // --- GET /v1/sessions ----------------------------------------------------
  app.get("/v1/sessions", (c) => {
    const sessions = sessionManager.listSessions();
    const parsed = SessionListResponseSchema.safeParse(sessions);
    if (!parsed.success) {
      logger.error({ issues: parsed.error.issues }, "GET /v1/sessions: response schema invalid");
      return c.json({ error: "internal", issues: parsed.error.issues }, 500);
    }
    return c.json(parsed.data, 200);
  });

  // --- POST /v1/sessions ---------------------------------------------------
  app.post("/v1/sessions", async (c) => {
    const raw = await safeJson(c);
    const parsed = CreateSessionBodySchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "bad_request", issues: parsed.error.issues }, 400);
    }
    const opts = stripUndefined(parsed.data) as unknown as CreateRunOptions;
    try {
      const run = await runManager.create(opts);
      sessionManager.attachRun(run);
      const body = { runId: run.runId, sessionId: run.sessionId };
      const check = CreateSessionResponseSchema.safeParse(body);
      if (!check.success) {
        return c.json({ error: "internal", issues: check.error.issues }, 500);
      }
      return c.json(check.data, 201);
    } catch (err) {
      logger.error({ err }, "POST /v1/sessions failed");
      return c.json({ error: "internal", message: errMessage(err) }, 500);
    }
  });

  // --- GET /v1/sessions/:id ------------------------------------------------
  app.get("/v1/sessions/:id", (c) => {
    const id = c.req.param("id");
    const session = sessionManager.getSession(id);
    if (!session) {
      return c.json({ error: "session_not_found" }, 404);
    }
    const parsed = SessionSummaryResponseSchema.safeParse(session);
    if (!parsed.success) {
      return c.json({ error: "internal", issues: parsed.error.issues }, 500);
    }
    return c.json(parsed.data, 200);
  });

  // --- DELETE /v1/sessions/:id ---------------------------------------------
  app.delete("/v1/sessions/:id", (c) => {
    const id = c.req.param("id");
    const ok = sessionManager.deleteSession(id);
    if (!ok) {
      return c.json({ error: "session_not_found" }, 404);
    }
    return c.json({ ok: true }, 200);
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function safeJson(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as Partial<T>;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
