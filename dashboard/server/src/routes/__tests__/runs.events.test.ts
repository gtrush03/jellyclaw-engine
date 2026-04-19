/**
 * Integration test for GET /api/runs/:id/events — the per-run SSE log tail.
 *
 * The previous implementation had three overlapping bugs that manifested as
 * the middle-pane log showing "CONNECTING... · 0 LINES" forever:
 *
 *   1. Client filtered event names to `log`/`message` but server pushed
 *      with name `log-line`.
 *   2. Handler returned `c.body(null)` immediately after wiring the
 *      watcher — Hono's node-adapter then called `writeHead(200)` on an
 *      already-committed SSE response (ERR_HTTP_HEADERS_SENT).
 *   3. Client URL helper required `runId` to contain `/` and threw for
 *      modern ids like `T0-02-serve-reads-credentials`.
 *
 * This suite exercises the wire format end-to-end against a real listening
 * server (better-sse needs raw Node req/res, which Hono's in-memory `app.fetch`
 * doesn't provide). We assert:
 *
 *   - 3 seeded lines arrive as `event: log` frames with `replay: true`
 *   - A subsequently-appended line arrives within 2s as a non-replay `log`
 *   - The stream does NOT crash with ERR_HTTP_HEADERS_SENT (we'd see the
 *     socket close immediately and miss the 4th line).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { AddressInfo } from "node:net";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createRunsRoute } from "../runs.js";
import type { RigState, RunRecord } from "../../types.js";

function makeRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    status: "working",
    tier: 1,
    session_id: "sess-events",
    tmux_session: "jc-sess-events",
    branch: "autobuild/sess-events",
    started_at: "2026-04-17T10:00:00Z",
    updated_at: "2026-04-17T10:05:00Z",
    ended_at: null,
    attempt: 1,
    max_retries: 3,
    turns_used: 4,
    cost_usd: 0.12,
    self_check: null,
    log_path: "",
    events_path: "",
    tests: { total: 0, passed: 0, failed: 0, pending: 0 },
    commit_sha: null,
    last_error: null,
    last_retry_reason: null,
    needs_review: false,
    retry_history: [],
    ...overrides,
  };
}

interface SSEFrame {
  event: string;
  data: string;
}

/**
 * Parse an SSE wire chunk into frames. Events are separated by a blank line;
 * within a frame, lines `event:` and `data:` map to their fields. Data fields
 * concatenate (per spec) — we keep the simple single-line case since our
 * pushes never emit multi-line data.
 */
function parseSSE(chunk: string): SSEFrame[] {
  const frames: SSEFrame[] = [];
  const blocks = chunk.split("\n\n");
  for (const block of blocks) {
    if (block.trim().length === 0) continue;
    let event = "message";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data = line.slice(5).trim();
    }
    if (data.length > 0) frames.push({ event, data });
  }
  return frames;
}

let tmpRoot: string;
let sessionsDir: string;
let httpServer: http.Server | null = null;
let baseUrl: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "jc-run-events-"));
  sessionsDir = path.join(tmpRoot, "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });
});

afterEach(async () => {
  if (httpServer) {
    await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
    httpServer = null;
  }
  await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
});

async function startTestServer(state: RigState): Promise<string> {
  const routes = createRunsRoute({
    sessionsDir,
    loadState: async (): Promise<RigState> => state,
    loadRigProcess: async () => ({
      running: false,
      pid: null,
      since: null,
      log_path: null,
    }),
  });
  const app = new Hono();
  app.route("/api", routes);

  httpServer = await new Promise<http.Server>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () =>
      resolve(s as unknown as http.Server),
    ) as unknown as http.Server;
  });
  const addr = httpServer.address() as AddressInfo;
  return `http://127.0.0.1:${addr.port}`;
}

describe("GET /api/runs/:id/events — SSE streaming", () => {
  it("replays 3 seeded lines then streams a 4th append in real time", async () => {
    const runId = "T0-02-serve-reads-credentials";
    const sessionId = "sess-events-1";
    const sessDir = path.join(sessionsDir, sessionId);
    await fs.mkdir(sessDir, { recursive: true });
    const logPath = path.join(sessDir, "tmux.log");
    await fs.writeFile(logPath, "line-1\nline-2\nline-3\n", "utf8");

    const state: RigState = {
      rig_heartbeat: null,
      rig_paused: false,
      runs: {
        [runId]: makeRecord({ session_id: sessionId, log_path: logPath }),
      },
    };
    baseUrl = await startTestServer(state);

    const ctrl = new AbortController();
    const res = await fetch(`${baseUrl}/api/runs/${runId}/events`, {
      headers: { accept: "text/event-stream" },
      signal: ctrl.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.body).not.toBeNull();

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const collected: SSEFrame[] = [];
    let carry = "";
    let pumpError: unknown = null;

    // Continuous background pump: drains frames into `collected` until the
    // reader naturally ends (we call `reader.cancel()` at teardown). Using a
    // background pump rather than interleaving `reader.read()` with timers
    // avoids the previous-version race where a per-read timeout aborted the
    // whole fetch between the replay and the live append.
    const pump = (async () => {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) return;
          carry += decoder.decode(value, { stream: true });
          const boundary = carry.lastIndexOf("\n\n");
          if (boundary === -1) continue;
          const complete = carry.slice(0, boundary + 2);
          carry = carry.slice(boundary + 2);
          for (const frame of parseSSE(complete)) {
            if (frame.event === "log") collected.push(frame);
          }
        }
      } catch (err) {
        // Reader cancelled by teardown — that's fine.
        pumpError = err;
      }
    })();

    const waitFor = async (target: number, timeoutMs: number): Promise<void> => {
      const deadline = Date.now() + timeoutMs;
      while (collected.length < target && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
    };

    try {
      // Step 1: the 3 seeded lines arrive as `event: log` with replay: true.
      await waitFor(3, 3000);
      expect(collected.length).toBeGreaterThanOrEqual(3);
      const seededLines = collected.slice(0, 3).map((f) => {
        const parsed = JSON.parse(f.data) as {
          line: string;
          runId: string;
          replay?: boolean;
        };
        return parsed;
      });
      expect(seededLines.map((p) => p.line)).toEqual(["line-1", "line-2", "line-3"]);
      expect(seededLines.every((p) => p.runId === runId)).toBe(true);
      expect(seededLines.every((p) => p.replay === true)).toBe(true);

      // Step 2: a 4th line appended to the file arrives live as a non-replay
      // `log` frame. Chokidar on macOS polls at ~100ms so 5s is ample.
      await fs.appendFile(logPath, "line-4\n", "utf8");
      await waitFor(4, 5000);
      expect(collected.length).toBeGreaterThanOrEqual(4);
      const liveFrame = JSON.parse(collected[3]!.data) as {
        line: string;
        replay?: boolean;
      };
      expect(liveFrame.line).toBe("line-4");
      expect(liveFrame.replay).toBeUndefined();
    } finally {
      await reader.cancel().catch(() => undefined);
      ctrl.abort();
      // Let the pump settle so we don't leak a hanging promise.
      await pump;
      expect(pumpError === null || typeof pumpError === "object").toBe(true);
    }
  }, 15_000);

  it("rejects an invalid run id with 400 before opening a stream", async () => {
    baseUrl = await startTestServer({
      rig_heartbeat: null,
      rig_paused: false,
      runs: {},
    });
    // Slashes in the id → rejected by the param regex.
    const res = await fetch(`${baseUrl}/api/runs/${encodeURIComponent("bad/id")}/events`);
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/json");
  });
});
