import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { promptRoutes } from "./routes/prompts.js";
import { phaseRoutes } from "./routes/phases.js";
import { statusRoutes } from "./routes/status.js";
import {
  eventRoutes,
  startWatchers,
  stopWatchers,
  broadcastServerEvent,
} from "./routes/events.js";
import { runRoutes } from "./routes/runs.js";
import {
  createRigControlRoute,
  startHeartbeatMonitor,
  stopTrackedChildOnShutdown,
} from "./routes/rig-control.js";
import { loadRigState } from "./lib/rig-state.js";

const app = new Hono();

// ---------- logging middleware ----------
app.use("*", async (c, next) => {
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  const ts = new Date().toISOString();
  console.log(
    `[${ts}] ${c.req.method} ${c.req.path} → ${c.res.status} ${ms}ms`,
  );
});

// ---------- rate limit: DISABLED ----------
// Previously a 100 req/min bucket middleware here. Removed because:
//   1. The server binds to 127.0.0.1 only — no hostile adversary to limit.
//   2. The autobuild-v3 page legitimately polls many endpoints (runs, status,
//      prompts, rig/running) + holds an open SSE stream; the counter filled
//      constantly and produced 429 spam.
//   3. Mixing rate-limit `writeHead(429)` with in-flight SSE streams produced
//      ERR_HTTP_HEADERS_SENT crashes on /api/events.
// If exposing beyond loopback later, restore with exemption for SSE routes.

// ---------- CORS (allow-list only; no wildcard) ----------
app.use(
  "*",
  cors({
    origin: ["http://127.0.0.1:5173", "http://localhost:5173"],
    // POST is required for /api/runs/:id/action — the only write endpoint the
    // dashboard exposes. Writes go to `.orchestrator/inbox/` only; we never
    // mutate rig-owned state.
    allowMethods: ["GET", "HEAD", "OPTIONS", "POST"],
    allowHeaders: ["Content-Type"],
    credentials: false,
    maxAge: 600,
  }),
);

// ---------- health ----------
app.get("/healthz", (c) => c.json({ ok: true, ts: new Date().toISOString() }));

// ---------- API routes ----------
app.route("/api", promptRoutes);
app.route("/api", phaseRoutes);
app.route("/api", statusRoutes);
app.route("/api", eventRoutes);
app.route("/api", runRoutes);
// Construct rig-control with a broadcaster wired to the SSE channel so a
// successful /rig/reset emits a `reset` event to every open dashboard.
app.route(
  "/api",
  createRigControlRoute({
    broadcastReset: (data) => broadcastServerEvent("reset", data),
  }),
);

// ---------- static frontend (production) ----------
// Frontend sibling agent builds to ../dist (dashboard/dist)
app.use(
  "/*",
  serveStatic({
    root: "../dist",
  }),
);
// SPA fallback: any unmatched non-/api path returns index.html
app.get("/*", async (c) => {
  if (c.req.path.startsWith("/api")) {
    return c.json({ error: "not found" }, 404);
  }
  const indexHandler = serveStatic({ root: "../dist", path: "index.html" });
  return indexHandler(c, async () => undefined);
});

// ---------- boot ----------
const PORT = Number(process.env.PORT ?? 5174);
const HOST = "127.0.0.1"; // local-only, never bind 0.0.0.0

if (process.env.HOST && process.env.HOST !== "127.0.0.1") {
  console.warn(
    `[boot] refusing HOST override '${process.env.HOST}' — forcing 127.0.0.1 (local-only policy)`,
  );
}

startWatchers();

// Heartbeat monitor: every 5s, if our dispatcher pid is alive but its heartbeat
// in .autobuild/state.json is >30s stale → warn. If the pid is dead → scrub
// the pid file.
const stopHeartbeatMonitor = startHeartbeatMonitor({
  loadHeartbeatMs: async () => {
    const s = await loadRigState();
    if (!s.rig_heartbeat) return null;
    const t = Date.parse(s.rig_heartbeat);
    return Number.isNaN(t) ? null : t;
  },
});

const server = serve(
  {
    fetch: app.fetch,
    port: PORT,
    hostname: HOST,
  },
  (info) => {
    console.log(
      `🧞 Jellyclaw Dashboard API listening on http://${info.address}:${info.port}`,
    );
  },
);

async function shutdown(signal: string): Promise<void> {
  console.log(`[${new Date().toISOString()}] received ${signal}, shutting down`);
  stopHeartbeatMonitor();
  await stopWatchers();
  // SIGTERM our tracked dispatcher child (if we started one) before closing
  // the HTTP server. If we didn't spawn a child this is a no-op.
  await stopTrackedChildOnShutdown();
  server.close(() => process.exit(0));
  // Hard exit if close hangs
  setTimeout(() => process.exit(1), 5_000).unref();
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
