/**
 * Phase 08 T5-04 — Dual-backend SQLite adapter.
 *
 * Provides a unified interface for SQLite that works with both:
 * - `bun:sqlite` (Bun runtime) — zero native-addon footprint for single-binary
 * - `better-sqlite3` (Node runtime) — for npx, Docker, users without Bun
 *
 * Runtime selection happens at `openSqlite()` time via dynamic import.
 */

// ---------------------------------------------------------------------------
// Adapter interfaces
// ---------------------------------------------------------------------------

export interface SqliteRunResult {
  readonly changes: number;
  readonly lastInsertRowid: number | bigint;
}

export interface SqliteStatement {
  run(params?: unknown): SqliteRunResult;
  get(params?: unknown): unknown;
  all(params?: unknown): unknown[];
  iterate(params?: unknown): IterableIterator<unknown>;
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
  // Check for Bun runtime
  if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") {
    const mod = await import("./sqlite-bun.js");
    return mod.openBun(path, { readonly });
  }
  // Fallback to better-sqlite3 (Node)
  const mod = await import("./sqlite-better.js");
  return mod.openBetter(path, { readonly });
}

// Re-export types for consumers
export type { SqliteDatabase as Database, SqliteStatement as Statement };
