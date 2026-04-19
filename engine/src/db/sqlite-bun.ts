/**
 * Phase 08 T5-04 — Bun SQLite backend.
 *
 * Wraps `bun:sqlite` to match the SqliteDatabase interface.
 * Key differences from better-sqlite3:
 * - `db.pragma()` doesn't exist — emulate with `db.query("PRAGMA ...").get()`
 * - Constructor takes `{ create: true }` option
 * - `db.query()` is the primary API (`.prepare()` is an alias)
 */

import type { SqliteDatabase, SqliteRunResult, SqliteStatement } from "./sqlite.js";

// Note: This file is only imported when running under Bun.
// TypeScript may complain about "bun:sqlite" when type-checking under Node.
// We use dynamic import and type assertions to handle this.

export interface OpenBunOptions {
  readonly?: boolean;
}

/**
 * Open a SQLite database using Bun's built-in sqlite.
 */
export function openBun(path: string, options?: OpenBunOptions): SqliteDatabase {
  // Dynamic require to avoid TypeScript issues when type-checking under Node
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Database } = require("bun:sqlite") as {
    Database: new (
      path: string,
      options?: { create?: boolean; readonly?: boolean },
    ) => BunDatabase;
  };

  const readonly = options?.readonly ?? false;
  const db = new Database(path, { create: !readonly, readonly });

  // Track open state manually since Bun's Database may not expose it
  let isOpen = true;

  return {
    get open(): boolean {
      return isOpen;
    },

    exec(sql: string): void {
      db.exec(sql);
    },

    prepare(sql: string): SqliteStatement {
      const stmt = db.query(sql);
      return wrapStatement(stmt);
    },

    pragma(key: string, value?: string | number): unknown {
      const sql = value !== undefined ? `PRAGMA ${key} = ${value}` : `PRAGMA ${key}`;
      return db.query(sql).all();
    },

    transaction<Args extends unknown[], R>(fn: (...args: Args) => R): (...args: Args) => R {
      return db.transaction(fn);
    },

    close(): void {
      db.close();
      isOpen = false;
    },
  };
}

// ---------------------------------------------------------------------------
// Internal types for Bun's sqlite
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

// ---------------------------------------------------------------------------
// Statement wrapper
// ---------------------------------------------------------------------------

function wrapStatement(stmt: BunStatement): SqliteStatement {
  return {
    run(params?: unknown): SqliteRunResult {
      // Bun's .run() can take spread args or a single object/array
      const result = params !== undefined ? stmt.run(params) : stmt.run();
      return {
        changes: result.changes,
        lastInsertRowid: result.lastInsertRowid,
      };
    },

    get(params?: unknown): unknown {
      return params !== undefined ? stmt.get(params) : stmt.get();
    },

    all(params?: unknown): unknown[] {
      return params !== undefined ? stmt.all(params) : stmt.all();
    },

    *iterate(params?: unknown): IterableIterator<unknown> {
      // Bun doesn't have a native iterate, so we use all() and yield
      const rows = params !== undefined ? stmt.all(params) : stmt.all();
      for (const row of rows) {
        yield row;
      }
    },
  };
}
