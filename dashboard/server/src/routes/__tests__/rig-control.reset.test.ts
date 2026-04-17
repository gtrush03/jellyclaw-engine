/**
 * Unit tests for POST /api/rig/reset.
 *
 * Strategy: identical to the sibling rig-control.test.ts — each test gets a
 * fresh tmpdir so real `.autobuild/` / `.orchestrator/` are never touched.
 * We assemble a minimal fixture (state.json + sessions/<uuid>/... +
 * queue.json) then POST and assert the disk + response shape.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { createRigControlRoute } from "../rig-control.js";

function mountApp(routes: Hono): Hono {
  const app = new Hono();
  app.route("/api", routes);
  return app;
}

let tmpRoot: string;
let pidFile: string;
let logFile: string;
let autobuildDir: string;
let stateFile: string;
let sessionsDir: string;
let queueFile: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "jc-rig-reset-"));
  pidFile = path.join(tmpRoot, "dispatcher.pid");
  logFile = path.join(tmpRoot, "dispatcher.jsonl");
  autobuildDir = path.join(tmpRoot, ".autobuild");
  stateFile = path.join(autobuildDir, "state.json");
  sessionsDir = path.join(autobuildDir, "sessions");
  queueFile = path.join(autobuildDir, "queue.json");
  await fs.mkdir(sessionsDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true }).catch(
    () => undefined,
  );
});

// Small fixture helper — writes a populated state.json that mimics the real
// shape after a few T0 prompts have run.
async function writePopulatedState(): Promise<void> {
  const state = {
    rig_version: "0.1.0",
    rig_heartbeat: "2026-04-17T08:14:39.255Z",
    concurrency: 2,
    paused: false,
    halted: true,
    daily_budget_usd: {
      spent: 5.07,
      cap: 42,
      day: "2026-04-17",
    },
    runs: {
      "T0-02-serve-reads-credentials": {
        status: "complete",
        tier: 0,
        cost_usd: 1.25,
      },
    },
    completed: ["T0-02-serve-reads-credentials"],
    escalated: ["T0-03-fix-hardcoded-model-id"],
    queue: [],
  };
  await fs.writeFile(stateFile, JSON.stringify(state, null, 2), "utf8");
}

// Populate a couple of per-session dirs so the wipe assertion has something
// to find.
async function writePopulatedSessions(): Promise<string[]> {
  const a = path.join(sessionsDir, "sess-aaaa");
  const b = path.join(sessionsDir, "sess-bbbb");
  await fs.mkdir(a, { recursive: true });
  await fs.mkdir(b, { recursive: true });
  await fs.writeFile(path.join(a, "events.ndjson"), "line1\n", "utf8");
  await fs.writeFile(path.join(b, "tmux.log"), "stuff\n", "utf8");
  return [a, b];
}

async function writeQueue(): Promise<void> {
  await fs.writeFile(
    queueFile,
    JSON.stringify(
      {
        queue: [
          "T1-01-cap-tool-output-bytes",
          "T1-02-handle-max-tokens-stop-reason",
        ],
      },
      null,
      2,
    ),
    "utf8",
  );
}

describe("POST /api/rig/reset", () => {
  it("returns 409 when the rig is running", async () => {
    await writePopulatedState();
    await writePopulatedSessions();
    await writeQueue();

    // Point the pid file at the test process itself — guaranteed alive, so
    // `/rig/running` will report running=true.
    await fs.writeFile(
      pidFile,
      JSON.stringify({
        pid: process.pid,
        since: "2026-04-17T08:00:00Z",
        started_by: "dashboard",
      }),
      "utf8",
    );

    const routes = createRigControlRoute({
      pidFile,
      logFile,
      autobuildBin: "/usr/bin/true",
      stateFile,
      sessionsDir,
      nowIso: () => "2026-04-17T09:00:00.000Z",
    });
    const app = mountApp(routes);

    const res = await app.fetch(
      new Request("http://test/api/rig/reset", { method: "POST" }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("rig_running");
    expect(body.message).toBe("Stop the rig before resetting.");

    // State and sessions must NOT have been touched.
    const stateRaw = await fs.readFile(stateFile, "utf8");
    expect(JSON.parse(stateRaw).halted).toBe(true);
    const sessionEntries = await fs.readdir(sessionsDir);
    expect(sessionEntries.sort()).toEqual(["sess-aaaa", "sess-bbbb"]);
    // Queue must be preserved too.
    const queueRaw = await fs.readFile(queueFile, "utf8");
    expect(JSON.parse(queueRaw).queue).toHaveLength(2);
  });

  it("returns 200, writes empty skeleton, wipes sessions, preserves queue.json", async () => {
    await writePopulatedState();
    const [sessionA, sessionB] = await writePopulatedSessions();
    await writeQueue();

    const broadcastCalls: Array<Record<string, unknown>> = [];

    const routes = createRigControlRoute({
      pidFile,
      logFile,
      autobuildBin: "/usr/bin/true",
      stateFile,
      sessionsDir,
      nowIso: () => "2026-04-17T09:00:00.000Z",
      broadcastReset: (data) => broadcastCalls.push(data),
    });
    const app = mountApp(routes);

    const res = await app.fetch(
      new Request("http://test/api/rig/reset", { method: "POST" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; reset_at: string };
    expect(body.ok).toBe(true);
    expect(body.reset_at).toBe("2026-04-17T09:00:00.000Z");

    // state.json matches the empty skeleton exactly.
    const stateRaw = await fs.readFile(stateFile, "utf8");
    const parsed = JSON.parse(stateRaw) as Record<string, unknown>;
    expect(parsed).toEqual({
      rig_version: "0.1.0",
      rig_heartbeat: "2026-04-17T09:00:00.000Z",
      // Preserved from existing state.
      concurrency: 2,
      paused: false,
      halted: false,
      daily_budget_usd: {
        spent: 0,
        // Preserved cap from existing state.
        cap: 42,
        day: "2026-04-17",
      },
      runs: {},
      completed: [],
      escalated: [],
      queue: [],
    });

    // sessions/* per-session dirs must be gone.
    await expect(fs.access(sessionA)).rejects.toBeTruthy();
    await expect(fs.access(sessionB)).rejects.toBeTruthy();
    // The sessions/ root itself remains (so the rig can repopulate it).
    const sessionsRootStat = await fs.stat(sessionsDir);
    expect(sessionsRootStat.isDirectory()).toBe(true);
    const sessionEntries = await fs.readdir(sessionsDir);
    expect(sessionEntries).toHaveLength(0);

    // queue.json preserved byte-for-byte.
    const queueRaw = await fs.readFile(queueFile, "utf8");
    const queueParsed = JSON.parse(queueRaw) as { queue: string[] };
    expect(queueParsed.queue).toEqual([
      "T1-01-cap-tool-output-bytes",
      "T1-02-handle-max-tokens-stop-reason",
    ]);

    // Reset broadcast fired exactly once with the reset_at field.
    expect(broadcastCalls).toHaveLength(1);
    expect(broadcastCalls[0]).toEqual({ reset_at: "2026-04-17T09:00:00.000Z" });
  });

  it("still returns 200 and writes a skeleton when state.json is missing", async () => {
    // Deliberately skip writePopulatedState — only the sessions dir exists.
    const [sessionA] = await writePopulatedSessions();

    const routes = createRigControlRoute({
      pidFile,
      logFile,
      autobuildBin: "/usr/bin/true",
      stateFile,
      sessionsDir,
      nowIso: () => "2026-04-17T10:00:00.000Z",
    });
    const app = mountApp(routes);

    const res = await app.fetch(
      new Request("http://test/api/rig/reset", { method: "POST" }),
    );
    expect(res.status).toBe(200);

    const stateRaw = await fs.readFile(stateFile, "utf8");
    const parsed = JSON.parse(stateRaw) as {
      rig_version: string;
      concurrency: number;
      daily_budget_usd: { cap: number; spent: number };
      runs: Record<string, unknown>;
      queue: unknown[];
    };
    // Falls back to conservative defaults.
    expect(parsed.rig_version).toBe("0.1.0");
    expect(parsed.concurrency).toBe(1);
    expect(parsed.daily_budget_usd.cap).toBe(25);
    expect(parsed.daily_budget_usd.spent).toBe(0);
    expect(parsed.runs).toEqual({});
    expect(parsed.queue).toEqual([]);

    await expect(fs.access(sessionA)).rejects.toBeTruthy();
  });

  it("returns 400 on a malformed JSON body", async () => {
    await writePopulatedState();

    const routes = createRigControlRoute({
      pidFile,
      logFile,
      autobuildBin: "/usr/bin/true",
      stateFile,
      sessionsDir,
      nowIso: () => "2026-04-17T09:00:00.000Z",
    });
    const app = mountApp(routes);

    const res = await app.fetch(
      new Request("http://test/api/rig/reset", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not valid json",
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("bad_request");
  });
});
