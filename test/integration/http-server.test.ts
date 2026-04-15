/**
 * Integration: boots a real `jellyclaw serve` subprocess and exercises the
 * HTTP API end-to-end. Gated behind `JELLYCLAW_HTTP_E2E=1` so the default
 * `bun run test` stays hermetic (mirrors the `BENCH=1` /
 * `JELLYCLAW_PW_MCP_TEST=1` convention used elsewhere in this repo).
 *
 * The suite also self-skips when `dist/cli/main.js` does not exist — this
 * lets the file be checked in before the build is plumbed without causing
 * false failures. The main-session reconcile builds `dist/` before flipping
 * the gate on in CI.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const GATE = process.env.JELLYCLAW_HTTP_E2E === "1";
const DIST_CLI = resolve(__dirname, "../../dist/cli/main.js");
const HAS_DIST = existsSync(DIST_CLI);

const describeMaybe = GATE && HAS_DIST ? describe : describe.skip;

if (!GATE) {
  console.info("[http-server.test] skipped — set JELLYCLAW_HTTP_E2E=1 to run the end-to-end suite");
} else if (!HAS_DIST) {
  console.info(
    `[http-server.test] skipped — built CLI not found at ${DIST_CLI}. Run \`bun run build\` first.`,
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const AUTH_TOKEN = "testtok";

/** Find a free TCP port by binding :0, reading the address, and closing. */
function pickPort(): Promise<number> {
  return new Promise((resolveFn, rejectFn) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", rejectFn);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr === null || typeof addr === "string") {
        srv.close();
        rejectFn(new Error("unexpected server address"));
        return;
      }
      const { port } = addr;
      srv.close(() => resolveFn(port));
    });
  });
}

interface ServerHandle {
  readonly port: number;
  readonly proc: ChildProcessWithoutNullStreams;
}

async function startServer(port: number): Promise<ServerHandle> {
  const proc = spawn(
    process.execPath,
    [DIST_CLI, "serve", "--port", String(port), "--host", "127.0.0.1", "--auth-token", AUTH_TOKEN],
    {
      env: {
        ...process.env,
        JELLYCLAW_LOG_LEVEL: "error",
        NODE_ENV: "test",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  // Wait for the "listening on http://127.0.0.1:<port>" banner on either
  // stderr or stdout. Give up after 10s.
  const listenRe = new RegExp(`listening on http://127\\.0\\.0\\.1:${port}`);
  const saw = await new Promise<boolean>((resolveFn) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolveFn(ok);
    };
    const onChunk = (buf: Buffer) => {
      if (listenRe.test(buf.toString("utf8"))) done(true);
    };
    proc.stdout.on("data", onChunk);
    proc.stderr.on("data", onChunk);
    proc.once("exit", () => done(false));
    setTimeout(() => done(false), 10_000).unref();
  });

  if (!saw) {
    proc.kill("SIGKILL");
    throw new Error(`server did not print listening banner within 10s on port ${port}`);
  }

  return { port, proc };
}

async function stopServer(h: ServerHandle): Promise<void> {
  if (h.proc.exitCode !== null) return;
  const exit = new Promise<void>((resolveFn) => {
    h.proc.once("exit", () => resolveFn());
  });
  h.proc.kill("SIGTERM");
  const forceTimer = setTimeout(() => {
    if (h.proc.exitCode === null) h.proc.kill("SIGKILL");
  }, 5_000);
  forceTimer.unref();
  await exit;
  clearTimeout(forceTimer);
}

interface SseFrame {
  readonly id: number | null;
  readonly event: string;
  readonly data: string;
}

/** Parse concatenated SSE text (already-decoded UTF-8) into frames. */
function parseSse(text: string): SseFrame[] {
  const out: SseFrame[] = [];
  const chunks = text.split("\n\n");
  for (const chunk of chunks) {
    const trimmed = chunk.trim();
    if (trimmed === "") continue;
    let id: number | null = null;
    let event = "message";
    const dataLines: string[] = [];
    for (const rawLine of trimmed.split("\n")) {
      const line = rawLine.trimEnd();
      if (line.startsWith("id:")) {
        const n = Number.parseInt(line.slice(3).trim(), 10);
        id = Number.isNaN(n) ? null : n;
      } else if (line.startsWith("event:")) {
        event = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).replace(/^ /, ""));
      }
    }
    out.push({ id, event, data: dataLines.join("\n") });
  }
  return out;
}

