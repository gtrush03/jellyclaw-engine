/**
 * Unit tests for the `/runs` routes. We instantiate a fresh Hono app with
 * the factory so we can inject a temp inbox / sessions dir and a stub state
 * loader — no filesystem dependency on `.autobuild/` or `.orchestrator/`.
 *
 * These tests run fully offline (no listening server): we drive the app via
 * `app.fetch(new Request(...))`, the way Hono is intended to be tested.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { createRunsRoute } from "../../src/routes/runs.js";
import type { RigState, RunRecord } from "../../src/types.js";

function makeRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    status: "working",
    tier: 1,
    session_id: "sess-alpha",
    tmux_session: "jc-sess-alpha",
    branch: "autobuild/sess-alpha",
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

function mountApp(routes: Hono): Hono {
  const app = new Hono();
  app.route("/api", routes);
  return app;
}

let tmpRoot: string;
let inboxDir: string;
let sessionsDir: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "jc-runs-test-"));
  inboxDir = path.join(tmpRoot, "inbox");
  sessionsDir = path.join(tmpRoot, "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
});

describe("GET /api/runs — empty state", () => {
  it("returns 200 with an empty runs array + null heartbeat when state.json is missing", async () => {
    const routes = createRunsRoute({
      inboxDir,
      sessionsDir,
      loadState: async (): Promise<RigState> => ({
        rig_heartbeat: null,
        rig_paused: false,
        runs: {},
      }),
    });
    const app = mountApp(routes);
    const res = await app.fetch(new Request("http://test/api/runs"));
    expect(res.status).toBe(200);
    // New envelope: runs is a keyed Record (for O(1) frontend lookup);
    // runs_array is the sorted array for rendering.
    const body = (await res.json()) as {
      runs: Record<string, unknown>;
      runs_array: unknown[];
      count: number;
      rig_heartbeat: string | null;
      rig_paused: boolean;
      paused: boolean;
      halted: boolean;
      concurrency: number;
      daily_budget_usd: { spent: number; cap: number; day: string };
    };
    expect(body.runs).toEqual({});
    expect(body.runs_array).toEqual([]);
    expect(body.count).toBe(0);
    expect(body.rig_heartbeat).toBeNull();
    expect(body.rig_paused).toBe(false);
    expect(body.paused).toBe(false);
    expect(body.halted).toBe(false);
    expect(body.daily_budget_usd).toBeDefined();
    expect(body.daily_budget_usd.cap).toBe(25);
  });
});

describe("GET /api/runs — populated state", () => {
  it("returns 200 with runs sorted by updated_at desc + heartbeat metadata", async () => {
    const older = makeRecord({
      session_id: "a",
      updated_at: "2026-04-17T09:00:00Z",
      status: "complete",
    });
    const newer = makeRecord({
      session_id: "b",
      updated_at: "2026-04-17T10:00:00Z",
      status: "working",
    });
    const routes = createRunsRoute({
      inboxDir,
      sessionsDir,
      loadState: async (): Promise<RigState> => ({
        rig_heartbeat: "2026-04-17T10:06:00Z",
        rig_paused: false,
        runs: { "run-a": older, "run-b": newer },
      }),
    });
    const app = mountApp(routes);
    const res = await app.fetch(new Request("http://test/api/runs"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      runs: Record<string, { status: string; updated_at: string }>;
      runs_array: Array<{ id: string; status: string; updated_at: string }>;
      count: number;
      rig_heartbeat: string;
    };
    expect(body.count).toBe(2);
    // runs_array is sorted by updated_at desc (newer first)
    expect(body.runs_array[0]!.id).toBe("run-b");
    expect(body.runs_array[1]!.id).toBe("run-a");
    // runs dict exposes both entries keyed by id
    expect(Object.keys(body.runs).sort()).toEqual(["run-a", "run-b"]);
    expect(body.runs["run-a"]!.status).toBe("complete");
    expect(body.runs["run-b"]!.status).toBe("working");
    expect(body.rig_heartbeat).toBe("2026-04-17T10:06:00Z");
  });
});

describe("GET /api/runs/:id — not found", () => {
  it("returns 404 when the run id is absent from state", async () => {
    const routes = createRunsRoute({
      inboxDir,
      sessionsDir,
      loadState: async (): Promise<RigState> => ({
        rig_heartbeat: null,
        rig_paused: false,
        runs: { other: makeRecord() },
      }),
    });
    const app = mountApp(routes);
    const res = await app.fetch(new Request("http://test/api/runs/ghost-run"));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/not found/i);
  });

  it("rejects invalid run ids (path-traversal style) with 400", async () => {
    const routes = createRunsRoute({ inboxDir, sessionsDir });
    const app = mountApp(routes);
    const res = await app.fetch(new Request("http://test/api/runs/..%2Fetc"));
    // Hono decodes the segment before it reaches the handler; the resulting
    // id fails the character-class regex → 400.
    expect(res.status).toBe(400);
  });
});

describe("GET /api/runs/:id — found", () => {
  it("returns the record plus the last 500 lines of tmux.log", async () => {
    const runId = "demo-run";
    const sessionId = "demo-sess";
    const sessDir = path.join(sessionsDir, sessionId);
    await fs.mkdir(sessDir, { recursive: true });
    const logPath = path.join(sessDir, "tmux.log");
    const lines = Array.from({ length: 10 }, (_, i) => `line-${i}`);
    await fs.writeFile(logPath, lines.join("\n") + "\n", "utf8");

    const routes = createRunsRoute({
      inboxDir,
      sessionsDir,
      loadState: async (): Promise<RigState> => ({
        rig_heartbeat: "2026-04-17T10:06:00Z",
        rig_paused: false,
        runs: {
          [runId]: makeRecord({
            session_id: sessionId,
            log_path: logPath,
          }),
        },
      }),
    });
    const app = mountApp(routes);
    const res = await app.fetch(new Request(`http://test/api/runs/${runId}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      session_id: string;
      log: { lines: string[]; lineCount: number };
    };
    expect(body.id).toBe(runId);
    expect(body.session_id).toBe(sessionId);
    expect(body.log.lineCount).toBe(10);
    expect(body.log.lines[0]).toBe("line-0");
    expect(body.log.lines[9]).toBe("line-9");
  });

  it("caps tmux.log readback at 500 lines", async () => {
    const runId = "long-run";
    const sessionId = "long-sess";
    const sessDir = path.join(sessionsDir, sessionId);
    await fs.mkdir(sessDir, { recursive: true });
    const logPath = path.join(sessDir, "tmux.log");
    const lines = Array.from({ length: 800 }, (_, i) => `L${i}`);
    await fs.writeFile(logPath, lines.join("\n") + "\n", "utf8");
    const routes = createRunsRoute({
      inboxDir,
      sessionsDir,
      loadState: async (): Promise<RigState> => ({
        rig_heartbeat: null,
        rig_paused: false,
        runs: {
          [runId]: makeRecord({
            session_id: sessionId,
            log_path: logPath,
          }),
        },
      }),
    });
    const app = mountApp(routes);
    const res = await app.fetch(new Request(`http://test/api/runs/${runId}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      log: { lines: string[]; lineCount: number };
    };
    expect(body.log.lineCount).toBe(500);
    expect(body.log.lines[0]).toBe("L300"); // first kept line
    expect(body.log.lines[499]).toBe("L799");
  });
});

describe("POST /api/runs/:id/action", () => {
  it("writes a well-formed JSON file to the inbox and returns 202", async () => {
    const runId = "target-run";
    const routes = createRunsRoute({
      inboxDir,
      sessionsDir,
      loadState: async (): Promise<RigState> => ({
        rig_heartbeat: null,
        rig_paused: false,
        runs: { [runId]: makeRecord() },
      }),
    });
    const app = mountApp(routes);
    const res = await app.fetch(
      new Request(`http://test/api/runs/${runId}/action`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "abort", note: "user-requested" }),
      }),
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as { queued: boolean; filename: string };
    expect(body.queued).toBe(true);
    expect(body.filename).toMatch(/-abort\.json$/);

    const files = await fs.readdir(inboxDir);
    expect(files).toHaveLength(1);
    const written = await fs.readFile(path.join(inboxDir, files[0]), "utf8");
    const parsed = JSON.parse(written) as {
      cmd: string;
      target: string;
      by: string;
      note?: string;
      ts: string;
    };
    expect(parsed.cmd).toBe("abort");
    expect(parsed.target).toBe(runId);
    expect(parsed.by).toBe("dashboard");
    expect(parsed.note).toBe("user-requested");
    expect(typeof parsed.ts).toBe("string");
    expect(new Date(parsed.ts).toString()).not.toBe("Invalid Date");
  });

  it("rejects unknown action with 400", async () => {
    const routes = createRunsRoute({ inboxDir, sessionsDir });
    const app = mountApp(routes);
    const res = await app.fetch(
      new Request("http://test/api/runs/any/action", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "nuke-everything" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects non-JSON body with 400", async () => {
    const routes = createRunsRoute({ inboxDir, sessionsDir });
    const app = mountApp(routes);
    const res = await app.fetch(
      new Request("http://test/api/runs/any/action", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not json",
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /api/rig/status", () => {
  it("classifies a fresh heartbeat as 'fresh'", async () => {
    const routes = createRunsRoute({
      inboxDir,
      sessionsDir,
      loadState: async (): Promise<RigState> => ({
        rig_heartbeat: new Date().toISOString(),
        rig_paused: false,
        runs: {},
      }),
    });
    const app = mountApp(routes);
    const res = await app.fetch(new Request("http://test/api/rig/status"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      heartbeat_status: string;
      run_count: number;
    };
    expect(body.heartbeat_status).toBe("fresh");
    expect(body.run_count).toBe(0);
  });

  it("classifies a 2-minute-old heartbeat as 'amber'", async () => {
    const twoMinAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const routes = createRunsRoute({
      inboxDir,
      sessionsDir,
      loadState: async (): Promise<RigState> => ({
        rig_heartbeat: twoMinAgo,
        rig_paused: false,
        runs: {},
      }),
    });
    const app = mountApp(routes);
    const res = await app.fetch(new Request("http://test/api/rig/status"));
    const body = (await res.json()) as { heartbeat_status: string };
    expect(body.heartbeat_status).toBe("amber");
  });

  it("classifies a 10-minute-old heartbeat as 'red'", async () => {
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const routes = createRunsRoute({
      inboxDir,
      sessionsDir,
      loadState: async (): Promise<RigState> => ({
        rig_heartbeat: tenMinAgo,
        rig_paused: false,
        runs: {},
      }),
    });
    const app = mountApp(routes);
    const res = await app.fetch(new Request("http://test/api/rig/status"));
    const body = (await res.json()) as { heartbeat_status: string };
    expect(body.heartbeat_status).toBe("red");
  });

  it("classifies a null heartbeat as 'never'", async () => {
    const routes = createRunsRoute({
      inboxDir,
      sessionsDir,
      loadState: async (): Promise<RigState> => ({
        rig_heartbeat: null,
        rig_paused: false,
        runs: {},
      }),
    });
    const app = mountApp(routes);
    const res = await app.fetch(new Request("http://test/api/rig/status"));
    const body = (await res.json()) as { heartbeat_status: string };
    expect(body.heartbeat_status).toBe("never");
  });
});
