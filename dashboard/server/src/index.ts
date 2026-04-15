import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { promptRoutes } from "./routes/prompts.js";
import { phaseRoutes } from "./routes/phases.js";
import { statusRoutes } from "./routes/status.js";
import { eventRoutes, startWatchers, stopWatchers } from "./routes/events.js";

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

// ---------- in-memory rate limit (100 req / min / IP) ----------
interface Bucket {
  count: number;
  resetAt: number;
}
const buckets = new Map<string, Bucket>();
const WINDOW_MS = 60_000;
const LIMIT = 100;

app.use("*", async (c, next) => {
  // Trust the socket address; we're bound to 127.0.0.1 so X-Forwarded-For is not used.
  const env = c.env as {
    incoming?: { socket?: { remoteAddress?: string } };
  };
  const ip = env.incoming?.socket?.remoteAddress ?? "unknown";
  const now = Date.now();
  let bucket = buckets.get(ip);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + WINDOW_MS };
    buckets.set(ip, bucket);
  }
  bucket.count++;
  if (bucket.count > LIMIT) {
    const retry = Math.ceil((bucket.resetAt - now) / 1000);
    c.header("Retry-After", String(retry));
    return c.json({ error: "rate limit exceeded" }, 429);
  }
  await next();
  return;
});

// ---------- CORS (allow-list only; no wildcard) ----------
app.use(
  "*",
  cors({
    origin: ["http://127.0.0.1:5173", "http://localhost:5173"],
    allowMethods: ["GET", "HEAD", "OPTIONS"],
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
  await stopWatchers();
  server.close(() => process.exit(0));
  // Hard exit if close hangs
  setTimeout(() => process.exit(1), 5_000).unref();
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
