/**
 * Phase 10.5 — `/v1/sessions/:id/messages` HTTP routes.
 *
 * The TUI adapter (`sdk-adapter.ts`) calls `GET /v1/sessions/:id/messages` to
 * hydrate the scrollback when rehydrating a session, and `POST` to send a
 * user turn mid-session (steer). Response shape is `{messages: unknown[]}`
 * per the adapter's `MessageListSchema` — we emit the buffered AgentEvents
 * unchanged so `event-map.ts` on the TUI side can translate.
 */

import type { Hono } from "hono";
import { z } from "zod";

import type { Logger } from "../../logger.js";
import type { SessionManager } from "../session-manager.js";
import { type AppVariables, type RunManager, RunNotFoundError } from "../types.js";

const SendMessageBodySchema = z.object({ text: z.string().min(1) }).strict();

const MessagesResponseSchema = z.object({
  messages: z.array(z.unknown()),
});

export interface RegisterMessageRoutesDeps {
  readonly runManager: RunManager;
  readonly sessionManager: SessionManager;
  readonly logger: Logger;
}

export function registerMessageRoutes(
  app: Hono<{ Variables: AppVariables }>,
  deps: RegisterMessageRoutesDeps,
): void {
  const { runManager, sessionManager, logger } = deps;

  // --- GET /v1/sessions/:id/messages --------------------------------------
  app.get("/v1/sessions/:id/messages", (c) => {
    const id = c.req.param("id");
    const session = sessionManager.getSession(id);
    if (!session) {
      return c.json({ error: "session_not_found" }, 404);
    }
    const messages = sessionManager.listMessages(id);
    const body = { messages };
    const parsed = MessagesResponseSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "internal", issues: parsed.error.issues }, 500);
    }
    return c.json(parsed.data, 200);
  });

  // --- POST /v1/sessions/:id/messages -------------------------------------
  app.post("/v1/sessions/:id/messages", async (c) => {
    const id = c.req.param("id");
    const raw = await safeJson(c);
    const parsed = SendMessageBodySchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "bad_request", issues: parsed.error.issues }, 400);
    }
    const session = sessionManager.getSession(id);
    if (!session) {
      return c.json({ error: "session_not_found" }, 404);
    }
    if (session.status !== "running") {
      return c.json({ error: "session_terminal", status: session.status }, 409);
    }
    try {
      const accepted = runManager.steer(session.latestRunId, parsed.data.text);
      if (!accepted) {
        return c.json({ error: "session_terminal", status: session.status }, 409);
      }
      return c.json({ ok: true }, 202);
    } catch (err) {
      if (err instanceof RunNotFoundError) {
        return c.json({ error: "session_not_found" }, 404);
      }
      logger.error({ err, sessionId: id }, "POST /v1/sessions/:id/messages failed");
      return c.json({ error: "internal", message: errMessage(err) }, 500);
    }
  });
}

async function safeJson(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
