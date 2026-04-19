/**
 * Rig lifecycle control.
 *
 * The dashboard's existing write-surface is `.orchestrator/inbox/` — commands
 * that the rig picks up *if it's running*. Historically no process was
 * actually running, so those commands sat on disk and nothing consumed them.
 *
 * This route adds the missing layer:
 *   - POST /rig/start : spawn `autobuild run` as a detached daemon, write pid
 *   - POST /rig/stop  : SIGTERM → wait → SIGKILL the daemon
 *   - GET  /rig/running : is the pid file live? (never throws)
 *   - POST /rig/tick  : run a single `autobuild tick` (one-shot)
 *
 * Paths:
 *   - PID file : .orchestrator/dispatcher.pid
 *   - Log file : logs/dispatcher.jsonl  (created on first start)
 *
 * Safety:
 *   - PID writes are atomic (.tmp + rename) AND exclusive (wx) so two
 *     concurrent start requests can't both claim ownership.
 *   - All paths routed through `paths.ts` absolutes — no user input ever
 *     becomes a filesystem path.
 *   - Append-only logs rotate when >50MB using a simple `.0/.1/.2` counter.
 *   - If the dashboard server is itself killed, its registered cleanup handler
 *     SIGTERM's the tracked child before exit (see `index.ts`).
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import { openSync, closeSync, statSync, renameSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { z } from "zod";
import {
  AUTOBUILD_BIN,
  DISPATCHER_LOG,
  DISPATCHER_PID_FILE,
  LOGS_DIR,
  ORCHESTRATOR_DIR,
  REPO_ROOT,
  RIG_SESSIONS_DIR,
  RIG_STATE_FILE,
  assertInsideRepo,
} from "../lib/paths.js";
import type { RigProcessInfo } from "../types.js";

/**
 * Shape of `.autobuild/state.json` we need for reset preservation. Kept
 * narrow on purpose — the rig owns the canonical schema; we only read two
 * fields back (`concurrency`, `daily_budget_usd.cap`) so we don't clobber
 * operator-tuned knobs on reset.
 */
