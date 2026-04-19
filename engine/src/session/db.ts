/**
 * Session index database (Phase 09.01).
 *
 * Opens (and lazily migrates) the shared SQLite index at
 * `~/.jellyclaw/sessions/index.sqlite`. Responsibilities:
 *
 *   1. Ensure the enclosing directory exists.
 *   2. Open better-sqlite3 and apply WAL/NORMAL/foreign-keys pragmas.
 *   3. Run `PRAGMA integrity_check`; on corruption, rename the DB (+ `-wal`
 *      / `-shm` sidecars) to `index.sqlite.corrupt-<epochMs>`, log a loud
 *      warning, and reopen a fresh DB. Phase 09.02 will reconcile from
 *      JSONL logs — this module only concerns itself with getting a
 *      usable DB open.
 *   4. Apply migrations in order. v1 is the only migration today; the
 *      `MIGRATIONS` list below is designed to accept v2+ in future without
 *      structural changes (each migration is wrapped in a transaction and
 *      only applied if its version is greater than the current).
 *
 * Writer/reader code (Agent B) consumes `Db.raw` directly; this file owns
 * only the open/migrate/close lifecycle.
 */

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import type { Logger } from "pino";

import { openSqlite, type SqliteDatabase } from "../db/sqlite.js";
import { createLogger } from "../logger.js";
import type { SessionPaths } from "./paths.js";

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

export interface OpenDbOptions {
  /** Filesystem paths. Tests inject a temp home via `new SessionPaths({ home })`. */
  paths: SessionPaths;
  /** Open read-only (no migrations will be applied). Default: false. */
  readonly?: boolean;
  /** Override the default pino logger. */
  logger?: Logger;
}

export interface Db {
  /** Escape hatch for writer.ts / fts.ts (Agent B). */
  readonly raw: SqliteDatabase;
  readonly paths: SessionPaths;
  close(): void;
}

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

interface Migration {
  readonly v: number;
  readonly sqlUrl: URL;
}

/**
 * Ordered migration list. Add future migrations (v2, v3, ...) here. Each
 * entry points to an SQL file loaded via `readFileSync(new URL(...))` so
 * the bundled `dist/` ships the SQL alongside the JS.
 */
const MIGRATIONS: readonly Migration[] = [
  { v: 1, sqlUrl: new URL("./schema.sql", import.meta.url) },
];

function currentSchemaVersion(db: SqliteDatabase): number {
  // `schema_version` may not exist yet on a freshly-created DB.
  const tableExists = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'")
    .get() as { name: string } | undefined;
  if (!tableExists) return 0;
  const row = db.prepare("SELECT v FROM schema_version ORDER BY v DESC LIMIT 1").get() as
    | { v: number }
    | undefined;
  return row?.v ?? 0;
}

/**
 * Strip top-level `PRAGMA ...;` statements from a migration SQL file.
 *
 * The v1 `schema.sql` lists `PRAGMA journal_mode/synchronous/foreign_keys`
 * at the top as documentation and as the source-of-truth for
 * `sqlite3 <db> ".schema"` output. better-sqlite3 refuses to change
 * `journal_mode`/`synchronous` inside a transaction (they alter WAL
 * safety invariants), and `applyRuntimePragmas` already set them via
 * `db.pragma()` before migrations run. So we strip them here — the DDL
 * is what we actually want wrapped in `BEGIN/COMMIT`.
 *
 * Conservative regex: only matches lines that are wholly a PRAGMA
 * statement (optionally indented, optionally with inline comments).
 * Anything else — including PRAGMAs inside a trigger body — is left
 * alone. schema.sql has no such cases today; add a test if that changes.
 */
function stripTopLevelPragmas(sql: string): string {
  return sql.replace(/^[ \t]*PRAGMA[^;]*;[ \t]*(?:--[^\n]*)?\r?\n?/gim, "");
}

function applyMigrations(db: SqliteDatabase, logger: Logger): void {
  const before = currentSchemaVersion(db);
  for (const migration of MIGRATIONS) {
    if (migration.v <= before) continue;
    const sql = stripTopLevelPragmas(readFileSync(migration.sqlUrl, "utf8"));
    const run = db.transaction(() => {
      db.exec(sql);
    });
    run();
    logger.debug({ v: migration.v }, "session-db: applied migration");
  }
  const after = currentSchemaVersion(db);
  const latest = MIGRATIONS[MIGRATIONS.length - 1]?.v ?? 0;
  if (after !== latest) {
    throw new Error(`session-db: migration runner left schema at v${after}, expected v${latest}`);
  }
}

// ---------------------------------------------------------------------------
// Corruption handling
// ---------------------------------------------------------------------------

interface IntegrityRow {
  integrity_check: string;
}

