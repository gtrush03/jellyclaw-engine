/**
 * Monitor registry for background process monitoring (T4-04).
 *
 * Persists monitor state in the scheduler's SQLite database with a
 * dedicated `monitors` table. Monitors can be persistent (survive daemon
 * restart) or ephemeral.
 *
 * Uses the runtime SQLite shim (`db/sqlite.ts`) so the monitor pipeline
 * (and the `Monitor` tool that triggers it) works under both Bun and Node.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { z } from "zod";

import {
  type Database as DatabaseType,
  openSqliteSync,
  type Statement,
} from "../db/sqlite.js";

// ---------------------------------------------------------------------------
// Zod schemas — types flow FROM Zod (per CLAUDE.md convention).
// ---------------------------------------------------------------------------

export const MonitorKind = z.enum(["tail", "watch", "cmd"]);
export type MonitorKind = z.infer<typeof MonitorKind>;

export const MonitorStatus = z.enum(["running", "stopped", "exhausted", "error"]);
export type MonitorStatus = z.infer<typeof MonitorStatus>;

export const MonitorNotify = z.enum(["agent", "user"]);
export type MonitorNotify = z.infer<typeof MonitorNotify>;

export const Monitor = z.object({
  id: z.string(),
  owner: z.string(),
  kind: MonitorKind,
  target: z.string(),
  pattern: z.string().nullable(),
  max_lines: z.number().int().nullable(),
  persistent: z.boolean(),
  notify: MonitorNotify,
  status: MonitorStatus,
  events_emitted: z.number().int().nonnegative(),
  started_at: z.number().int(),
  stopped_at: z.number().int().nullable(),
  error: z.string().nullable(),
});
export type Monitor = z.infer<typeof Monitor>;

export const CreateMonitorInput = z.object({
  id: z.string().min(1),
  owner: z.string().min(1),
  kind: MonitorKind,
  target: z.string().min(1),
  pattern: z.string().nullable().optional(),
  max_lines: z.number().int().positive().nullable().optional(),
  persistent: z.boolean().optional(),
  notify: MonitorNotify.optional(),
});
export type CreateMonitorInput = z.infer<typeof CreateMonitorInput>;

// ---------------------------------------------------------------------------
// Current schema version for monitors table.
// ---------------------------------------------------------------------------

const MONITORS_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Default path helpers.
// ---------------------------------------------------------------------------

function defaultStateDir(): string {
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg && xdg.length > 0) {
    return path.join(xdg, "jellyclaw");
  }
  return path.join(os.homedir(), ".jellyclaw");
}

export interface MonitorRegistryOptions {
  /** Directory containing scheduler.db. */
  stateDir?: string | undefined;
  /** Injectable clock. Defaults to Date.now. */
  now?: (() => number) | undefined;
}

// ---------------------------------------------------------------------------
// MonitorRegistry class
// ---------------------------------------------------------------------------

export class MonitorRegistry {
  readonly dbPath: string;
  readonly stateDir: string;
  readonly #now: () => number;
  #db: DatabaseType | null = null;

  // Prepared statements (lazy-initialized after open).
  #stmtInsert: Statement | null = null;
  #stmtGetById: Statement | null = null;
  #stmtListByOwner: Statement | null = null;
  #stmtListPersistent: Statement | null = null;
  #stmtIncrementEmitted: Statement | null = null;
  #stmtMarkStopped: Statement | null = null;
  #stmtMarkExhausted: Statement | null = null;
  #stmtMarkError: Statement | null = null;
  #stmtDelete: Statement | null = null;

  constructor(opts: MonitorRegistryOptions = {}) {
    this.stateDir = opts.stateDir ?? defaultStateDir();
    this.dbPath = path.join(this.stateDir, "scheduler.db");
    this.#now = opts.now ?? Date.now;
  }

  /** Open the database, run migrations, prepare statements. */
  open(): void {
    if (this.#db !== null) return;

    // Ensure state directory exists.
    fs.mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });

