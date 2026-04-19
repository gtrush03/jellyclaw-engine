/**
 * Unit tests for the /rig lifecycle routes.
 *
 * Strategy:
 *   - Each test gets a fresh temp dir for pid-file + log-file so real
 *     `.orchestrator/dispatcher.pid` is never touched.
 *   - We inject a fake `spawnFn` that launches a real `/bin/sh` child
 *     running `sleep 60` (for the start/stop live-process test), or a
 *     stubbed child that prints JSON (for the tick test).
 *   - For the "already running" 409 check we write a pid file pointing
 *     at the current test process itself (guaranteed alive), which avoids
 *     needing to spawn anything.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, type SpawnOptions } from "node:child_process";
import { Hono } from "hono";
import { createRigControlRoute } from "../../src/routes/rig-control.js";

function mountApp(routes: Hono): Hono {
  const app = new Hono();
  app.route("/api", routes);
  return app;
}

let tmpRoot: string;
let pidFile: string;
let logFile: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "jc-rig-test-"));
  pidFile = path.join(tmpRoot, "dispatcher.pid");
  logFile = path.join(tmpRoot, "dispatcher.jsonl");
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

async function waitUntil(pred: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return pred();
}

describe("GET /api/rig/running", () => {
  it("returns running=false when no pid file exists", async () => {
    const routes = createRigControlRoute({
      pidFile,
      logFile,
      autobuildBin: "/usr/bin/true",
    });
    const app = mountApp(routes);
    const res = await app.fetch(new Request("http://test/api/rig/running"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      running: boolean;
      pid: number | null;
    };
    expect(body.running).toBe(false);
    expect(body.pid).toBeNull();
  });

  it("cleans up a stale pid file pointing at a dead process", async () => {
    // Pid 1 is always init on unix — we use 2^31-1 (INT32_MAX) which is
    // effectively guaranteed to not exist and isn't a real init target.
    const ghostPid = 2_147_483_600; // very unlikely to exist
    // Skip this test if that pid happens to be alive on this host (extremely
    // rare; belt-and-braces).
    if (isAlive(ghostPid)) return;

    await fs.writeFile(
      pidFile,
      JSON.stringify({
        pid: ghostPid,
        since: "2026-04-17T01:00:00Z",
        started_by: "dashboard",
      }),
      "utf8",
    );
    const routes = createRigControlRoute({
      pidFile,
      logFile,
      autobuildBin: "/usr/bin/true",
    });
    const app = mountApp(routes);
    const res = await app.fetch(new Request("http://test/api/rig/running"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { running: boolean };
    expect(body.running).toBe(false);
    // File should have been cleaned up on the fly.
    await expect(fs.access(pidFile)).rejects.toBeTruthy();
  });
});

describe("POST /api/rig/start", () => {
  it("spawns a detached child, writes pid file, and returns 201", async () => {
    // Use /bin/sh to run `sleep 60` — gives us a real pid to probe + kill.
    const spawnFn: typeof spawn = (cmd, args, options) => {
      // Ignore whatever path the route tried to use; we want a portable sleep.
      return spawn("/bin/sh", ["-c", "sleep 60"], options as SpawnOptions);
    };

    const routes = createRigControlRoute({
      pidFile,
      logFile,
      autobuildBin: "/usr/bin/true",
      spawnFn,
    });
    const app = mountApp(routes);

    const res = await app.fetch(new Request("http://test/api/rig/start", { method: "POST" }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      running: boolean;
      pid: number;
      since: string;
      log_path: string;
    };
    expect(body.running).toBe(true);
    expect(typeof body.pid).toBe("number");
    expect(isAlive(body.pid)).toBe(true);

    // pid file should exist and contain the same pid.
    const raw = await fs.readFile(pidFile, "utf8");
    const parsed = JSON.parse(raw) as { pid: number };
    expect(parsed.pid).toBe(body.pid);

    // cleanup: kill the sleep
    try {
      process.kill(body.pid, "SIGKILL");
    } catch {
      // ignore
    }
    await waitUntil(() => !isAlive(body.pid));
  });

  it("returns 409 when a live pid file already exists", async () => {
    // Use the current process pid — guaranteed alive for the test duration.
    await fs.writeFile(
      pidFile,
      JSON.stringify({
        pid: process.pid,
        since: "2026-04-17T01:00:00Z",
        started_by: "dashboard",
      }),
      "utf8",
    );

    const routes = createRigControlRoute({
      pidFile,
      logFile,
      autobuildBin: "/usr/bin/true",
    });
    const app = mountApp(routes);

    const res = await app.fetch(new Request("http://test/api/rig/start", { method: "POST" }));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; pid: number };
    expect(body.error).toBe("already_running");
    expect(body.pid).toBe(process.pid);
  });
});

describe("POST /api/rig/stop", () => {
  it("returns not_running when no pid file exists", async () => {
    const routes = createRigControlRoute({
      pidFile,
      logFile,
      autobuildBin: "/usr/bin/true",
    });
    const app = mountApp(routes);
    const res = await app.fetch(new Request("http://test/api/rig/stop", { method: "POST" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      running: boolean;
      note?: string;
    };
    expect(body.running).toBe(false);
    expect(body.note).toBe("not_running");
  });

  it("SIGTERMs a live child and cleans up the pid file", async () => {
    // Spawn a real `sleep 60` that we'll kill via the route.
    const spawnFn: typeof spawn = (cmd, args, options) =>
      spawn("/bin/sh", ["-c", "sleep 60"], options as SpawnOptions);

    const routes = createRigControlRoute({
      pidFile,
      logFile,
      autobuildBin: "/usr/bin/true",
      spawnFn,
    });
    const app = mountApp(routes);

    const startRes = await app.fetch(new Request("http://test/api/rig/start", { method: "POST" }));
    expect(startRes.status).toBe(201);
    const { pid } = (await startRes.json()) as { pid: number };
    expect(isAlive(pid)).toBe(true);

    const stopRes = await app.fetch(new Request("http://test/api/rig/stop", { method: "POST" }));
    expect(stopRes.status).toBe(200);
    const stopBody = (await stopRes.json()) as { running: boolean };
    expect(stopBody.running).toBe(false);

    const gone = await waitUntil(() => !isAlive(pid));
    expect(gone).toBe(true);

    // pid file must have been removed.
    await expect(fs.access(pidFile)).rejects.toBeTruthy();
  });
});

describe("POST /api/rig/tick", () => {
  it("runs a single tick and returns parsed JSON on success", async () => {
    // Fake the autobuild CLI: print a JSON report + exit 0.
    const spawnFn: typeof spawn = (_cmd, _args, options) =>
      spawn(
        "/bin/sh",
        ["-c", 'echo \'{"ok":true,"processed":0}\'; exit 0'],
        options as SpawnOptions,
      );

    const routes = createRigControlRoute({
      pidFile,
      logFile,
      autobuildBin: "/usr/bin/true",
      spawnFn,
    });
    const app = mountApp(routes);

    const res = await app.fetch(new Request("http://test/api/rig/tick", { method: "POST" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      exit_code: number;
      ok: boolean;
      report: { ok: boolean; processed: number } | null;
      stdout: string;
    };
    expect(body.exit_code).toBe(0);
    expect(body.ok).toBe(true);
    expect(body.report).toEqual({ ok: true, processed: 0 });
    expect(body.stdout).toContain("processed");
  });

  it("returns a 500-style envelope when the tick fails", async () => {
    const spawnFn: typeof spawn = (_cmd, _args, options) =>
      spawn("/bin/sh", ["-c", "echo 'boom' 1>&2; exit 1"], options as SpawnOptions);

    const routes = createRigControlRoute({
      pidFile,
      logFile,
      autobuildBin: "/usr/bin/true",
      spawnFn,
    });
    const app = mountApp(routes);

    const res = await app.fetch(new Request("http://test/api/rig/tick", { method: "POST" }));
    expect(res.status).toBe(500);
    const body = (await res.json()) as {
      exit_code: number;
      ok: boolean;
      stderr: string;
    };
    expect(body.ok).toBe(false);
    expect(body.exit_code).toBe(1);
    expect(body.stderr).toContain("boom");
  });
});
