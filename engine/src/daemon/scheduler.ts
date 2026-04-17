/**
 * Scheduler daemon tick loop (T4-01).
 *
 * Polls the job store every 250ms for due jobs. Fires handlers registered
 * via `registerHandler()`. Cron jobs recompute their next fire time after
 * each execution.
 *
 * The scheduler is the substrate for ScheduleWakeup and Cron* tools (T4-02).
 * This module only provides the tick loop and handler seam — actual tool
 * wiring lives elsewhere.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { Logger } from "pino";

import { createLogger } from "../logger.js";
import { nextFireTime } from "./cron-parser.js";
import type { Job, JobKind } from "./store.js";
import { JobStore } from "./store.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type JobHandler = (job: Job) => Promise<void>;

export interface SchedulerOptions {
  /** Directory for scheduler.db, scheduler.sock, scheduler.pid. */
  stateDir?: string;
  /** Tick cadence in ms. Default 250. */
  tickIntervalMs?: number;
  /** Heartbeat interval in ms. Default 5000. */
  heartbeatIntervalMs?: number;
  /** Injectable clock. Defaults to Date.now. */
  now?: () => number;
  /** Custom logger. */
  logger?: Logger;
  /** Drain timeout on shutdown in ms. Default 10000. */
  drainTimeoutMs?: number;
}

export interface SchedulerStatus {
  pid: number;
  pending: number;
  running: number;
  uptime_s: number;
  db_path: string;
}

// ---------------------------------------------------------------------------
// Scheduler class
// ---------------------------------------------------------------------------

export class Scheduler {
  readonly store: JobStore;
  readonly stateDir: string;
  readonly #tickIntervalMs: number;
  readonly #heartbeatIntervalMs: number;
  readonly #drainTimeoutMs: number;
  readonly #now: () => number;
  readonly #logger: Logger;
  readonly #startedAt: number;

  #tickTimer: ReturnType<typeof setInterval> | null = null;
  #heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  #running = false;
  #shuttingDown = false;
  #activeHandlers = 0;

  // Handler registry per kind.
  readonly #handlers: Map<JobKind, JobHandler> = new Map();

  constructor(opts: SchedulerOptions = {}) {
    this.stateDir = opts.stateDir ?? this.#defaultStateDir();
    this.#tickIntervalMs = opts.tickIntervalMs ?? 250;
    this.#heartbeatIntervalMs = opts.heartbeatIntervalMs ?? 5000;
    this.#drainTimeoutMs = opts.drainTimeoutMs ?? 10000;
    this.#now = opts.now ?? Date.now;
    this.#logger =
      opts.logger ??
      createLogger({
        name: "scheduler",
        destination: "stderr",
      });
    this.#startedAt = this.#now();

    this.store = new JobStore({
      stateDir: this.stateDir,
      now: this.#now,
    });
  }

