/**
 * Phase 10.02 — `/v1/runs/*` HTTP routes.
 *
 * Owned by Agent B. Consumes the frozen contract in `../types.ts` produced by
 * Agent A (`RunManager`, error classes, `AppVariables`). The SSE event pump is
 * delegated to `../sse.ts#streamRunEvents`.
 *
 * All route handlers are DI-injected via `registerRunRoutes(app, deps)` so
 * tests can stub a fake `RunManager` and exercise zod validation plus 4xx
 * code paths without booting a real HTTP server.
 */

import { createHash } from "node:crypto";

import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";

import type { Logger } from "../../logger.js";
import type { SessionPaths } from "../../session/paths.js";
import {
  type AppVariables,
  type CreateRunOptions,
  type RunManager,
  RunNotFoundError,
  RunTerminalError,
} from "../types.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/**
 * Matches `CreateRunOptions` in `../types.ts`. Only `prompt` is required; all
 * other fields are optional. Arrays arrive as JSON arrays (not CSV) because
 * this is a JSON body, not a Commander flag.
 */
export const RunCreateBodySchema = z
  .object({
    prompt: z.string().min(1),
    sessionId: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    permissionMode: z.string().min(1).optional(),
    maxTurns: z.number().int().positive().optional(),
    wishId: z.string().min(1).optional(),
    appendSystemPrompt: z.string().optional(),
    allowedTools: z.array(z.string().min(1)).optional(),
    mcpConfig: z.string().min(1).optional(),
    cwd: z.string().min(1).optional(),
  })
  .strict();

export const SteerBodySchema = z.object({ text: z.string().min(1) }).strict();

export const ResumeBodySchema = z.object({ prompt: z.string().min(1) }).strict();

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export interface RegisterRunRoutesDeps {
  readonly runManager: RunManager;
  readonly sessionPaths: SessionPaths;
  readonly logger: Logger;
  readonly version: string;
}

/** Mirror the SSE pump signature Agent A exports from `../sse.ts`. */
type SSEStream = Parameters<Parameters<typeof streamSSE>[1]>[0];

type StreamRunEventsFn = (params: {
  readonly run: NonNullable<ReturnType<RunManager["get"]>>;
  readonly sessionLogPath: string;
  readonly lastEventId: number | null;
  readonly signal: AbortSignal;
  readonly stream: SSEStream;
  readonly logger: Logger;
}) => Promise<void>;

/**
 * Loader indirection so routes.test.ts can inject a stub `streamRunEvents`
 * without Agent A's `sse.ts` existing yet. In production we lazily pull the
 * real implementation on first SSE request.
 */
let cachedStreamer: StreamRunEventsFn | null = null;
async function loadStreamer(): Promise<StreamRunEventsFn> {
  if (cachedStreamer !== null) return cachedStreamer;
  const mod = (await import("../sse.js")) as { streamRunEvents: StreamRunEventsFn };
  cachedStreamer = mod.streamRunEvents;
  return cachedStreamer;
}

/** Test hook — overrides the SSE streamer. */
export function __setStreamRunEventsForTests(fn: StreamRunEventsFn | null): void {
  cachedStreamer = fn;
}

