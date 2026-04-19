/**
 * SQLite-backed job store for the scheduler daemon (T4-01).
 *
 * Persists ScheduleWakeup and Cron jobs with durable state.
 * Uses `better-sqlite3` with WAL journal mode for concurrent reads.
 *
 * Schema is migration-managed via a `schema_version` table.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";

import { openSqlite, type SqliteDatabase, type SqliteStatement } from "../db/sqlite.js";

// ---------------------------------------------------------------------------
// Zod schemas — types flow FROM Zod (per CLAUDE.md convention).
// ---------------------------------------------------------------------------

export const JobKind = z.enum(["wakeup", "cron"]);
export type JobKind = z.infer<typeof JobKind>;

export const JobStatus = z.enum(["pending", "running", "done", "failed", "cancelled"]);
export type JobStatus = z.infer<typeof JobStatus>;

export const JobEventType = z.enum(["fired", "completed", "error", "skipped"]);
export type JobEventType = z.infer<typeof JobEventType>;

export const Job = z.object({
  id: z.string(),
  kind: JobKind,
  fire_at: z.number().int(),
  cron_expr: z.string().nullable(),
  payload: z.string(),
  created_at: z.number().int(),
  last_fired_at: z.number().int().nullable(),
  fire_count: z.number().int(),
  status: JobStatus,
  error: z.string().nullable(),
  owner: z.string(),
});
export type Job = z.infer<typeof Job>;

export const JobEvent = z.object({
  id: z.number().int(),
  job_id: z.string(),
  ts: z.number().int(),
  event: JobEventType,
  detail: z.string().nullable(),
});
export type JobEvent = z.infer<typeof JobEvent>;

export const InsertJobInput = z.object({
  id: z.string(),
  kind: JobKind,
  fire_at: z.number().int(),
  cron_expr: z.string().nullable().optional(),
  payload: z.string(),
  owner: z.string(),
});
export type InsertJobInput = z.infer<typeof InsertJobInput>;

export const ListFilter = z
  .object({
    status: JobStatus.optional(),
    owner: z.string().optional(),
    kind: JobKind.optional(),
  })
  .optional();
export type ListFilter = z.infer<typeof ListFilter>;

// ---------------------------------------------------------------------------
// Current schema version.
// ---------------------------------------------------------------------------

const CURRENT_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Default path helpers.
// ---------------------------------------------------------------------------

function defaultStateDir(): string {
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg && xdg.length > 0) {
    return path.join(xdg, "jellyclaw");
  }
  // macOS: ~/.jellyclaw, Linux without XDG: ~/.jellyclaw
  return path.join(os.homedir(), ".jellyclaw");
}

export interface JobStoreOptions {
  /** Directory containing scheduler.db (and scheduler.sock, scheduler.pid). */
  stateDir?: string;
  /** Injectable clock. Defaults to Date.now. */
  now?: () => number;
}

// ---------------------------------------------------------------------------
// JobStore class.
// ---------------------------------------------------------------------------

export class JobStore {
  readonly dbPath: string;
  readonly stateDir: string;
  readonly #now: () => number;
  #db: SqliteDatabase | null = null;

  // Prepared statements (lazy-initialized after open).
  #stmtInsertJob: SqliteStatement | null = null;
  #stmtClaimJob: SqliteStatement | null = null;
  #stmtListDue: SqliteStatement | null = null;
  #stmtMarkDone: SqliteStatement | null = null;
  #stmtMarkError: SqliteStatement | null = null;
  #stmtCancel: SqliteStatement | null = null;
  #stmtGetById: SqliteStatement | null = null;
  #stmtUpdateFireAt: SqliteStatement | null = null;
  #stmtAppendEvent: SqliteStatement | null = null;
  #stmtListEvents: SqliteStatement | null = null;

  constructor(opts: JobStoreOptions = {}) {
    this.stateDir = opts.stateDir ?? defaultStateDir();
    this.dbPath = path.join(this.stateDir, "scheduler.db");
    this.#now = opts.now ?? Date.now;
  }

  /** Open the database, run migrations, prepare statements. */
  async open(): Promise<void> {
    if (this.#db !== null) return;

    // Ensure state directory exists.
    fs.mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });

    this.#db = await openSqlite(this.dbPath);

    // Pragmas per spec (two-arg form for the adapter).
    this.#db.pragma("journal_mode", "WAL");
    this.#db.pragma("synchronous", "NORMAL");
    this.#db.pragma("busy_timeout", 2000);
    this.#db.pragma("foreign_keys", "ON");

