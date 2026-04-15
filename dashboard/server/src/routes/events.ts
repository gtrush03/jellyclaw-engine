import { Hono } from "hono";
import chokidar, { type FSWatcher } from "chokidar";
import { createChannel, createSession, type Channel } from "better-sse";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  COMPLETION_LOG,
  PROMPTS_DIR,
  STATUS_FILE,
} from "../lib/paths.js";
import type { ServerEventName, ServerEventPayload } from "../types.js";

export const eventRoutes = new Hono();

// Single process-wide channel that multiplexes file-watch events to all clients.
const channel: Channel = createChannel();
let watchersStarted = false;
let watcherHandles: FSWatcher[] = [];
let heartbeatTimer: NodeJS.Timeout | null = null;

function broadcast(event: ServerEventName, filePath?: string): void {
  const payload: ServerEventPayload = {
    event,
    at: new Date().toISOString(),
    ...(filePath ? { path: filePath } : {}),
  };
  channel.broadcast(payload, event);
}

export function startWatchers(): void {
  if (watchersStarted) return;
  watchersStarted = true;

  const logWatcher = chokidar.watch([COMPLETION_LOG, STATUS_FILE], {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    persistent: true,
  });
  logWatcher.on("change", (p) => {
    const which: ServerEventName =
      p === COMPLETION_LOG ? "completion-log-changed" : "status-changed";
    console.log(`[${new Date().toISOString()}] [watch] ${which} — ${p}`);
    broadcast(which, p);
  });
  logWatcher.on("error", (err) => {
    console.error("[watch] log watcher error:", err);
  });

  const promptWatcher = chokidar.watch(`${PROMPTS_DIR}/phase-*/*.md`, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    persistent: true,
  });
  promptWatcher.on("add", (p) => {
    console.log(`[${new Date().toISOString()}] [watch] prompt-added — ${p}`);
    broadcast("prompt-added", p);
  });
  promptWatcher.on("change", (p) => {
    console.log(`[${new Date().toISOString()}] [watch] prompt-changed — ${p}`);
    broadcast("prompt-changed", p);
  });
  promptWatcher.on("error", (err) => {
    console.error("[watch] prompt watcher error:", err);
  });

  watcherHandles = [logWatcher, promptWatcher];

  // 30-second heartbeat keeps proxies from closing idle SSE connections.
  heartbeatTimer = setInterval(() => {
    const payload: ServerEventPayload = {
      event: "heartbeat",
      at: new Date().toISOString(),
    };
    channel.broadcast(payload, "heartbeat");
  }, 30_000);
}

export async function stopWatchers(): Promise<void> {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  await Promise.all(watcherHandles.map((w) => w.close()));
  watcherHandles = [];
  watchersStarted = false;
}

/**
 * SSE endpoint. Pulls the raw Node req/res pair out of Hono's node-server context
 * and hands them to better-sse. We return an empty Response so Hono doesn't try
 * to write anything else to the socket.
 */
eventRoutes.get("/events", async (c) => {
  // @hono/node-server exposes these on c.env
  const env = c.env as {
    incoming?: IncomingMessage;
    outgoing?: ServerResponse;
  };
  const req = env.incoming;
  const res = env.outgoing;
  if (!req || !res) {
    return c.json({ error: "SSE requires Node adapter" }, 500);
  }

  try {
    const session = await createSession(req, res, {
      retry: 5_000,
      keepAlive: 15_000,
    });
    channel.register(session);
    session.push(
      { event: "heartbeat", at: new Date().toISOString() } satisfies ServerEventPayload,
      "heartbeat",
    );
  } catch (err) {
    console.error("[GET /api/events] failed to open SSE:", err);
    if (!res.headersSent) res.statusCode = 500;
    if (res.writable) res.end();
    return c.body(null);
  }

  // Tell Hono we've hijacked the response.
  return c.body(null);
});