function isIntegrityOk(db: SqliteDatabase): boolean {
  // A badly corrupt file (e.g. zero-length, garbage header) can cause
  // `PRAGMA integrity_check` itself to throw ("file is not a database").
  // Treat any throw as "not ok" — the caller will quarantine and reopen.
  let rows: IntegrityRow[];
  try {
    rows = db.pragma("integrity_check") as IntegrityRow[];
  } catch {
    return false;
  }
  return rows.length === 1 && rows[0]?.integrity_check === "ok";
}

/**
 * Quarantine a corrupt DB. Renames `<path>`, `<path>-wal`, `<path>-shm` to
 * `<path>.corrupt-<epochMs>[-wal|-shm]`. Best-effort — if a rename fails,
 * we log and continue; the caller will open a fresh DB regardless.
 */
function quarantineCorruptDb(dbPath: string, logger: Logger): string {
  const suffix = `corrupt-${Date.now()}`;
  const targets: Array<{ from: string; to: string }> = [
    { from: dbPath, to: `${dbPath}.${suffix}` },
    { from: `${dbPath}-wal`, to: `${dbPath}.${suffix}-wal` },
    { from: `${dbPath}-shm`, to: `${dbPath}.${suffix}-shm` },
  ];
  for (const { from, to } of targets) {
    try {
      statSync(from);
    } catch {
      continue; // sidecar doesn't exist
    }
    try {
      renameSync(from, to);
    } catch (err) {
      logger.warn({ err, from, to }, "session-db: failed to rename corrupt DB sidecar; continuing");
    }
  }
  return `${dbPath}.${suffix}`;
}

// ---------------------------------------------------------------------------
// Pragmas
// ---------------------------------------------------------------------------

interface JournalModeRow {
  journal_mode: string;
}

function applyRuntimePragmas(db: SqliteDatabase, logger: Logger): void {
  // `journal_mode = WAL` returns the new mode; assert it actually took.
  // Network filesystems (NFS/SMB) may silently fall back to `delete`.
  const journalRows = db.pragma("journal_mode", "WAL") as JournalModeRow[];
  const journal = journalRows[0]?.journal_mode;
  if (journal !== "wal") {
    logger.warn(
      { journal },
      "session-db: WAL mode not enabled (possibly shared/network filesystem)",
    );
  }
  db.pragma("synchronous", "NORMAL");
  db.pragma("foreign_keys", "ON");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Open (and migrate, if needed) the session index DB. Creates the
 * enclosing directory if missing. On integrity-check failure, the corrupt
 * file is quarantined and a fresh DB is opened and migrated; Phase 09.02
 * will rebuild rows from JSONL logs.
 */
export async function openDb(opts: OpenDbOptions): Promise<Db> {
  // `async` is kept for API stability: Phase 09.02 will add real async
  // work here (reconciliation from JSONL). For now, yield once so the
  // signature is honest and biome's `useAwait` rule is satisfied.
  await Promise.resolve();

  const { paths, readonly = false } = opts;
  const logger = opts.logger ?? createLogger({ name: "session-db" });

  mkdirSync(paths.sessionsRoot(), { recursive: true });

  const dbPath = paths.indexDb();
  let db = await openSqlite(dbPath, { readonly });

  // Integrity check first — if it fails, quarantine and reopen.
  if (!readonly && !isIntegrityOk(db)) {
    const quarantinedTo = quarantineCorruptDb(dbPath, logger);
    try {
      db.close();
    } catch {
      // already closed / corrupt — nothing to do
    }
    logger.warn(
      { dbPath, quarantinedTo },
      "session-db: CORRUPT database detected; quarantined and reopening fresh",
    );
    db = await openSqlite(dbPath, { readonly });
  }

  applyRuntimePragmas(db, logger);

  if (!readonly) {
    applyMigrations(db, logger);
  }

  return {
    raw: db,
    paths,
    close(): void {
      // Truncate the WAL before closing so the primary DB file contains all
      // committed data. Without this, a second process opening the DB on the
      // same filesystem can still read committed rows (SQLite reads both DB
      // + WAL), but external inspectors and integrity checks lag behind, and
      // a crashed shm/wal sidecar could make the committed data appear
      // missing. Best-effort — if the checkpoint itself throws (e.g. locked
      // by another writer) we still close the handle.
      try {
        db.pragma("wal_checkpoint(TRUNCATE)");
      } catch {
        /* non-fatal; close() will still flush on the OS side */
      }
      db.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Internal helpers (exported for tests only — not part of the public API)
// ---------------------------------------------------------------------------

/** @internal */
export const __testing = {
  currentSchemaVersion,
  MIGRATIONS,
  /**
   * Simulate a corrupt DB by overwriting the index file with garbage. Used
   * by `db.test.ts`. Exposed here so the test doesn't duplicate path math.
   */
  writeGarbageAt(path: string): void {
    writeFileSync(path, Buffer.alloc(100, 0xff));
  },
};