    this.#db = openSqliteSync(this.dbPath);

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
    this.#stmtInsert = null;
    this.#stmtGetById = null;
    this.#stmtListByOwner = null;
    this.#stmtListPersistent = null;
    this.#stmtIncrementEmitted = null;
    this.#stmtMarkStopped = null;
    this.#stmtMarkExhausted = null;
    this.#stmtMarkError = null;
    this.#stmtDelete = null;
  }

  get isOpen(): boolean {
    return this.#db !== null;
  }

  // -------------------------------------------------------------------------
  // Migrations
  // -------------------------------------------------------------------------

  #migrate(): void {
    const db = this.#requireDb();

    // Create monitors_schema_version table if not exists.
    db.exec(`
      CREATE TABLE IF NOT EXISTS monitors_schema_version (
        version INTEGER PRIMARY KEY
      );
    `);

    const row = db.prepare("SELECT version FROM monitors_schema_version LIMIT 1").get() as
      | { version: number }
      | undefined;
    const currentVersion = row?.version ?? 0;

    if (currentVersion >= MONITORS_SCHEMA_VERSION) {
      return; // Already at current version.
    }

    // Migration v0 -> v1
    if (currentVersion < 1) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS monitors (
          id              TEXT PRIMARY KEY,
          owner           TEXT NOT NULL,
          kind            TEXT NOT NULL,
          target          TEXT NOT NULL,
          pattern         TEXT,
          max_lines       INTEGER,
          persistent      INTEGER NOT NULL,
          notify          TEXT NOT NULL,
          status          TEXT NOT NULL,
          events_emitted  INTEGER NOT NULL DEFAULT 0,
          started_at      INTEGER NOT NULL,
          stopped_at      INTEGER,
          error           TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_monitors_owner_status ON monitors (owner, status);
        CREATE INDEX IF NOT EXISTS idx_monitors_persistent ON monitors (persistent, status);
      `);
    }

    // Update schema_version.
    db.prepare("DELETE FROM monitors_schema_version").run();
    db.prepare("INSERT INTO monitors_schema_version (version) VALUES (?)").run(
      MONITORS_SCHEMA_VERSION,
    );
  }

  #prepareStatements(): void {
    const db = this.#requireDb();

    this.#stmtInsert = db.prepare(`
      INSERT INTO monitors (id, owner, kind, target, pattern, max_lines, persistent, notify, status, events_emitted, started_at, stopped_at, error)
      VALUES (@id, @owner, @kind, @target, @pattern, @max_lines, @persistent, @notify, @status, @events_emitted, @started_at, @stopped_at, @error)
    `);

    this.#stmtGetById = db.prepare(`
      SELECT * FROM monitors WHERE id = ?
    `);

    this.#stmtListByOwner = db.prepare(`
      SELECT * FROM monitors WHERE owner = ? ORDER BY started_at DESC
    `);

    this.#stmtListPersistent = db.prepare(`
      SELECT * FROM monitors WHERE persistent = 1 AND status = 'running'
    `);

    this.#stmtIncrementEmitted = db.prepare(`
      UPDATE monitors SET events_emitted = events_emitted + ? WHERE id = ?
    `);

    this.#stmtMarkStopped = db.prepare(`
      UPDATE monitors SET status = 'stopped', stopped_at = ? WHERE id = ?
    `);

    this.#stmtMarkExhausted = db.prepare(`
      UPDATE monitors SET status = 'exhausted', stopped_at = ? WHERE id = ?
    `);

    this.#stmtMarkError = db.prepare(`
      UPDATE monitors SET status = 'error', stopped_at = ?, error = ? WHERE id = ?
    `);

    this.#stmtDelete = db.prepare(`
      DELETE FROM monitors WHERE id = ?
    `);
  }

  #requireDb(): DatabaseType {
    if (this.#db === null) {
      throw new Error("MonitorRegistry: database not open. Call open() first.");
    }
    return this.#db;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Create a new monitor. Returns the created Monitor object. */
  create(input: CreateMonitorInput): Monitor {
    const db = this.#requireDb();
    const now = this.#now();

    const monitor: Monitor = {
      id: input.id,
      owner: input.owner,
      kind: input.kind,
      target: input.target,
      pattern: input.pattern ?? null,
      max_lines: input.max_lines ?? null,
      persistent: input.persistent ?? false,
      notify: input.notify ?? "agent",
      status: "running",
      events_emitted: 0,
      started_at: now,
      stopped_at: null,
      error: null,
    };

    db.exec("BEGIN IMMEDIATE");
    try {
      this.#stmtInsert?.run({
        ...monitor,
        persistent: monitor.persistent ? 1 : 0,
      });
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }

    return monitor;
  }

  /** Get a monitor by ID. Returns undefined if not found. */
  getById(id: string): Monitor | undefined {
    const row = this.#stmtGetById?.get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return this.#rowToMonitor(row);
  }

  /** Get a monitor by ID and owner. Returns undefined if not found or wrong owner. */
  getByIdAndOwner(id: string, owner: string): Monitor | undefined {
    const monitor = this.getById(id);
    if (monitor && monitor.owner === owner) {
      return monitor;
    }
    return undefined;
  }

  /** List all monitors for an owner. */
  listAll(owner: string): Monitor[] {
    const rows = this.#stmtListByOwner?.all(owner) as Record<string, unknown>[];
    return rows.map((r) => this.#rowToMonitor(r));
  }

  /** List all persistent running monitors (for daemon restart recovery). */
  listPersistent(): Monitor[] {
    const rows = this.#stmtListPersistent?.all() as Record<string, unknown>[];
    return rows.map((r) => this.#rowToMonitor(r));
  }

  /** Mark a monitor as stopped. */
  markStopped(id: string): void {
    const db = this.#requireDb();
    const now = this.#now();
    db.exec("BEGIN IMMEDIATE");
    try {
      this.#stmtMarkStopped?.run(now, id);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  /** Mark a monitor as exhausted (max_lines reached). */
  markExhausted(id: string): void {
    const db = this.#requireDb();
    const now = this.#now();
    db.exec("BEGIN IMMEDIATE");
    try {
      this.#stmtMarkExhausted?.run(now, id);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  /** Mark a monitor as error. */
  markError(id: string, error: string): void {
    const db = this.#requireDb();
    const now = this.#now();
    db.exec("BEGIN IMMEDIATE");
    try {
      this.#stmtMarkError?.run(now, error, id);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  /** Increment the events_emitted counter. */
  incrementEmitted(id: string, count: number = 1): void {
    this.#requireDb();
    this.#stmtIncrementEmitted?.run(count, id);
  }

  /** Delete a monitor from the registry. */
  delete(id: string): boolean {
    const db = this.#requireDb();
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.#stmtDelete?.run(id);
      db.exec("COMMIT");
      return (result?.changes ?? 0) > 0;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  /** Mark all non-persistent running monitors as stopped (daemon restart). */
  markNonPersistentStopped(): number {
    const db = this.#requireDb();
    const now = this.#now();
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = db
        .prepare(
          `UPDATE monitors
           SET status = 'stopped', stopped_at = ?, error = 'daemon_restart'
           WHERE persistent = 0 AND status = 'running'`,
        )
        .run(now);
      db.exec("COMMIT");
      return result.changes;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  /** Check if a monitor exists. */
  exists(id: string): boolean {
    return this.getById(id) !== undefined;
  }

  #rowToMonitor(row: Record<string, unknown>): Monitor {
    return Monitor.parse({
      ...row,
      persistent: row.persistent === 1,
    });
  }
}
