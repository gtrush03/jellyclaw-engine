/**
 * Phase 08 T5-04 — Dual-backend SQLite adapter (runtime shim).
 *
 * Provides a unified, synchronous SQLite interface that works with:
 * - `bun:sqlite` (Bun runtime) — built-in, zero native-addon footprint
 * - `better-sqlite3` (Node runtime) — for npx, Docker, users without Bun
 *
 * Two entry points:
 * - `openSqlite()` — async, uses dynamic `import()` (preferred for code paths
 *    that already live behind an `await`, e.g. the scheduler `JobStore`)
 * - `openSqliteSync()` — synchronous, uses lazy `createRequire()` (required
 *    for consumers whose `open()` lifecycle is sync, e.g. `TeamRegistry`,
 *    `MonitorRegistry`; converting them to async would cascade through every
 *    call site — `getRegistry()`, `start()`, scheduler/handler bootstraps —
 *    so we keep the surface sync here)
 *
 * Runtime detection: prefer `bun:sqlite` if running under Bun, else
 * `better-sqlite3`. This is the single chokepoint that keeps the
 * bun-launched TUI from hitting `ERR_DLOPEN_FAILED` on better-sqlite3's
 * native addon.
 *
 * Why we don't statically `import` either backend at the top of this file:
 * `import Database from "better-sqlite3"` would force native-addon loading
 * the moment the shim is touched under Bun — exactly the crash we're
 * trying to avoid. Both packages are loaded lazily, inside the runtime
 * branch that needs them.
 */

import { createRequire } from "node:module";

// ---------------------------------------------------------------------------
// Adapter interfaces
// ---------------------------------------------------------------------------

export interface SqliteRunResult {
  readonly changes: number;
  readonly lastInsertRowid: number | bigint;
}

export interface SqliteStatement {
  /**
   * Run a prepared statement.
   *
   * Accepts the union of forms both backends support:
   * - no args (statement has no placeholders)
   * - a single object/array of named/positional bindings
   * - spread positional bindings (e.g. `stmt.run(a, b, c)`)
   */
  run(...params: unknown[]): SqliteRunResult;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  iterate(...params: unknown[]): IterableIterator<unknown>;
}

export interface SqliteDatabase {
  /**
   * Whether the database connection is open.
   */
  readonly open: boolean;

  /**
   * Execute raw SQL (may be multi-statement). No return value.
   */
  exec(sql: string): void;

  /**
   * Prepare a statement for repeated execution.
   */
  prepare(sql: string): SqliteStatement;

  /**
   * Execute a PRAGMA. Two-arg form: `db.pragma("journal_mode", "WAL")`.
   * One-arg form for queries: `db.pragma("integrity_check")`.
   * Returns the result of the PRAGMA query.
   */
  pragma(key: string, value?: string | number): unknown;

  /**
   * Wrap a function in a transaction. The returned function, when called,
   * executes `fn` inside BEGIN/COMMIT, rolling back on error.
   */
  transaction<Args extends unknown[], R>(fn: (...args: Args) => R): (...args: Args) => R;

  /**
   * Close the database connection.
   */
  close(): void;
}

// ---------------------------------------------------------------------------
// Runtime picker
// ---------------------------------------------------------------------------

export interface OpenSqliteOptions {
  /** Open the database in read-only mode. Default: false. */
  readonly?: boolean;
}

/** True iff the current process is the Bun runtime. */
export function isBun(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
}

/**
 * Open a SQLite database using the appropriate backend for the current runtime.
 *
 * - Under Bun: uses `bun:sqlite` (no native addons)
 * - Under Node: uses `better-sqlite3`
 *
 * The returned handle is synchronous; only the initial `openSqlite()` is async
 * (because of dynamic `import()`).
 *
 * @param path - Path to the database file. Use `":memory:"` for in-memory DB.
 * @param options - Optional settings (e.g., readonly mode).
 */
export async function openSqlite(
  path: string,
  options?: OpenSqliteOptions,
): Promise<SqliteDatabase> {
  const readonly = options?.readonly ?? false;
  if (isBun()) {
    const mod = await import("./sqlite-bun.js");
    return mod.openBun(path, { readonly });
  }
  const mod = await import("./sqlite-better.js");
  return mod.openBetter(path, { readonly });
}

/**
 * Synchronous variant of `openSqlite()`.
 *
 * Required by consumers whose `open()` lifecycle is synchronous
 * (e.g. `TeamRegistry`, `MonitorRegistry`).
 *
 * Implementation note: rather than `require("./sqlite-better.js")`
 * (which is fragile across Node 20 / Node 22 / Bun ESM-from-CJS rules),
 * we inline the lazy native-package require here. Each branch only
 * touches the package it needs, so the bun branch never triggers
 * better-sqlite3's native addon loader.
 */
export function openSqliteSync(path: string, options?: OpenSqliteOptions): SqliteDatabase {
  const readonly = options?.readonly ?? false;
  if (isBun()) {
    return openBunSync(path, readonly);
  }
  return openBetterSync(path, readonly);
}

// ---------------------------------------------------------------------------
// Synchronous Bun backend (inlined; mirrors sqlite-bun.ts)
// ---------------------------------------------------------------------------

interface BunStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  values(...params: unknown[]): unknown[][];
}

interface BunDatabase {
  exec(sql: string): void;
  query(sql: string): BunStatement;
  transaction<Args extends unknown[], R>(fn: (...args: Args) => R): (...args: Args) => R;
  close(): void;
}

