import { Hono } from "hono";
import chokidar, { type FSWatcher } from "chokidar";
import { createChannel, createSession, type Channel } from "better-sse";
import type { IncomingMessage, ServerResponse } from "node:http";
import { COMPLETION_LOG, PROMPTS_DIR, STATUS_FILE } from "../lib/paths.js";
import { classifyHeartbeat, diffRigState, loadRigState, watchRigState } from "../lib/rig-state.js";
import type { RigState, ServerEventName, ServerEventPayload } from "../types.js";

export const eventRoutes = new Hono();

// Single process-wide channel that multiplexes file-watch events to all clients.
const channel: Channel = createChannel();
let watchersStarted = false;
let watcherHandles: FSWatcher[] = [];
let heartbeatTimer: NodeJS.Timeout | null = null;
let rigStopFn: (() => Promise<void>) | null = null;
let rigHealthTimer: NodeJS.Timeout | null = null;
// Memoized previous state so we can diff on each update. Starts empty so the
// first event after boot always emits a full changed_run_ids list.
let lastRigState: RigState = { rig_heartbeat: null, rig_paused: false, runs: {} };
// Track heartbeat polarity so we only fire lost/recovered on edges, not every tick.
let heartbeatLost = false;

function broadcast(
  event: ServerEventName,
  filePath?: string,
  data?: Record<string, unknown>,
): void {
  const payload: ServerEventPayload = {
    event,
    at: new Date().toISOString(),
    ...(filePath ? { path: filePath } : {}),
    ...(data ? { data } : {}),
  };
  channel.broadcast(payload, event);
}

/**
 * Public broadcast helper for cross-route callers. `rig-control.ts` uses
 * this to emit a `reset` event so open dashboards auto-clear. Kept out of
 * the main module graph during construction to avoid a circular import —
 * `index.ts` wires the two together at boot.
 */
export function broadcastServerEvent(event: ServerEventName, data?: Record<string, unknown>): void {
  broadcast(event, undefined, data);
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

  // ---------- autobuild-rig watchers ----------
  // Every change to state.json → diff + emit `rig-state-changed`.
  // Every append to a session's tmux.log → `run-log-appended`.
  rigStopFn = watchRigState(async (ev) => {
    try {
      if (ev.kind === "state") {
        const next = await loadRigState();
        const diff = diffRigState(lastRigState, next);
        lastRigState = next;
        broadcast("rig-state-changed", undefined, {
          changed_run_ids: diff.changed_run_ids,
          new_statuses: diff.new_statuses,
          rig_paused: next.rig_paused,
          rig_heartbeat: next.rig_heartbeat,
        });
      } else {
        // `ev.kind === "log"`
        // Count lines lazily — the frontend only needs a trigger to re-fetch
        // the detail endpoint. We include lineCount best-effort for UIs that
        // want to show a growing counter without re-hitting the API.
        const fs = await import("node:fs/promises");
        let lineCount = 0;
        try {
          const raw = await fs.readFile(ev.path, "utf8");
          lineCount = raw.length === 0 ? 0 : raw.split("\n").length - (raw.endsWith("\n") ? 1 : 0);
        } catch {
          // file can disappear mid-read; ignore
        }
        broadcast("run-log-appended", ev.path, {
          runId: ev.runId,
          lineCount,
        });
      }
    } catch (err) {
      console.error("[events] rig update handler failed:", err);
    }
  });

  // Seed the memoized state + start the heartbeat-health poll.
  void loadRigState().then((s) => {
    lastRigState = s;
    heartbeatLost = classifyHeartbeat(s.rig_heartbeat ?? null) === "red";
  });

  // Heartbeat-staleness poll — 10s cadence keeps us well under the 30s
  // "amber" threshold while staying cheap. We only fire edge transitions.
  rigHealthTimer = setInterval(() => {
    void (async () => {
      try {
        const s = await loadRigState();
        const klass = classifyHeartbeat(s.rig_heartbeat ?? null);
        const stale = klass === "amber" || klass === "red";
        if (stale && !heartbeatLost) {
          heartbeatLost = true;
          broadcast("rig-heartbeat-lost", undefined, {
            rig_heartbeat: s.rig_heartbeat,
            heartbeat_status: klass,
          });
        } else if (!stale && heartbeatLost) {
          heartbeatLost = false;
          broadcast("rig-heartbeat-recovered", undefined, {
            rig_heartbeat: s.rig_heartbeat,
            heartbeat_status: klass,
          });
        }
      } catch (err) {
        console.error("[events] rig health poll failed:", err);
      }
    })();
  }, 10_000);
}

export async function stopWatchers(): Promise<void> {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (rigHealthTimer) {
    clearInterval(rigHealthTimer);
    rigHealthTimer = null;
  }
  if (rigStopFn) {
    await rigStopFn();
    rigStopFn = null;
  }
  await Promise.all(watcherHandles.map((w) => w.close()));
  watcherHandles = [];
  watchersStarted = false;
}

/**
 * SSE endpoint. Uses better-sse's session registered against the raw
 * req/res but resolves the handler Promise only when the client disconnects —
 * that way Hono's node-server adapter won't race us on `writeHead`.
 *
 * The previous implementation returned `c.body(null)` immediately after
 * hijacking, which caused Hono to call `writeHead(200)` on an already-
 * committed response, producing ERR_HTTP_HEADERS_SENT floods and a
 * cascading 500 loop on the client.
 */
eventRoutes.get("/events", async (c) => {
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

    // Hold the handler open until the socket closes. This prevents Hono's
    // node-server adapter from trying to call writeHead(200) on the already-
    // committed response.
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      res.once("close", done);
      res.once("finish", done);
      req.once("aborted", done);
    });
  } catch (err) {
    console.error("[GET /api/events] failed to open SSE:", err);
    if (!res.headersSent) {
      res.statusCode = 500;
    }
    if (res.writable && !res.writableEnded) {
      res.end();
    }
  }

  // Return a Response that Hono won't try to body-serialize; by the time we
  // get here the socket is already closed by the client or done().
  return c.body(null, 200);
});
