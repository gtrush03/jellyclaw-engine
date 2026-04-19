/**
 * Phase 08 T5-04 — better-sqlite3 backend.
 *
 * Wraps `better-sqlite3` to match the SqliteDatabase interface.
 * This is used when running under Node.js.
 */

import Database from "better-sqlite3";

import type { SqliteDatabase, SqliteRunResult, SqliteStatement } from "./sqlite.js";

export interface OpenBetterOptions {
  readonly?: boolean;
}

/**
 * Open a SQLite database using better-sqlite3.
 */
export function openBetter(path: string, options?: OpenBetterOptions): SqliteDatabase {
  const readonly = options?.readonly ?? false;
  const db = new Database(path, { readonly });

  return {
    get open(): boolean {
      return db.open;
    },

    exec(sql: string): void {
      db.exec(sql);
    },

    prepare(sql: string): SqliteStatement {
      const stmt = db.prepare(sql);
      return wrapStatement(stmt);
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

// ---------------------------------------------------------------------------
// Statement wrapper
// ---------------------------------------------------------------------------

type BetterStatement = ReturnType<InstanceType<typeof Database>["prepare"]>;

function wrapStatement(stmt: BetterStatement): SqliteStatement {
  // Cast to allow calling with no arguments (valid when SQL has no placeholders)
  const s = stmt as {
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    iterate(...params: unknown[]): IterableIterator<unknown>;
  };

  return {
    run(params?: unknown): SqliteRunResult {
      const result = params !== undefined ? s.run(params) : s.run();
      return {
        changes: result.changes,
        lastInsertRowid: result.lastInsertRowid,
      };
    },

    get(params?: unknown): unknown {
      return params !== undefined ? s.get(params) : s.get();
    },

    all(params?: unknown): unknown[] {
      return params !== undefined ? s.all(params) : s.all();
    },

    iterate(params?: unknown): IterableIterator<unknown> {
      return params !== undefined ? s.iterate(params) : s.iterate();
    },
  };
}