export function registerRunRoutes(
  app: Hono<{ Variables: AppVariables }>,
  deps: RegisterRunRoutesDeps,
): void {
  const { runManager, sessionPaths, logger } = deps;

  // --- POST /v1/runs -------------------------------------------------------
  app.post("/v1/runs", async (c) => {
    const raw = await safeJson(c);
    const parsed = RunCreateBodySchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "bad_request", issues: parsed.error.issues }, 400);
    }
    // Strip `undefined` keys so exactOptionalPropertyTypes is happy.
    const opts = stripUndefined(parsed.data) as unknown as CreateRunOptions;
    try {
      const run = await runManager.create(opts);
      return c.json({ runId: run.runId, sessionId: run.sessionId }, 201);
    } catch (err) {
      logger.error({ err }, "POST /v1/runs failed");
      return c.json({ error: "internal", message: errMessage(err) }, 500);
    }
  });

  // --- GET /v1/runs/:id/events --------------------------------------------
  app.get("/v1/runs/:id/events", async (c) => {
    const id = c.req.param("id");
    const run = runManager.get(id);
    if (!run) {
      return c.json({ error: "run_not_found" }, 404);
    }
    const lastEventId = parseLastEventId(c.req.header("Last-Event-Id"));
    const streamer = await loadStreamer();
    // RunEntry in the live `RunManager` implementation carries `projectHash`
    // and `cwd` alongside the public shape. We consult them to derive the
    // JSONL transcript path for above-buffer replay in `streamRunEvents`.
    const { projectHash, cwd } = run as unknown as {
      projectHash?: string;
      cwd?: string;
    };
    const sessionLogPath = projectHash
      ? sessionPaths.sessionLog(projectHash, run.sessionId)
      : sessionPaths.sessionLog(hashFallback(cwd ?? ""), run.sessionId);

    return streamSSE(
      c,
      async (stream) => {
        await streamer({
          run,
          sessionLogPath,
          lastEventId,
          signal: c.req.raw.signal,
          stream,
          logger,
        });
      },
      async (err, stream) => {
        logger.error({ err, runId: id }, "SSE stream errored");
        await stream.close();
      },
    );
  });

  // --- POST /v1/runs/:id/steer --------------------------------------------
  app.post("/v1/runs/:id/steer", async (c) => {
    const id = c.req.param("id");
    const raw = await safeJson(c);
    const parsed = SteerBodySchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "bad_request", issues: parsed.error.issues }, 400);
    }

    const run = runManager.get(id);
    if (!run) {
      return c.json({ error: "run_not_found" }, 404);
    }
    if (run.status !== "running") {
      return c.json({ error: "run_terminal", status: run.status }, 409);
    }

    try {
      const accepted = runManager.steer(id, parsed.data.text);
      if (!accepted) {
        const fresh = runManager.get(id);
        if (!fresh) return c.json({ error: "run_not_found" }, 404);
        return c.json({ error: "run_terminal", status: fresh.status }, 409);
      }
      return c.json({}, 202);
    } catch (err) {
      if (err instanceof RunNotFoundError) return c.json({ error: "run_not_found" }, 404);
      if (err instanceof RunTerminalError) {
        return c.json({ error: "run_terminal", status: run.status }, 409);
      }
      logger.error({ err, runId: id }, "POST /v1/runs/:id/steer failed");
      return c.json({ error: "internal", message: errMessage(err) }, 500);
    }
  });

  // --- POST /v1/runs/:id/cancel -------------------------------------------
  app.post("/v1/runs/:id/cancel", (c) => {
    const id = c.req.param("id");
    const run = runManager.get(id);
    if (!run) {
      return c.json({ error: "run_not_found" }, 404);
    }
    try {
      runManager.cancel(id);
      return c.json({}, 202);
    } catch (err) {
      if (err instanceof RunNotFoundError) return c.json({ error: "run_not_found" }, 404);
      logger.error({ err, runId: id }, "POST /v1/runs/:id/cancel failed");
      return c.json({ error: "internal", message: errMessage(err) }, 500);
    }
  });

  // --- POST /v1/runs/:id/resume -------------------------------------------
  app.post("/v1/runs/:id/resume", async (c) => {
    const id = c.req.param("id");
    const raw = await safeJson(c);
    const parsed = ResumeBodySchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "bad_request", issues: parsed.error.issues }, 400);
    }
    const existing = runManager.get(id);
    if (!existing) {
      return c.json({ error: "run_not_found" }, 404);
    }
    try {
      const fresh = await runManager.resume(id, { prompt: parsed.data.prompt });
      return c.json({ runId: fresh.runId, sessionId: fresh.sessionId }, 201);
    } catch (err) {
      if (err instanceof RunNotFoundError) return c.json({ error: "run_not_found" }, 404);
      logger.error({ err, runId: id }, "POST /v1/runs/:id/resume failed");
      return c.json({ error: "internal", message: errMessage(err) }, 500);
    }
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

function hashFallback(cwd: string): string {
  return createHash("sha1").update(cwd).digest("hex").slice(0, 12);
}

function parseLastEventId(header: string | undefined): number | null {
  if (header === undefined || header.length === 0) return null;
  const n = Number.parseInt(header, 10);
  if (Number.isNaN(n) || n < 0) return null;
  return n;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
