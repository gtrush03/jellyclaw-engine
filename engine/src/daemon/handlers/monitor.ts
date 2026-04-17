/**
 * Monitor runtime handler (T4-04).
 *
 * Manages running monitors (tail/watch/cmd) and emits events.
 * Supports rate limiting, line capping, and pattern filtering.
 */

import * as readline from "node:readline";

import type { FSWatcher } from "chokidar";
import chokidar from "chokidar";
import { execa, type Subprocess } from "execa";
import type { Logger } from "pino";

import type { AgentEvent } from "../../events.js";
import {
  type CreateMonitorInput,
  type Monitor,
  MonitorRegistry,
} from "../../tools/monitor-registry.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum line length in bytes before truncation. */
const MAX_LINE_BYTES = 8192;

/** Batching window in ms. */
const BATCH_WINDOW_MS = 50;

/** Max pending lines before dropping. */
const MAX_PENDING_LINES = 1000;

/** Drop notification interval in ms. */
const DROP_NOTIFY_INTERVAL_MS = 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MonitorEventEmitter {
  emit(event: AgentEvent): void;
}

export interface MonitorRuntimeOptions {
  stateDir?: string | undefined;
  logger: Logger;
  emitter: MonitorEventEmitter;
  now?: () => number;
}

interface RunningMonitor {
  monitor: Monitor;
  process?: Subprocess | undefined;
  watcher?: FSWatcher | undefined;
  patternRegex?: RegExp | undefined;
  batchBuffer: string[];
  batchTimer?: ReturnType<typeof setTimeout> | undefined;
  droppedCount: number;
  lastDropNotify: number;
  stopped: boolean;
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/**
 * Truncate a line to MAX_LINE_BYTES with elision marker.
 */
function truncateLine(line: string): string {
  const bytes = Buffer.byteLength(line, "utf8");
  if (bytes <= MAX_LINE_BYTES) {
    return line;
  }

  // Find a safe truncation point.
  let truncated = line;
  while (Buffer.byteLength(truncated, "utf8") > MAX_LINE_BYTES - 50) {
    truncated = truncated.slice(0, -100);
  }

  const elided = bytes - Buffer.byteLength(truncated, "utf8");
  return `${truncated}\n[… ${elided} more bytes elided …]`;
}

/**
 * Generate a ULID-like monitor ID.
 */
function generateMonitorId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).substring(2, 10);
  return `mon-${ts}-${rand}`;
}

/**
 * Validate and compile a regex pattern.
 * Returns undefined if pattern is invalid or uses dangerous features.
 */