const PreservedStateSchema = z
  .object({
    rig_version: z.string().optional(),
    concurrency: z.number().int().min(1).optional(),
    daily_budget_usd: z
      .object({
        cap: z.number().nonnegative().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

// 50 MB rotation threshold. Logs rotate `.jsonl → .jsonl.0 → .1 → .2`.
const LOG_ROTATE_BYTES = 50 * 1024 * 1024;
const LOG_ROTATE_MAX = 3; // keep .0, .1, .2

// How long to wait after SIGTERM before escalating to SIGKILL.
const STOP_GRACE_MS = 10_000;

// Persisted "since" alongside the PID so /running can report start time
// without depending on process metadata.
interface PidFileContents {
  pid: number;
  since: string;
  started_by: "dashboard";
}

// ---------- module state: track the child we started ----------
// We only track a child if the current Hono process spawned it. On restart,
// the next server process re-discovers the daemon solely via the pid file.
let trackedChild: ChildProcess | null = null;

export function getTrackedChild(): ChildProcess | null {
  return trackedChild;
}

// ---------- helpers ----------

function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // `kill(pid, 0)` doesn't send a signal — it just probes existence +
    // permission. Throws ESRCH when dead, EPERM on some OSes if we don't own
    // the process (still means alive).
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true;
    return false;
  }
}

async function readPidFile(pidFile: string): Promise<PidFileContents | null> {
  try {
    const raw = await fs.readFile(pidFile, "utf8");
    const parsed = JSON.parse(raw) as Partial<PidFileContents>;
    if (typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid)) {
      return null;
    }
    return {
      pid: parsed.pid,
      since: typeof parsed.since === "string" ? parsed.since : "",
      started_by: "dashboard",
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    // A half-written or corrupt pid file shouldn't crash /running — treat
    // it as "no pid file." The next /start call will overwrite.
    return null;
  }
}

async function deletePidFile(pidFile: string): Promise<void> {
  try {
    await fs.unlink(pidFile);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      console.error(`[rig-control] failed to delete pid file ${pidFile}:`, err);
    }
  }
}

/**
 * Atomic + exclusive pid file write.
 *
 * Step 1: open a `.lock` file with the `wx` flag — fails if it already exists.
 *         This is our "only one starter wins" race guard.
 * Step 2: write the pid JSON to `.tmp`, rename over the real path.
 * Step 3: remove the `.lock`.
 *
 * If step 1 fails with EEXIST, another starter is mid-flight — we signal via
 * a typed error and let the caller return 409.
 */
async function writePidFileExclusive(pidFile: string, contents: PidFileContents): Promise<void> {
  const lockPath = `${pidFile}.lock`;
  // Open-excl first. If it throws EEXIST another call is racing us.
  let lockFd: number;
  try {
    lockFd = openSync(lockPath, "wx");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      const e = new Error("pid file is locked by a concurrent starter");
      (e as NodeJS.ErrnoException).code = "ELOCKED";
      throw e;
    }
    throw err;
  }
  try {
    const tmp = `${pidFile}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(contents, null, 2), "utf8");
    renameSync(tmp, pidFile);
  } finally {
    try {
      closeSync(lockFd);
    } catch {
      // ignore
    }
    try {
      await fs.unlink(lockPath);
    } catch {
      // ignore
    }
  }
}

/**
 * Rotate the dispatcher log when it exceeds LOG_ROTATE_BYTES.
 * Shift: `.2 → delete`, `.1 → .2`, `.0 → .1`, `jsonl → .0`.
 */
function rotateLogIfNeeded(logPath: string): void {
  let size = 0;
  try {
    size = statSync(logPath).size;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return; // nothing to rotate
    return;
  }
  if (size < LOG_ROTATE_BYTES) return;
  // Delete the oldest rotated file.
  const oldest = `${logPath}.${LOG_ROTATE_MAX - 1}`;
  try {
    renameSync(oldest, `${oldest}.deleted`);
  } catch {
    // ignore
  }
  try {
    // Actually unlink the `.deleted` stub (best effort).
    // Not using fs/promises here because we're in a sync code path.
    unlinkSync(`${oldest}.deleted`);
  } catch {
    // ignore
  }
  // Shift the rest down: .1 → .2, .0 → .1
  for (let i = LOG_ROTATE_MAX - 2; i >= 0; i--) {
    const from = `${logPath}.${i}`;
    const to = `${logPath}.${i + 1}`;
    try {
      renameSync(from, to);
    } catch {
      // ignore — may not exist yet
    }
  }
  // Finally the active log → .0
  try {
    renameSync(logPath, `${logPath}.0`);
  } catch {
    // ignore
  }
}

async function ensureDirs(pidFile: string, logPath: string): Promise<void> {
  await fs.mkdir(path.dirname(pidFile), { recursive: true });
  await fs.mkdir(path.dirname(logPath), { recursive: true });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------- factory ----------

export interface RigControlRouteOptions {
  /** Override for `.orchestrator/dispatcher.pid` (tests). */
  pidFile?: string;
  /** Override for `logs/dispatcher.jsonl` (tests). */
  logFile?: string;
  /** Override for the autobuild CLI path (tests). */
  autobuildBin?: string;
  /** Override for cwd when spawning (tests). */
  cwd?: string;
  /**
   * Spawn factory — defaults to node:child_process.spawn. Tests override this
   * to point at `sleep 60` / `echo`-style subprocesses.
   */
  spawnFn?: typeof spawn;
  /**
   * Clock for `since`. Tests inject deterministic ISO timestamps.
   */
  nowIso?: () => string;
  /**
   * Override for `.autobuild/state.json` (reset endpoint, tests).
   */
  stateFile?: string;
  /**
   * Override for `.autobuild/sessions/` (reset endpoint, tests).
   */
  sessionsDir?: string;
  /**
   * Optional SSE broadcaster. When supplied, `/rig/reset` emits a
   * `reset` event so any open dashboards auto-clear. Injected from
   * `events.ts` by the production wiring; tests omit it.
   */
  broadcastReset?: (data: Record<string, unknown>) => void;
}

export function createRigControlRoute(opts: RigControlRouteOptions = {}): Hono {
  const app = new Hono();
  const pidFile = opts.pidFile ?? DISPATCHER_PID_FILE;
  const logFile = opts.logFile ?? DISPATCHER_LOG;
  const autobuildBin = opts.autobuildBin ?? AUTOBUILD_BIN;
  const cwd = opts.cwd ?? REPO_ROOT;
  const spawnFn = opts.spawnFn ?? spawn;
  const nowIso = opts.nowIso ?? ((): string => new Date().toISOString());
  const stateFile = opts.stateFile ?? RIG_STATE_FILE;
  const sessionsDir = opts.sessionsDir ?? RIG_SESSIONS_DIR;
  const broadcastReset = opts.broadcastReset;

  // Path traversal defence for production paths. Tests pass tmpdirs — those
  // legitimately live outside REPO_ROOT so we only assert when defaults apply.
  if (!opts.pidFile) assertInsideRepo(pidFile);
  if (!opts.logFile) assertInsideRepo(logFile);
  if (!opts.stateFile) assertInsideRepo(stateFile);
  if (!opts.sessionsDir) assertInsideRepo(sessionsDir);

  // ---------- GET /rig/running ----------
  app.get("/rig/running", async (c) => {
    const info = await getRigProcessInfo({ pidFile, logFile });
    return c.json(info);
  });

  // ---------- POST /rig/start ----------
  app.post("/rig/start", async (c) => {
    // 1. If a live pid file exists → 409.
    const existing = await readPidFile(pidFile);
    if (existing && isAlive(existing.pid)) {
      return c.json(
        {
          error: "already_running",
          pid: existing.pid,
          since: existing.since || null,
        },
        409,
      );
    }
    // Stale pid file — clean it up before we try to claim.
    if (existing && !isAlive(existing.pid)) {
      await deletePidFile(pidFile);
    }

    await ensureDirs(pidFile, logFile);
    rotateLogIfNeeded(logFile);

    // 2. Open the log file in append mode so both stdout & stderr pipe in.
    let logFd: number;
    try {
      logFd = openSync(logFile, "a");
    } catch (err) {
      return c.json(
        {
          error: "log_open_failed",
          detail: (err as Error).message,
        },
        500,
      );
    }

    // 3. Spawn the daemon detached with stdio piped to the log fd.
    //    `stdio: ['ignore', logFd, logFd]` would let the child adopt the fd
    //    directly, but we want to keep the node-side references in sync with
    //    the child's lifecycle (so `trackedChild.on('exit')` fires), so we
    //    pipe and manually tee into the fd.
    let child: ChildProcess;
    try {
      child = spawnFn(autobuildBin, ["run"], {
        cwd,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          // Mark ourselves so the dispatcher can distinguish dashboard-spawned
          // instances from tmux-spawned ones in its own logs.
          AUTOBUILD_SPAWNED_BY: "dashboard",
        },
      });
    } catch (err) {
      try {
        closeSync(logFd);
      } catch {
        // ignore
      }
      return c.json(
        {
          error: "spawn_failed",
          detail: (err as Error).message,
        },
        500,
      );
    }

    // Pipe child stdout / stderr into the log fd. Each line gets wrapped in a
    // JSONL envelope so `dispatcher.jsonl` stays parseable.
    const now = nowIso();
    const writeLine = (stream: "stdout" | "stderr", chunk: Buffer): void => {
      const text = chunk.toString("utf8");
      // Split on newlines, emit each non-empty line as its own JSON record.
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line === undefined) continue;
        if (i === lines.length - 1 && line === "") continue; // trailing \n
        const record = {
          at: new Date().toISOString(),
          stream,
          pid: child.pid ?? null,
          line,
        };
        try {
          // Synchronous write — we already own the fd, and the volume here
          // is tiny relative to the dispatcher's own throughput.
          writeSync(logFd, `${JSON.stringify(record)}\n`);
        } catch {
          // If the fd is closed (we've already shut down), stop trying.
        }
      }
    };
    child.stdout?.on("data", (c2: Buffer) => writeLine("stdout", c2));
    child.stderr?.on("data", (c2: Buffer) => writeLine("stderr", c2));

    child.on("exit", (code, signal) => {
      try {
        closeSync(logFd);
      } catch {
        // ignore
      }
      // Only clean the pid file if we still own it (it might've been replaced
      // by a later start). Best-effort.
      void (async (): Promise<void> => {
        const current = await readPidFile(pidFile);
        if (current && current.pid === child.pid) {
          await deletePidFile(pidFile);
        }
      })();
      if (trackedChild === child) {
        trackedChild = null;
      }
      console.log(`[rig-control] dispatcher exited pid=${child.pid} code=${code} signal=${signal}`);
    });

    // 4. Unref so the parent can exit without reaping; the child lives on its
    //    own group thanks to `detached: true`.
    try {
      child.unref();
    } catch {
      // ignore
    }

    // 5. Persist pid atomically + exclusively.
    if (!child.pid) {
      // Highly unusual — spawn succeeded but no pid assigned. Kill what we
      // did get (if anything) and bail.
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      try {
        closeSync(logFd);
      } catch {
        // ignore
      }
      return c.json(
        {
          error: "spawn_failed",
          detail: "child has no pid after spawn",
        },
        500,
      );
    }

    try {
      await writePidFileExclusive(pidFile, {
        pid: child.pid,
        since: now,
        started_by: "dashboard",
      });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // Kill the child we just spawned if we can't record it.
      try {
        if (child.pid) process.kill(child.pid, "SIGTERM");
      } catch {
        // ignore
      }
      if (code === "ELOCKED") {
        return c.json(
          {
            error: "already_running",
            pid: null,
          },
          409,
        );
      }
      return c.json(
        {
          error: "pidfile_write_failed",
          detail: (err as Error).message,
        },
        500,
      );
    }

    trackedChild = child;

    return c.json(
      {
        running: true,
        pid: child.pid,
        since: now,
        log_path: logFile,
      },
      201,
    );
  });

  // ---------- POST /rig/stop ----------
  app.post("/rig/stop", async (c) => {
    const contents = await readPidFile(pidFile);
    if (!contents) {
      return c.json({ running: false, note: "not_running" });
    }
    const pid = contents.pid;
    if (!isAlive(pid)) {
      await deletePidFile(pidFile);
      return c.json({ running: false, note: "not_running" });
    }

    // SIGTERM, wait up to STOP_GRACE_MS, then SIGKILL.
    try {
      process.kill(pid, "SIGTERM");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ESRCH") {
        console.error(`[rig-control] SIGTERM ${pid} failed:`, err);
      }
    }

    const deadline = Date.now() + STOP_GRACE_MS;
    const pollEvery = 100;
    while (Date.now() < deadline) {
      if (!isAlive(pid)) break;
      await sleep(pollEvery);
    }

    if (isAlive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ESRCH") {
          console.error(`[rig-control] SIGKILL ${pid} failed:`, err);
        }
      }
      // Give it another brief window for the kernel to collect the body.
      const kdeadline = Date.now() + 2000;
      while (Date.now() < kdeadline) {
        if (!isAlive(pid)) break;
        await sleep(50);
      }
    }

    await deletePidFile(pidFile);
    if (trackedChild && trackedChild.pid === pid) {
      trackedChild = null;
    }

    return c.json({
      running: false,
      stopped_at: nowIso(),
    });
  });

  // ---------- POST /rig/tick ----------
  app.post("/rig/tick", async (c) => {
    // One-shot. We capture stdout; the autobuild CLI's `tick` command prints
    // JSON (see scripts/autobuild/bin/autobuild `cmdTick`).
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const child = spawnFn(autobuildBin, ["tick"], {
      cwd,
      detached: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        AUTOBUILD_SPAWNED_BY: "dashboard-tick",
      },
    });

    const exitCode = await new Promise<number>((resolve) => {
      child.stdout?.on("data", (b: Buffer) => stdoutChunks.push(b));
      child.stderr?.on("data", (b: Buffer) => stderrChunks.push(b));
      child.on("error", (err) => {
        stderrChunks.push(Buffer.from(String(err.message ?? err)));
        resolve(-1);
      });
      child.on("exit", (code) => resolve(code ?? -1));
    });

    const stdout = Buffer.concat(stdoutChunks).toString("utf8");
    const stderr = Buffer.concat(stderrChunks).toString("utf8");

    // Try to parse stdout as JSON (the CLI prints JSON on success). If that
    // fails, return the raw text so the caller can still debug.
    let report: unknown = null;
    try {
      report = stdout.trim().length ? JSON.parse(stdout) : null;
    } catch {
      report = null;
    }

    return c.json(
      {
        exit_code: exitCode,
        ok: exitCode === 0,
        report,
        stdout,
        stderr,
      },
      exitCode === 0 ? 200 : 500,
    );
  });

  // ---------- POST /rig/reset ----------
  // Fresh-start UX: wipe rig state + per-session dirs back to an empty
  // skeleton, but preserve `.autobuild/queue.json` so pressing Start after
  // reset replays the same queue, and preserve operator-tuned `concurrency`
  // and `daily_budget_usd.cap` so a reset doesn't clobber operator knobs.
  //
  // Refuses with 409 while the dispatcher is live — resetting state under a
  // running rig would make the dispatcher write to a phantom file.
  app.post("/rig/reset", async (c) => {
    // Validate method/body shape defensively — no body is required, but we
    // reject any non-JSON content-type masquerading as a side-effect. This
    // matches the zod-at-boundary convention used across /runs/:id/action.
    const EmptyBodySchema = z.object({}).partial().passthrough();
    if (c.req.header("content-type")?.includes("application/json")) {
      try {
        const body = await c.req.json();
        EmptyBodySchema.parse(body);
      } catch (err) {
        return c.json(
          {
            error: "bad_request",
            detail: err instanceof Error ? err.message : String(err),
          },
          400,
        );
      }
    }

    // Refuse if the rig is running. Uses the same path both /running and the
    // heartbeat monitor already trust.
    const info = await getRigProcessInfo({ pidFile, logFile });
    if (info.running) {
      return c.json(
        {
          error: "rig_running",
          message: "Stop the rig before resetting.",
        },
        409,
      );
    }

    const now = nowIso();
    const today = now.slice(0, 10); // YYYY-MM-DD

    // Preserve knobs from the existing state. If parsing fails we fall back
    // to conservative defaults — the whole point of this route is to recover
    // from bad state so we MUST NOT throw on a malformed state.json.
    let rigVersion = "0.1.0";
    let concurrency: 1 | 2 = 1;
    let budgetCap = 25;
    try {
      const raw = await fs.readFile(stateFile, "utf8");
      const parsed = PreservedStateSchema.parse(JSON.parse(raw));
      if (typeof parsed.rig_version === "string" && parsed.rig_version.length) {
        rigVersion = parsed.rig_version;
      }
      if (parsed.concurrency === 1 || parsed.concurrency === 2) {
        concurrency = parsed.concurrency;
      }
      if (parsed.daily_budget_usd && typeof parsed.daily_budget_usd.cap === "number") {
        budgetCap = parsed.daily_budget_usd.cap;
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        console.warn(
          `[rig-control] reset: could not parse existing state.json (${code ?? "invalid"}) — using defaults`,
        );
      }
    }

    // Build the empty skeleton.
    const skeleton = {
      rig_version: rigVersion,
      rig_heartbeat: now,
      concurrency,
      paused: false,
      halted: false,
      daily_budget_usd: {
        spent: 0,
        cap: budgetCap,
        day: today,
      },
      runs: {},
      completed: [],
      escalated: [],
      queue: [],
    };

    // Atomic write of state.json: write to .tmp + rename. Ensures a crash
    // mid-write never leaves a half-baked file.
    try {
      await fs.mkdir(path.dirname(stateFile), { recursive: true });
      const tmp = `${stateFile}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(skeleton, null, 2), "utf8");
      renameSync(tmp, stateFile);
    } catch (err) {
      return c.json(
        {
          error: "state_write_failed",
          detail: err instanceof Error ? err.message : String(err),
        },
        500,
      );
    }

    // Wipe per-session subdirs. We deliberately do NOT rm the `sessions/`
    // root — the dashboard and other tooling may observe it, and the rig
    // doesn't guarantee it's reserved for session dirs exclusively.
    try {
      const entries = await fs.readdir(sessionsDir, { withFileTypes: true });
      await Promise.all(
        entries
          .filter((e) => e.isDirectory())
          .map((e) =>
            fs.rm(path.join(sessionsDir, e.name), {
              recursive: true,
              force: true,
            }),
          ),
      );
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        // Non-fatal — state.json is the source of truth. Log and continue.
        console.warn(`[rig-control] reset: failed to wipe session dirs under ${sessionsDir}:`, err);
      }
    }

    // Broadcast so open dashboards clear without a full reload.
    try {
      broadcastReset?.({ reset_at: now });
    } catch (err) {
      // SSE broadcast failures are never fatal to the reset itself.
      console.warn("[rig-control] reset: broadcast failed:", err);
    }

    return c.json(
      {
        ok: true,
        reset_at: now,
      },
      200,
    );
  });

  return app;
}