    this.#migrate();
    this.#prepareStatements();
  }

  /** Close the database cleanly. */
  close(): void {
    if (this.#db === null) return;
    this.#db.close();
    this.#db = null;
    this.#stmtInsertJob = null;
    this.#stmtClaimJob = null;
    this.#stmtListDue = null;
    this.#stmtMarkDone = null;
    this.#stmtMarkError = null;
    this.#stmtCancel = null;
    this.#stmtGetById = null;
    this.#stmtUpdateFireAt = null;
    this.#stmtAppendEvent = null;
    this.#stmtListEvents = null;
  }

  get isOpen(): boolean {
    return this.#db !== null;
  }

  // -------------------------------------------------------------------------
  // Migrations
  // -------------------------------------------------------------------------

  #migrate(): void {
    const db = this.#requireDb();

    // Create schema_version table if not exists.
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY
      );
    `);

    const row = db.prepare("SELECT version FROM schema_version LIMIT 1").get() as
      | { version: number }
      | undefined;
    const currentVersion = row?.version ?? 0;

    if (currentVersion >= CURRENT_SCHEMA_VERSION) {
      return; // Already at current version.
    }

    // Migration v0 → v1
    if (currentVersion < 1) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS jobs (
          id             TEXT PRIMARY KEY,
          kind           TEXT NOT NULL,
          fire_at        INTEGER NOT NULL,
          cron_expr      TEXT,
          payload        TEXT NOT NULL,
          created_at     INTEGER NOT NULL,
          last_fired_at  INTEGER,
          fire_count     INTEGER NOT NULL DEFAULT 0,
          status         TEXT NOT NULL,
          error          TEXT,
          owner          TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_jobs_fire_at ON jobs (status, fire_at);

        CREATE TABLE IF NOT EXISTS job_events (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          job_id     TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
          ts         INTEGER NOT NULL,
          event      TEXT NOT NULL,
          detail     TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_job_events_job_id ON job_events (job_id);
      `);
    }

    // Update schema_version.
    db.prepare("DELETE FROM schema_version").run();
    db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(CURRENT_SCHEMA_VERSION);
  }

  #prepareStatements(): void {
    const db = this.#requireDb();

    this.#stmtInsertJob = db.prepare(`
      INSERT INTO jobs (id, kind, fire_at, cron_expr, payload, created_at, last_fired_at, fire_count, status, error, owner)
      VALUES (@id, @kind, @fire_at, @cron_expr, @payload, @created_at, @last_fired_at, @fire_count, @status, @error, @owner)
    `);

    this.#stmtClaimJob = db.prepare(`
      UPDATE jobs SET status = 'running'
      WHERE id = ? AND status = 'pending'
      RETURNING *
    `);

    this.#stmtListDue = db.prepare(`
      SELECT * FROM jobs
      WHERE status = 'pending' AND fire_at <= ?
      ORDER BY fire_at ASC
    `);

    this.#stmtMarkDone = db.prepare(`
      UPDATE jobs
      SET status = 'done', last_fired_at = ?, fire_count = fire_count + 1
      WHERE id = ?
    `);

    this.#stmtMarkError = db.prepare(`
      UPDATE jobs
      SET status = 'failed', error = ?, last_fired_at = ?
      WHERE id = ?
    `);

    this.#stmtCancel = db.prepare(`
      UPDATE jobs
      SET status = 'cancelled'
      WHERE id = ? AND status = 'pending'
    `);

    this.#stmtGetById = db.prepare(`
      SELECT * FROM jobs WHERE id = ?
    `);

    this.#stmtUpdateFireAt = db.prepare(`
      UPDATE jobs
      SET fire_at = ?, status = 'pending', fire_count = fire_count + 1, last_fired_at = ?
      WHERE id = ?
    `);

    this.#stmtAppendEvent = db.prepare(`
      INSERT INTO job_events (job_id, ts, event, detail)
      VALUES (?, ?, ?, ?)
    `);

    this.#stmtListEvents = db.prepare(`
      SELECT * FROM job_events
      WHERE job_id = ?
      ORDER BY ts ASC
    `);
  }

  #requireDb(): SqliteDatabase {
    if (this.#db === null) {
      throw new Error("JobStore: database not open. Call open() first.");
    }
    return this.#db;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Insert a new job. Throws on duplicate id. */
  insertJob(input: InsertJobInput): Job {
    const db = this.#requireDb();
    const now = this.#now();

    const job: Job = {
      id: input.id,
      kind: input.kind,
      fire_at: input.fire_at,
      cron_expr: input.cron_expr ?? null,
      payload: input.payload,
      created_at: now,
      last_fired_at: null,
      fire_count: 0,
      status: "pending",
      error: null,
      owner: input.owner,
    };

    db.exec("BEGIN IMMEDIATE");
    try {
      this.#stmtInsertJob?.run(job);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }

    return job;
  }

  /** Atomically claim a job for firing. Returns the job if claimed, undefined if already claimed/cancelled. */
  claimJob(id: string): Job | undefined {
    const db = this.#requireDb();
    db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#stmtClaimJob?.get(id) as Record<string, unknown> | undefined;
      db.exec("COMMIT");
      if (!row) return undefined;
      return Job.parse(row);
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  /** List jobs due at or before the given time. */
  listDue(atOrBefore: number): Job[] {
    const rows = this.#stmtListDue?.all(atOrBefore) as Record<string, unknown>[];
    return rows.map((r) => Job.parse(r));
  }

  /** Mark a job as done. */
  markDone(id: string, firedAt?: number): void {
    const db = this.#requireDb();
    const ts = firedAt ?? this.#now();
    db.exec("BEGIN IMMEDIATE");
    try {
      this.#stmtMarkDone?.run([ts, id]);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  /** Mark a job as failed with an error message. */
  markError(id: string, error: string, firedAt?: number): void {
    const db = this.#requireDb();
    const ts = firedAt ?? this.#now();
    db.exec("BEGIN IMMEDIATE");
    try {
      this.#stmtMarkError?.run([error, ts, id]);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  /** Cancel a pending job. Returns true if cancelled, false if not found or not pending. */
  cancel(id: string): boolean {
    const db = this.#requireDb();
    if (!this.#stmtCancel) {
      throw new Error("JobStore: cancel statement not prepared");
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.#stmtCancel.run(id);
      db.exec("COMMIT");
      return result.changes > 0;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  /** List all jobs, optionally filtered. */
  listAll(filter?: ListFilter): Job[] {
    const db = this.#requireDb();

    // Build query with optional filters.
    let sql = "SELECT * FROM jobs WHERE 1=1";
    const params: unknown[] = [];

    if (filter?.status) {
      sql += " AND status = ?";
      params.push(filter.status);
    }
    if (filter?.owner) {
      sql += " AND owner = ?";
      params.push(filter.owner);
    }
    if (filter?.kind) {
      sql += " AND kind = ?";
      params.push(filter.kind);
    }
    sql += " ORDER BY created_at DESC";

    const rows = db.prepare(sql).all(params) as Record<string, unknown>[];
    return rows.map((r) => Job.parse(r));
  }

  /** Get a job by id. */
  getById(id: string): Job | undefined {
    const row = this.#stmtGetById?.get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return Job.parse(row);
  }

  /** Update fire_at for a cron job (reschedule). */
  updateFireAt(id: string, nextFireAt: number, lastFiredAt?: number): void {
    const db = this.#requireDb();
    const ts = lastFiredAt ?? this.#now();
    db.exec("BEGIN IMMEDIATE");
    try {
      this.#stmtUpdateFireAt?.run([nextFireAt, ts, id]);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  /** Append an event to the job_events table. */
  appendEvent(jobId: string, event: JobEventType, detail?: string): void {
    const db = this.#requireDb();
    const ts = this.#now();
    db.exec("BEGIN IMMEDIATE");
    try {
      this.#stmtAppendEvent?.run([jobId, ts, event, detail ?? null]);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  /** List events for a job. */
  listEvents(jobId: string): JobEvent[] {
    const rows = this.#stmtListEvents?.all(jobId) as Record<string, unknown>[];
    return rows.map((r) => JobEvent.parse(r));
  }

  /** Count pending jobs. */
  countPending(): number {
    const db = this.#requireDb();
    const row = db.prepare("SELECT COUNT(*) as count FROM jobs WHERE status = 'pending'").get() as {
      count: number;
    };
    return row.count;
  }

  /** Count running jobs. */
  countRunning(): number {
    const db = this.#requireDb();
    const row = db.prepare("SELECT COUNT(*) as count FROM jobs WHERE status = 'running'").get() as {
      count: number;
    };
    return row.count;
  }

  /** Get the next due job's fire_at (or null if none pending). */
  nextDueAt(): number | null {
    const db = this.#requireDb();
    const row = db
      .prepare("SELECT MIN(fire_at) as next FROM jobs WHERE status = 'pending'")
      .get() as { next: number | null };
    return row.next;
  }

  /** Force WAL checkpoint (for testing / maintenance). */
  checkpoint(): void {
    const db = this.#requireDb();
    db.pragma("wal_checkpoint(TRUNCATE)");
  }

  /** Get current schema version. */
  getSchemaVersion(): number {
    const db = this.#requireDb();
    const row = db.prepare("SELECT version FROM schema_version LIMIT 1").get() as
      | { version: number }
      | undefined;
    return row?.version ?? 0;
  }
}