function compilePattern(pattern: string | null): RegExp | undefined {
  if (!pattern) return undefined;

  // Reject dangerous patterns (lookbehind, recursive backrefs).
  if (/\(\?<[!=]/.test(pattern) || /\(\?\(/.test(pattern)) {
    return undefined;
  }

  try {
    return new RegExp(pattern);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// MonitorRuntime class
// ---------------------------------------------------------------------------

export class MonitorRuntime {
  readonly registry: MonitorRegistry;
  readonly #logger: Logger;
  readonly #emitter: MonitorEventEmitter;
  readonly #now: () => number;

  /** Running monitors keyed by ID. */
  readonly #running: Map<string, RunningMonitor> = new Map();

  constructor(opts: MonitorRuntimeOptions) {
    this.registry = new MonitorRegistry({ stateDir: opts.stateDir, now: opts.now });
    this.#logger = opts.logger;
    this.#emitter = opts.emitter;
    this.#now = opts.now ?? Date.now;
  }

  /** Start the runtime. Opens the registry and recovers persistent monitors. */
  start(): void {
    this.registry.open();

    // Mark non-persistent monitors as stopped (daemon restart).
    const marked = this.registry.markNonPersistentStopped();
    if (marked > 0) {
      this.#logger.info({ count: marked }, "monitor.marked_non_persistent_stopped");
    }

    // Recover persistent monitors.
    const persistent = this.registry.listPersistent();
    for (const mon of persistent) {
      this.#startMonitor(mon);
    }

    if (persistent.length > 0) {
      this.#logger.info({ count: persistent.length }, "monitor.recovered_persistent");
    }
  }

  /** Stop the runtime. Stops all monitors and closes the registry. */
  async stop(): Promise<void> {
    // Stop all running monitors.
    const ids = [...this.#running.keys()];
    for (const id of ids) {
      await this.#stopMonitor(id, "daemon_restart");
    }

    this.registry.close();
  }

  /** Create and start a new monitor. */
  createMonitor(
    input: Omit<CreateMonitorInput, "id">,
    sessionId: string,
  ): { monitor_id: string; started_at: number } {
    const id = generateMonitorId();

    const monitor = this.registry.create({
      ...input,
      id,
      owner: sessionId,
    });

    this.#startMonitor(monitor);

    // Emit monitor.started event.
    this.#emitter.emit({
      type: "monitor.started",
      session_id: sessionId,
      ts: this.#now(),
      seq: 0,
      monitor_id: id,
      kind: monitor.kind,
      target: monitor.target,
    });

    return {
      monitor_id: id,
      started_at: monitor.started_at,
    };
  }

  /** Stop a monitor. Returns stats or undefined if not found. */
  async stopMonitor(
    id: string,
    sessionId: string,
  ): Promise<{ id: string; stopped_at: number; total_events: number } | undefined> {
    const monitor = this.registry.getByIdAndOwner(id, sessionId);
    if (!monitor) {
      return undefined;
    }

    await this.#stopMonitor(id, "user");

    const updated = this.registry.getById(id);
    return {
      id,
      stopped_at: updated?.stopped_at ?? this.#now(),
      total_events: updated?.events_emitted ?? 0,
    };
  }

  /** List monitors for a session. */
  listMonitors(sessionId: string): Array<{
    id: string;
    kind: string;
    target: string;
    status: string;
    events_emitted: number;
    started_at: number;
  }> {
    const monitors = this.registry.listAll(sessionId);
    return monitors.map((m) => ({
      id: m.id,
      kind: m.kind,
      target: m.target,
      status: m.status,
      events_emitted: m.events_emitted,
      started_at: m.started_at,
    }));
  }

  /** Check if a monitor exists and belongs to the given owner. */
  ownerCheck(id: string, sessionId: string): "ok" | "not_found" | "forbidden" {
    const monitor = this.registry.getById(id);
    if (!monitor) return "not_found";
    if (monitor.owner !== sessionId) return "forbidden";
    return "ok";
  }

  // -------------------------------------------------------------------------
  // Internal methods
  // -------------------------------------------------------------------------

  #startMonitor(monitor: Monitor): void {
    if (this.#running.has(monitor.id)) {
      return; // Already running.
    }

    const patternRegex = compilePattern(monitor.pattern);

    const runningMon: RunningMonitor = {
      monitor,
      patternRegex,
      batchBuffer: [],
      droppedCount: 0,
      lastDropNotify: 0,
      stopped: false,
    };

    this.#running.set(monitor.id, runningMon);

    switch (monitor.kind) {
      case "tail":
        this.#startTailMonitor(runningMon);
        break;
      case "watch":
        this.#startWatchMonitor(runningMon);
        break;
      case "cmd":
        this.#startCmdMonitor(runningMon);
        break;
    }

    this.#logger.info(
      { monitorId: monitor.id, kind: monitor.kind, target: monitor.target },
      "monitor.started",
    );
  }

  #startTailMonitor(runningMon: RunningMonitor): void {
    const { monitor } = runningMon;

    try {
      const proc = execa("tail", ["-F", "-n", "0", monitor.target], {
        reject: false,
        buffer: false,
      });

      runningMon.process = proc;

      if (proc.stdout) {
        const rl = readline.createInterface({ input: proc.stdout });
        rl.on("line", (line) => {
          if (!runningMon.stopped) {
            this.#handleLine(runningMon, line);
          }
        });
      }

      proc.on("exit", (code) => {
        if (!runningMon.stopped) {
          if (code === 0) {
            this.registry.markStopped(monitor.id);
            this.#emitStopped(monitor, "user", undefined);
          } else {
            this.registry.markError(monitor.id, `tail exited with code ${code}`);
            this.#emitStopped(monitor, "error", `tail exited with code ${code}`);
          }
          this.#running.delete(monitor.id);
        }
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.registry.markError(monitor.id, message);
      this.#emitStopped(monitor, "error", message);
      this.#running.delete(monitor.id);
    }
  }

  #startWatchMonitor(runningMon: RunningMonitor): void {
    const { monitor } = runningMon;

    try {
      const watcher = chokidar.watch(monitor.target, {
        ignoreInitial: true,
        persistent: true,
      });

      runningMon.watcher = watcher;

      watcher.on("add", (path) => this.#handleFsEvent(runningMon, "add", path));
      watcher.on("change", (path) => this.#handleFsEvent(runningMon, "change", path));
      watcher.on("unlink", (path) => this.#handleFsEvent(runningMon, "unlink", path));

      watcher.on("error", (err) => {
        if (!runningMon.stopped) {
          const message = err instanceof Error ? err.message : String(err);
          this.registry.markError(monitor.id, message);
          this.#emitStopped(monitor, "error", message);
          this.#running.delete(monitor.id);
        }
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.registry.markError(monitor.id, message);
      this.#emitStopped(monitor, "error", message);
      this.#running.delete(monitor.id);
    }
  }

  #startCmdMonitor(runningMon: RunningMonitor): void {
    const { monitor } = runningMon;

    try {
      const proc = execa("bash", ["-c", monitor.target], {
        reject: false,
        buffer: false,
      });

      runningMon.process = proc;

      if (proc.stdout) {
        const rl = readline.createInterface({ input: proc.stdout });
        rl.on("line", (line) => {
          if (!runningMon.stopped) {
            this.#handleLine(runningMon, line);
          }
        });
      }

      if (proc.stderr) {
        const rl = readline.createInterface({ input: proc.stderr });
        rl.on("line", (line) => {
          if (!runningMon.stopped) {
            this.#handleLine(runningMon, line);
          }
        });
      }

      proc.on("exit", (code) => {
        if (!runningMon.stopped) {
          if (code === 0) {
            this.registry.markStopped(monitor.id);
            this.#emitStopped(monitor, "user", undefined);
          } else {
            this.registry.markError(monitor.id, `cmd exited with code ${code}`);
            this.#emitStopped(monitor, "error", `cmd exited with code ${code}`);
          }
          this.#running.delete(monitor.id);
        }
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.registry.markError(monitor.id, message);
      this.#emitStopped(monitor, "error", message);
      this.#running.delete(monitor.id);
    }
  }

  #handleLine(runningMon: RunningMonitor, line: string): void {
    const { monitor, patternRegex } = runningMon;

    // Apply pattern filter.
    if (patternRegex && !patternRegex.test(line)) {
      return; // Skip non-matching lines.
    }

    // Truncate long lines.
    const truncated = truncateLine(line);

    // Check for overflow.
    if (runningMon.batchBuffer.length >= MAX_PENDING_LINES) {
      runningMon.droppedCount++;

      // Emit drop notification at most once per second.
      const now = this.#now();
      if (now - runningMon.lastDropNotify >= DROP_NOTIFY_INTERVAL_MS) {
        this.#emitter.emit({
          type: "monitor.event",
          session_id: monitor.owner,
          ts: now,
          seq: 0,
          monitor_id: monitor.id,
          dropped: runningMon.droppedCount,
        });
        runningMon.lastDropNotify = now;
        runningMon.droppedCount = 0;
      }
      return;
    }

    // Add to batch buffer.
    runningMon.batchBuffer.push(truncated);

    // Start batch timer if not running.
    if (!runningMon.batchTimer) {
      runningMon.batchTimer = setTimeout(() => {
        this.#flushBatch(runningMon);
      }, BATCH_WINDOW_MS);
    }

    // Check max_lines.
    if (monitor.max_lines !== null) {
      const totalEmitted = (this.registry.getById(monitor.id)?.events_emitted ?? 0) + 1;
      if (totalEmitted >= monitor.max_lines) {
        this.#flushBatch(runningMon);
        this.registry.markExhausted(monitor.id);
        this.#emitStopped(monitor, "exhausted", undefined);
        void this.#stopMonitor(monitor.id, "exhausted");
      }
    }
  }

  #handleFsEvent(runningMon: RunningMonitor, type: string, path: string): void {
    const { monitor, patternRegex } = runningMon;

    // Apply pattern filter to path.
    if (patternRegex && !patternRegex.test(path)) {
      return;
    }

    // Emit fs event directly (no batching for fs events).
    this.#emitter.emit({
      type: "monitor.event",
      session_id: monitor.owner,
      ts: this.#now(),
      seq: 0,
      monitor_id: monitor.id,
      fs_event: { type, path },
    });

    this.registry.incrementEmitted(monitor.id);

    // Check max_lines.
    if (monitor.max_lines !== null) {
      const totalEmitted = this.registry.getById(monitor.id)?.events_emitted ?? 0;
      if (totalEmitted >= monitor.max_lines) {
        this.registry.markExhausted(monitor.id);
        this.#emitStopped(monitor, "exhausted", undefined);
        void this.#stopMonitor(monitor.id, "exhausted");
      }
    }
  }

  #flushBatch(runningMon: RunningMonitor): void {
    const { monitor, batchBuffer } = runningMon;

    // Clear timer.
    if (runningMon.batchTimer) {
      clearTimeout(runningMon.batchTimer);
      runningMon.batchTimer = undefined;
    }

    if (batchBuffer.length === 0) {
      return;
    }

    // Emit batched event.
    this.#emitter.emit({
      type: "monitor.event",
      session_id: monitor.owner,
      ts: this.#now(),
      seq: 0,
      monitor_id: monitor.id,
      lines: [...batchBuffer],
    });

    // Update emitted count.
    this.registry.incrementEmitted(monitor.id, batchBuffer.length);

    // Clear buffer.
    runningMon.batchBuffer = [];
  }

  async #stopMonitor(
    id: string,
    reason: "user" | "exhausted" | "error" | "daemon_restart",
  ): Promise<void> {
    const runningMon = this.#running.get(id);
    if (!runningMon) {
      return;
    }

    runningMon.stopped = true;

    // Flush any pending batch.
    this.#flushBatch(runningMon);

    // Stop the underlying process/watcher.
    if (runningMon.process) {
      try {
        runningMon.process.kill("SIGTERM");
        // Wait a bit for graceful exit.
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (!runningMon.process.killed) {
          runningMon.process.kill("SIGKILL");
        }
      } catch {
        // Ignore kill errors.
      }
    }

    if (runningMon.watcher) {
      try {
        await runningMon.watcher.close();
      } catch {
        // Ignore close errors.
      }
    }

    // Update registry.
    // For daemon_restart: don't mark any monitors stopped here.
    // - Persistent monitors need to remain 'running' so listPersistent() recovers them.
    // - Non-persistent monitors will be marked by markNonPersistentStopped() on next start().
    if (reason !== "exhausted" && reason !== "daemon_restart") {
      this.registry.markStopped(id);
    }

    // Emit stopped event (only if not already emitted).
    if (reason === "user") {
      const monitor = this.registry.getById(id);
      if (monitor) {
        this.#emitStopped(monitor, reason, undefined);
      }
    }

    this.#running.delete(id);

    this.#logger.info({ monitorId: id, reason }, "monitor.stopped");
  }

  #emitStopped(
    monitor: Monitor,
    reason: "user" | "exhausted" | "error" | "daemon_restart",
    error: string | undefined,
  ): void {
    const updated = this.registry.getById(monitor.id) ?? monitor;

    this.#emitter.emit({
      type: "monitor.stopped",
      session_id: monitor.owner,
      ts: this.#now(),
      seq: 0,
      monitor_id: monitor.id,
      reason,
      total_events: updated.events_emitted,
      stopped_at: updated.stopped_at ?? this.#now(),
      ...(error !== undefined ? { error } : {}),
    });
  }

  /** For testing: check if a monitor is actively running. */
  isRunning(id: string): boolean {
    return this.#running.has(id);
  }

  /** For testing: get running monitor count. */
  runningCount(): number {
    return this.#running.size;
  }
}