// ---------- shared helpers used by runs.ts + index.ts ----------

/**
 * Snapshot the dispatcher process status from the pid file. Never throws.
 * Callable from any route — used by `/runs` to enrich its response.
 */
export async function getRigProcessInfo(
  opts: { pidFile?: string; logFile?: string } = {},
): Promise<RigProcessInfo> {
  const pidFile = opts.pidFile ?? DISPATCHER_PID_FILE;
  const logFile = opts.logFile ?? DISPATCHER_LOG;
  const contents = await readPidFile(pidFile);
  if (!contents) {
    return { running: false, pid: null, since: null, log_path: null };
  }
  if (!isAlive(contents.pid)) {
    // Stale pid → clean it up and report not running. /running is expected to
    // self-heal per the spec.
    await deletePidFile(pidFile);
    return { running: false, pid: null, since: null, log_path: null };
  }
  return {
    running: true,
    pid: contents.pid,
    since: contents.since || null,
    log_path: logFile,
  };
}

/**
 * Background heartbeat monitor. Runs every 5s:
 *   - if rig_heartbeat is >30s stale AND the pid file points at a live proc →
 *     log a warning (dashboard-side visibility of a stuck dispatcher).
 *   - if the pid file points at a DEAD process → clean it up (self-heal).
 *
 * Returns a stop fn the server shutdown handler calls.
 */
