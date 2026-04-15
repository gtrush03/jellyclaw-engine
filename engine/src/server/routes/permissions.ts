/**
 * Phase 10.5 — `/v1/sessions/:id/permissions/*` HTTP routes.
 *
 * The TUI shows a permission prompt whenever the engine emits
 * `permission.requested`. The prompt UI calls `GET …/permissions/pending`
 * to hydrate any queued requests at reconnect, and `POST …/permissions/:permId/reply`
 * to deliver the user's choice. The adapter in `sdk-adapter.ts` issues the
 * reply against `POST /v1/sessions/:id/permissions/:permId` (no `/reply` suffix);
 * we register BOTH paths so either spelling works. The spec path is the
 * canonical one; the bare path is kept for the shipped adapter.
 */

import type { Context, Hono } from "hono";
import { z } from "zod";

import type { Logger } from "../../logger.js";
import type { SessionManager } from "../session-manager.js";
import type { AppVariables } from "../types.js";

const ReplyBodySchema = z
  .object({
    response: z.enum(["once", "always", "reject"]),
  })
  .strict();

const PendingEntrySchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  toolName: z.string(),
  reason: z.string(),
  inputPreview: z.unknown(),
  askedAt: z.number(),
});

const PendingResponseSchema = z.object({
  pending: z.array(PendingEntrySchema),
});

export interface RegisterPermissionRoutesDeps {
  readonly sessionManager: SessionManager;
  readonly logger: Logger;
}

export function registerPermissionRoutes(
  app: Hono<{ Variables: AppVariables }>,
  deps: RegisterPermissionRoutesDeps,
): void {
  const { sessionManager, logger } = deps;

  // --- GET /v1/sessions/:id/permissions/pending ---------------------------
  app.get("/v1/sessions/:id/permissions/pending", (c) => {
    const id = c.req.param("id");
    const session = sessionManager.getSession(id);
    if (!session) {
      return c.json({ error: "session_not_found" }, 404);
    }
    const pending = sessionManager.listPendingPermissions(id);
    const body = { pending };
    const parsed = PendingResponseSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "internal", issues: parsed.error.issues }, 500);
    }
    return c.json(parsed.data, 200);
  });

  // --- POST /v1/sessions/:id/permissions/:permId(/reply)? -----------------
  //
  // Register once per path so Hono's route-typing doesn't widen to `never`.
  async function handle(c: Context<{ Variables: AppVariables }>): Promise<Response> {
    const id = c.req.param("id") ?? "";
    const permId = c.req.param("permId") ?? "";
    const raw = await safeJson(c);
    const parsed = ReplyBodySchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "bad_request", issues: parsed.error.issues }, 400);
    }
    const session = sessionManager.getSession(id);
    if (!session) {
      return c.json({ error: "session_not_found" }, 404);
    }
    const ok = sessionManager.replyPermission(id, permId, parsed.data.response);
    if (!ok) {
      return c.json({ error: "permission_not_found" }, 404);
    }
    logger.debug(
      { sessionId: id, permissionId: permId, response: parsed.data.response },
      "permission reply accepted",
    );
    return c.json({ ok: true }, 200);
  }

  app.post("/v1/sessions/:id/permissions/:permId/reply", (c) => handle(c));
  // Adapter-compat alias (see `engine/src/tui/sdk-adapter.ts` — the shipped
  // adapter calls the bare path without `/reply`).
  app.post("/v1/sessions/:id/permissions/:permId", (c) => handle(c));
}

async function safeJson(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}
