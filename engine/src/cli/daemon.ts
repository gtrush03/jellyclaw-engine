/**
 * CLI daemon commands (T4-01).
 *
 * Implements: start, stop, status, tail subcommands for the scheduler daemon.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { IpcServer, ipcClient } from "../daemon/ipc.js";
import { createNoopHandler, Scheduler } from "../daemon/scheduler.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultStateDir(): string {
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg && xdg.length > 0) {
    return path.join(xdg, "jellyclaw");
  }
  return path.join(os.homedir(), ".jellyclaw");
}

function getPidFilePath(stateDir: string): string {
  return path.join(stateDir, "scheduler.pid");
}

function readPid(stateDir: string): number | null {
  const pidPath = getPidFilePath(stateDir);
  try {
    const content = fs.readFileSync(pidPath, "utf8").trim();
    const pid = parseInt(content, 10);
    return Number.isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

export interface DaemonStartOptions {
  foreground?: boolean | undefined;
  stateDir?: string | undefined;
}

export async function daemonStartAction(options: DaemonStartOptions): Promise<number> {
  const stateDir = options.stateDir ?? defaultStateDir();
  const foreground = options.foreground ?? false;

  // Check if already running.
  const existingPid = readPid(stateDir);
  if (existingPid !== null && isProcessRunning(existingPid)) {
    process.stderr.write(`Scheduler already running (pid=${existingPid})\n`);
    return 2;
  }

  if (!foreground) {
    // Double-fork and detach.
    // For simplicity, we'll use a subprocess approach.
    const { spawn } = await import("node:child_process");

    const scriptPath = process.argv[1] ?? "";
    const child = spawn(
      process.execPath,
      [scriptPath, "daemon", "start", "--foreground", "--state-dir", stateDir],
      {
        detached: true,
        stdio: "ignore",
      },
    );
    child.unref();

    process.stderr.write(`Scheduler started in background (pid=${child.pid})\n`);
    return 0;
  }

  // Foreground mode — run the scheduler directly.
  const scheduler = new Scheduler({ stateDir });

  // Register noop handler for testing.
  scheduler.registerHandler("wakeup", createNoopHandler());
  scheduler.registerHandler("cron", createNoopHandler());

  // Start the scheduler.
  scheduler.start();

  // Start IPC server.
  const ipcServer = new IpcServer({ scheduler });
  ipcServer.start();

  // Handle signals.
  const shutdown = async (): Promise<void> => {
    await ipcServer.stop();
    await scheduler.stop();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());

  // Keep the process alive.
  return new Promise(() => {
    // Never resolves — runs until signal.
  });
}

// ---------------------------------------------------------------------------
// Stop
// ---------------------------------------------------------------------------

export interface DaemonStopOptions {
  stateDir?: string | undefined;
}

export async function daemonStopAction(options: DaemonStopOptions): Promise<number> {
  const stateDir = options.stateDir ?? defaultStateDir();

  const pid = readPid(stateDir);
  if (pid === null) {
    process.stderr.write("No scheduler running (no PID file found)\n");
    return 2;
  }

  if (!isProcessRunning(pid)) {
    process.stderr.write(`Scheduler not running (stale PID file for pid=${pid})\n`);
    // Clean up stale PID file.
    try {
      fs.unlinkSync(getPidFilePath(stateDir));
    } catch {
      // Ignore.
    }
    return 2;
  }

  // Send SIGTERM.
  process.kill(pid, "SIGTERM");

  // Wait for process to exit (up to 10s).
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) {
      process.stderr.write(`Scheduler stopped (pid=${pid})\n`);
      return 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  // Force kill.
  process.stderr.write(`Scheduler did not stop gracefully, sending SIGKILL\n`);
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // May already be dead.
  }

  // Wait a bit more.
  await new Promise((resolve) => setTimeout(resolve, 500));

  if (!isProcessRunning(pid)) {
    process.stderr.write(`Scheduler killed (pid=${pid})\n`);
    return 0;
  }

  process.stderr.write(`Failed to stop scheduler (pid=${pid})\n`);
  return 1;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export interface DaemonStatusOptions {
  stateDir?: string | undefined;
  pretty?: boolean | undefined;
}

export async function daemonStatusAction(options: DaemonStatusOptions): Promise<number> {
  const stateDir = options.stateDir ?? defaultStateDir();
  const pretty = options.pretty ?? false;

  const pid = readPid(stateDir);
  if (pid === null || !isProcessRunning(pid)) {
    const status = { running: false, pid: null, db_path: path.join(stateDir, "scheduler.db") };
    if (pretty) {
      process.stdout.write(`Scheduler: not running\n`);
      process.stdout.write(`DB path: ${status.db_path}\n`);
    } else {
      process.stdout.write(`${JSON.stringify(status)}\n`);
    }
    return 0;
  }

  // Query via IPC.
  const client = ipcClient(stateDir);
  try {
    const status = await client.status();
    if (pretty) {
      process.stdout.write(`Scheduler: running\n`);
      process.stdout.write(`  PID: ${status.pid}\n`);
      process.stdout.write(`  Uptime: ${status.uptime_s}s\n`);
      process.stdout.write(`  Pending jobs: ${status.pending}\n`);
      process.stdout.write(`  Running jobs: ${status.running}\n`);
      process.stdout.write(`  DB path: ${status.db_path}\n`);
    } else {
      process.stdout.write(`${JSON.stringify({ is_running: true, ...status })}\n`);
    }
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Failed to query scheduler: ${message}\n`);
    return 1;
  }
}

// ---------------------------------------------------------------------------
// Tail (placeholder — full implementation would require subscribe verb)
// ---------------------------------------------------------------------------

export interface DaemonTailOptions {
  stateDir?: string | undefined;
}

export function daemonTailAction(options: DaemonTailOptions): number {
  const stateDir = options.stateDir ?? defaultStateDir();

  process.stderr.write(`Tail command not yet fully implemented.\n`);
  process.stderr.write(`State dir: ${stateDir}\n`);

  // For now, just check if scheduler is running.
  const pid = readPid(stateDir);
  if (pid === null || !isProcessRunning(pid)) {
    process.stderr.write(`Scheduler not running.\n`);
    return 2;
  }

  process.stderr.write(`Scheduler running (pid=${pid}). Subscribe verb needed for live tail.\n`);
  return 0;
}