export function startHeartbeatMonitor(
  opts: {
    loadHeartbeatMs: () => Promise<number | null>;
    pidFile?: string;
    intervalMs?: number;
    now?: () => number;
    log?: (msg: string) => void;
  } = { loadHeartbeatMs: async () => null },
): () => void {
  const pidFile = opts.pidFile ?? DISPATCHER_PID_FILE;
  const intervalMs = opts.intervalMs ?? 5_000;
  const now = opts.now ?? ((): number => Date.now());
  const log = opts.log ?? ((msg: string): void => console.warn(msg));

  let warnedAt: number | null = null;

  const timer = setInterval(() => {
    void (async () => {
      const contents = await readPidFile(pidFile);
      if (!contents) return; // nothing we started
      if (!isAlive(contents.pid)) {
        // Self-heal: the daemon died out from under us.
        await deletePidFile(pidFile);
        log(`[rig-heartbeat] dispatcher pid=${contents.pid} is dead; cleaned up pid file`);
        warnedAt = null;
        return;
      }
      // Daemon alive — check heartbeat staleness.
      try {
        const hbMs = await opts.loadHeartbeatMs();
        if (hbMs === null) return; // never wrote one yet; don't warn
        const ageSec = (now() - hbMs) / 1000;
        if (ageSec > 30) {
          // Warn at most once per minute so logs don't fill.
          if (warnedAt === null || now() - warnedAt > 60_000) {
            warnedAt = now();
            log(
              `[rig-heartbeat] dispatcher pid=${contents.pid} alive but heartbeat is ${Math.round(ageSec)}s stale`,
            );
          }
        } else if (warnedAt !== null) {
          warnedAt = null;
          log(
            `[rig-heartbeat] dispatcher pid=${contents.pid} heartbeat recovered (${Math.round(ageSec)}s)`,
          );
        }
      } catch (err) {
        console.error("[rig-heartbeat] monitor tick failed:", err);
      }
    })();
  }, intervalMs);
  // Don't keep the event loop alive just for this poll.
  timer.unref?.();

  return (): void => clearInterval(timer);
}