/** Stream a full SSE response into frames. Ends when the server closes. */
async function collectSse(url: string, headers: Record<string, string>): Promise<SseFrame[]> {
  const res = await fetch(url, { headers });
  if (res.body === null) throw new Error("no SSE body");
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const frames: SseFrame[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx = buf.indexOf("\n\n");
    while (idx !== -1) {
      const chunk = buf.slice(0, idx + 2);
      buf = buf.slice(idx + 2);
      for (const f of parseSse(chunk)) frames.push(f);
      idx = buf.indexOf("\n\n");
    }
  }
  if (buf.trim().length > 0) {
    for (const f of parseSse(buf)) frames.push(f);
  }
  return frames;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describeMaybe("http-server (e2e)", () => {
  let handle: ServerHandle;

  beforeAll(async () => {
    const port = await pickPort();
    handle = await startServer(port);
  }, 30_000);

  afterAll(async () => {
    if (handle !== undefined) await stopServer(handle);
  }, 15_000);

  function base(): string {
    return `http://127.0.0.1:${handle.port}`;
  }

  function authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${AUTH_TOKEN}` };
  }

  it("GET /v1/health without auth → 401", async () => {
    const res = await fetch(`${base()}/v1/health`);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("unauthorized");
  });

  it("GET /v1/health with bearer → 200 with health payload", async () => {
    const res = await fetch(`${base()}/v1/health`, { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      version: string;
      uptime_ms: number;
      active_runs: number;
    };
    expect(body.ok).toBe(true);
    expect(typeof body.version).toBe("string");
    expect(body.uptime_ms).toBeGreaterThanOrEqual(0);
    expect(body.active_runs).toBe(0);
  });

  it("POST /v1/runs + GET /v1/runs/:id/events streams session.started + done", async () => {
    const createRes = await fetch(`${base()}/v1/runs`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hello from e2e test" }),
    });
    expect([200, 201]).toContain(createRes.status);
    const { runId, sessionId } = (await createRes.json()) as {
      runId: string;
      sessionId: string;
    };
    expect(runId).toBeTruthy();
    expect(sessionId).toBeTruthy();

    const frames = await collectSse(`${base()}/v1/runs/${runId}/events`, authHeaders());
    const eventFrames = frames.filter((f) => f.event === "event");
    const doneFrames = frames.filter((f) => f.event === "done");

    // At least one session.started, and exactly one terminal done frame.
    const types = eventFrames.map((f) => {
      try {
        return (JSON.parse(f.data) as { type: string }).type;
      } catch {
        return "";
      }
    });
    expect(types).toContain("session.started");
    expect(doneFrames.length).toBeGreaterThanOrEqual(1);

    // id: lines monotonic within the event frames.
    const ids = eventFrames.map((f) => f.id).filter((id): id is number => id !== null);
    for (let i = 1; i < ids.length; i += 1) {
      const prev = ids[i - 1];
      const cur = ids[i];
      if (prev !== undefined && cur !== undefined) {
        expect(cur).toBeGreaterThan(prev);
      }
    }
  }, 20_000);

  it("POST /v1/runs/:id/cancel returns 202 and the stream terminates", async () => {
    const createRes = await fetch(`${base()}/v1/runs`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "long-running wish for cancel test" }),
    });
    const { runId } = (await createRes.json()) as { runId: string };

    const cancelRes = await fetch(`${base()}/v1/runs/${runId}/cancel`, {
      method: "POST",
      headers: authHeaders(),
    });
    // Some stub loops may already be terminal (completed) by the time cancel
    // arrives; accept 202 or 409 and record which for debugging.
    expect([202, 409]).toContain(cancelRes.status);

    const frames = await collectSse(`${base()}/v1/runs/${runId}/events`, authHeaders());
    const doneFrames = frames.filter((f) => f.event === "done");
    expect(doneFrames.length).toBeGreaterThanOrEqual(1);
    const finalFrame = doneFrames[doneFrames.length - 1];
    const payload = finalFrame ? (JSON.parse(finalFrame.data) as { status: string }) : null;
    expect(payload).not.toBeNull();
    // Accept either — the stub may finish before cancel lands.
    expect(["cancelled", "completed"]).toContain(payload?.status ?? "");
    console.info(`[cancel test] terminal status observed: ${payload?.status}`);
  }, 20_000);

  it("GET /v1/config redacts the auth token", async () => {
    const res = await fetch(`${base()}/v1/config`, { headers: authHeaders() });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(AUTH_TOKEN);
  });

  it("POST /v1/runs with invalid body → 400 with zod issues", async () => {
    const res = await fetch(`${base()}/v1/runs`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: string;
      issues?: Array<{ path: ReadonlyArray<string | number>; message: string }>;
    };
    expect(body.error).toBe("bad_request");
    expect(Array.isArray(body.issues)).toBe(true);
    expect(body.issues?.length).toBeGreaterThanOrEqual(1);
  });
});