function openBunSync(path: string, readonly: boolean): SqliteDatabase {
  // `bun:sqlite` is a Bun built-in. createRequire works for built-in schemes
  // under Bun; using it keeps this branch synchronous.
  const req = createRequire(import.meta.url);
  const { Database } = req("bun:sqlite") as {
    Database: new (
      path: string,
      options?: { create?: boolean; readonly?: boolean },
    ) => BunDatabase;
  };

  const db = new Database(path, { create: !readonly, readonly });

  // Bun doesn't expose `.open` directly; track manually.
  let isOpen = true;

  return {
    get open(): boolean {
      return isOpen;
    },

    exec(sql: string): void {
      db.exec(sql);
    },

    prepare(sql: string): SqliteStatement {
      return wrapBunStatement(db.query(sql));
    },

    pragma(key: string, value?: string | number): unknown {
      const sql = value !== undefined ? `PRAGMA ${key} = ${value}` : `PRAGMA ${key}`;
      return db.query(sql).all();
    },

    transaction<Args extends unknown[], R>(fn: (...args: Args) => R): (...args: Args) => R {
      return db.transaction(fn);
    },

    close(): void {
      if (!isOpen) return;
      db.close();
      isOpen = false;
    },
  };
}

function wrapBunStatement(stmt: BunStatement): SqliteStatement {
  return {
    run(...params: unknown[]): SqliteRunResult {
      const adapted = adaptBunParams(params);
      const result = stmt.run(...adapted);
      return {
        changes: result.changes,
        lastInsertRowid: result.lastInsertRowid,
      };
    },

    get(...params: unknown[]): unknown {
      return stmt.get(...adaptBunParams(params));
    },

    all(...params: unknown[]): unknown[] {
      return stmt.all(...adaptBunParams(params));
    },

    *iterate(...params: unknown[]): IterableIterator<unknown> {
      const rows = stmt.all(...adaptBunParams(params));
      for (const row of rows) {
        yield row;
      }
    },
  };
}

/**
 * Adapt parameter shapes to bun:sqlite's binding rules.
 *
 * `bun:sqlite` requires named-parameter object keys to include the
 * placeholder sigil (e.g. `{ "@team_id": "x" }` for `@team_id`),
 * whereas `better-sqlite3` accepts bare keys (`{ team_id: "x" }`).
 *
 * This codebase uses `@`-prefixed placeholders everywhere (writer.ts,
 * team-registry.ts, monitor-registry.ts, daemon/store.ts), so for
 * cross-runtime portability we add prefixed copies of every bare key
 * and leave already-prefixed keys untouched. We deliberately don't
 * mutate the caller's object.
 */
function adaptBunParams(params: unknown[]): unknown[] {
  return params.map((p) => {
    if (
      p === null ||
      typeof p !== "object" ||
      Array.isArray(p) ||
      p instanceof Uint8Array ||
      ArrayBuffer.isView(p)
    ) {
      return p;
    }
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(p as Record<string, unknown>)) {
      if (key.startsWith("@") || key.startsWith("$") || key.startsWith(":")) {
        out[key] = value;
      } else {
        // Mirror under all three sigils so any placeholder style binds.
        out[`@${key}`] = value;
        out[`$${key}`] = value;
        out[`:${key}`] = value;
      }
    }
    return out;
  });
}

// ---------------------------------------------------------------------------
// Synchronous better-sqlite3 backend (inlined; mirrors sqlite-better.ts)
// ---------------------------------------------------------------------------

interface BetterStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  iterate(...params: unknown[]): IterableIterator<unknown>;
}

interface BetterDatabase {
  readonly open: boolean;
  exec(sql: string): void;
  prepare(sql: string): BetterStatement;
  pragma(sql: string): unknown;
  transaction<Args extends unknown[], R>(fn: (...args: Args) => R): (...args: Args) => R;
  close(): void;
}

function openBetterSync(path: string, readonly: boolean): SqliteDatabase {
  // CommonJS package; createRequire is the canonical sync loader.
  const req = createRequire(import.meta.url);
  const Database = req("better-sqlite3") as new (
    path: string,
    options?: { readonly?: boolean },
  ) => BetterDatabase;

  const db = new Database(path, { readonly });

  return {
    get open(): boolean {
      return db.open;
    },

    exec(sql: string): void {
      db.exec(sql);
    },

    prepare(sql: string): SqliteStatement {
      return wrapBetterStatement(db.prepare(sql));
    },

    pragma(key: string, value?: string | number): unknown {
      const pragmaStr = value !== undefined ? `${key} = ${value}` : key;
      return db.pragma(pragmaStr);
    },

    transaction<Args extends unknown[], R>(fn: (...args: Args) => R): (...args: Args) => R {
      return db.transaction(fn);
    },

    close(): void {
      db.close();
    },
  };
}

function wrapBetterStatement(stmt: BetterStatement): SqliteStatement {
  return {
    run(...params: unknown[]): SqliteRunResult {
      const result = stmt.run(...params);
      return {
        changes: result.changes,
        lastInsertRowid: result.lastInsertRowid,
      };
    },

    get(...params: unknown[]): unknown {
      return stmt.get(...params);
    },

    all(...params: unknown[]): unknown[] {
      return stmt.all(...params);
    },

    iterate(...params: unknown[]): IterableIterator<unknown> {
      return stmt.iterate(...params);
    },
  };
}

// Re-export types for consumers
export type { SqliteDatabase as Database, SqliteStatement as Statement };