/**
 * Cleanly stop the tracked child on server shutdown. Sends SIGTERM and
 * waits up to 5s; never throws. Also removes our pid file if it still
 * references our child.
 */
export async function stopTrackedChildOnShutdown(): Promise<void> {
  const child = trackedChild;
  if (!child || !child.pid) return;
  const pid = child.pid;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // already gone
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) break;
    await sleep(100);
  }
  // Best-effort pid-file cleanup so the next server boot sees a clean slate.
  const contents = await readPidFile(DISPATCHER_PID_FILE);
  if (contents && contents.pid === pid) {
    await deletePidFile(DISPATCHER_PID_FILE);
  }
  trackedChild = null;
}

// Re-export for callers that want to touch the canonical dirs.
export const RIG_CONTROL_PATHS = {
  PID_FILE: DISPATCHER_PID_FILE,
  LOG_FILE: DISPATCHER_LOG,
  LOGS_DIR,
  ORCHESTRATOR_DIR,
};

/**
 * Default instance with production paths.
 *
 * The SSE broadcaster is injected lazily in `index.ts` to avoid a circular
 * import with `events.ts`. Callers that want `/rig/reset` to emit a `reset`
 * event should use `createRigControlRoute({ broadcastReset })` instead of
 * the bare default export — or rely on the index.ts wiring.
 */
export const rigControlRoutes = createRigControlRoute();