  #defaultStateDir(): string {
    const xdg = process.env.XDG_DATA_HOME;
    if (xdg && xdg.length > 0) {
      return path.join(xdg, "jellyclaw");
    }
    const home = process.env.HOME ?? require("node:os").homedir();
    return path.join(home, ".jellyclaw");
  }

  /** Register a handler for a job kind. Only one handler per kind. */
  registerHandler(kind: JobKind, handler: JobHandler): void {
    this.#handlers.set(kind, handler);
  }

  /** Start the scheduler tick loop. */
  start(): void {
    if (this.#running) return;

    // Open the store.
    this.store.open();

    // Write PID file.
    const pidPath = path.join(this.stateDir, "scheduler.pid");
    fs.writeFileSync(pidPath, String(process.pid), { mode: 0o600 });

    this.#running = true;
    this.#shuttingDown = false;

    // Start tick loop.
    this.#tickTimer = setInterval(() => {
      void this.#tick();
    }, this.#tickIntervalMs);

    // Start heartbeat.
    this.#heartbeatTimer = setInterval(() => {
      this.#heartbeat();
    }, this.#heartbeatIntervalMs);

    // Emit initial heartbeat.
    this.#heartbeat();

    this.#logger.info({ stateDir: this.stateDir }, "scheduler.started");
  }

  /** Stop the scheduler gracefully. */
  async stop(): Promise<void> {
    if (!this.#running) return;
    if (this.#shuttingDown) return;
    this.#shuttingDown = true;

    this.#logger.info("scheduler.stopping");

    // Stop timers.
    if (this.#tickTimer !== null) {
      clearInterval(this.#tickTimer);
      this.#tickTimer = null;
    }
    if (this.#heartbeatTimer !== null) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }

    // Wait for active handlers to drain.
    const deadline = this.#now() + this.#drainTimeoutMs;
    while (this.#activeHandlers > 0 && this.#now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    if (this.#activeHandlers > 0) {
      this.#logger.warn({ active: this.#activeHandlers }, "scheduler.drain_timeout");
    }

    // Close the store.
    this.store.close();

    // Remove PID file.
    const pidPath = path.join(this.stateDir, "scheduler.pid");
    try {
      fs.unlinkSync(pidPath);
    } catch {
      // Ignore.
    }

    this.#running = false;
    this.#logger.info("scheduler.shutdown");
  }

  /** Get current status. */
  status(): SchedulerStatus {
    const now = this.#now();
    return {
      pid: process.pid,
      pending: this.store.isOpen ? this.store.countPending() : 0,
      running: this.#activeHandlers,
      uptime_s: Math.floor((now - this.#startedAt) / 1000),
      db_path: this.store.dbPath,
    };
  }

  /** Emit a structured heartbeat. */
  #heartbeat(): void {
    const pending = this.store.isOpen ? this.store.countPending() : 0;
    const nextDue = this.store.isOpen ? this.store.nextDueAt() : null;
    const dueNextMs = nextDue !== null ? Math.max(0, nextDue - this.#now()) : null;

    this.#logger.debug(
      {
        pending,
        due_next_ms: dueNextMs,
      },
      "scheduler.heartbeat",
    );
  }

  /** Single tick: check for due jobs and fire them. */
  async #tick(): Promise<void> {
    if (this.#shuttingDown) return;

    const now = this.#now();
    const lookAhead = now + this.#tickIntervalMs;

    // List due jobs.
    const dueJobs = this.store.listDue(lookAhead);

    for (const job of dueJobs) {
      if (this.#shuttingDown) break;

      // Claim the job atomically.
      const claimed = this.store.claimJob(job.id);
      if (!claimed) continue; // Already claimed or cancelled.

      // Record fired event.
      this.store.appendEvent(job.id, "fired");

      // Get handler.
      const handler = this.#handlers.get(claimed.kind);
      if (!handler) {
        // No handler — use default noop that just logs.
        this.#logger.warn({ jobId: claimed.id, kind: claimed.kind }, "no handler for job kind");
        this.store.markDone(claimed.id, now);
        this.store.appendEvent(claimed.id, "completed", "no handler");
        continue;
      }

      // Execute handler.
      this.#activeHandlers++;
      try {
        await handler(claimed);

        // Handle completion based on job kind.
        if (claimed.kind === "wakeup") {
          this.store.markDone(claimed.id, this.#now());
          this.store.appendEvent(claimed.id, "completed");
        } else if (claimed.kind === "cron" && claimed.cron_expr) {
          // Compute next fire time and reschedule.
          const next = nextFireTime(claimed.cron_expr, this.#now());
          this.store.updateFireAt(claimed.id, next, this.#now());
          this.store.appendEvent(claimed.id, "completed", `next fire: ${next}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.#logger.error({ jobId: claimed.id, error: msg }, "handler error");
        this.store.markError(claimed.id, msg, this.#now());
        this.store.appendEvent(claimed.id, "error", msg);
      } finally {
        this.#activeHandlers--;
      }
    }
  }

  /** For testing: wait for next tick to complete. */
  async waitForTick(): Promise<void> {
    await this.#tick();
  }
}

// ---------------------------------------------------------------------------
// Default noop handler for testing (writes to stdout).
// ---------------------------------------------------------------------------

export function createNoopHandler(): JobHandler {
  return (job: Job): Promise<void> => {
    const output = JSON.stringify({ event: "test.fired", id: job.id });
    process.stdout.write(`${output}\n`);
    return Promise.resolve();
  };
}
