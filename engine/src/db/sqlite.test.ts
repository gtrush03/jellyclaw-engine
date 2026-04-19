/**
 * Phase 08 T5-04 — SQLite adapter tests.
 *
 * Tests run against whichever backend is active (bun:sqlite or better-sqlite3).
 *
 * Vitest runs under Node by default, so the better-sqlite3 path is exercised
 * here. The bun:sqlite path is exercised end-to-end at TUI launch
 * (`bun engine/bin/jellyclaw tui`) — see Error 9 fix in the runtime shim.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isBun, openSqlite, openSqliteSync, type SqliteDatabase } from "./sqlite.js";

describe("SqliteDatabase adapter", () => {
  let db: SqliteDatabase;

  beforeEach(async () => {
    db = await openSqlite(":memory:");
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // Already closed
    }
  });

  describe("basic operations", () => {
    it("creates table and inserts data", () => {
      db.exec(`
        CREATE TABLE users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL
        )
      `);

      const stmt = db.prepare("INSERT INTO users (name) VALUES (?)");
      const result = stmt.run("Alice");

      expect(result.changes).toBe(1);
      expect(typeof result.lastInsertRowid).toMatch(/number|bigint/);
    });

    it("selects data with prepare().all()", () => {
      db.exec("CREATE TABLE items (id INTEGER, value TEXT)");
      db.prepare("INSERT INTO items VALUES (?, ?)").run([1, "a"]);
      db.prepare("INSERT INTO items VALUES (?, ?)").run([2, "b"]);

      const rows = db.prepare("SELECT * FROM items ORDER BY id").all() as Array<{
        id: number;
        value: string;
      }>;

      expect(rows).toHaveLength(2);
      expect(rows[0]).toEqual({ id: 1, value: "a" });
      expect(rows[1]).toEqual({ id: 2, value: "b" });
    });

    it("selects single row with prepare().get()", () => {
      db.exec("CREATE TABLE items (id INTEGER, value TEXT)");
      db.prepare("INSERT INTO items VALUES (?, ?)").run([1, "a"]);

      const row = db.prepare("SELECT * FROM items WHERE id = ?").get(1) as {
        id: number;
        value: string;
      };

      expect(row).toEqual({ id: 1, value: "a" });
    });

    it("returns undefined for non-existent row", () => {
      db.exec("CREATE TABLE items (id INTEGER)");

      const row = db.prepare("SELECT * FROM items WHERE id = ?").get(999);

      expect(row).toBeUndefined();
    });
  });

  describe("pragma", () => {
    it("sets journal_mode to WAL", () => {
      const result = db.pragma("journal_mode", "WAL") as Array<{ journal_mode: string }>;

      // Result format varies slightly between backends
      expect(result).toBeDefined();
      // The first element should contain journal_mode
      const mode = Array.isArray(result) ? result[0]?.journal_mode : undefined;
      // In-memory databases cannot use WAL mode and will return 'memory'.
      // File-based databases will return 'wal'.
      expect(["wal", "memory"]).toContain(mode?.toLowerCase());
    });

    it("queries integrity_check", () => {
      const result = db.pragma("integrity_check") as Array<{ integrity_check: string }>;

      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
      expect(result[0]?.integrity_check).toBe("ok");
    });

    it("sets and queries foreign_keys", () => {
      db.pragma("foreign_keys", "ON");
      const result = db.pragma("foreign_keys") as Array<{ foreign_keys: number }>;

      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
      expect(result[0]?.foreign_keys).toBe(1);
    });
  });

  describe("transaction", () => {
    it("commits on success", () => {
      db.exec("CREATE TABLE items (id INTEGER)");

      const insertTwo = db.transaction(() => {
        db.prepare("INSERT INTO items VALUES (1)").run();
        db.prepare("INSERT INTO items VALUES (2)").run();
      });

      insertTwo();

      const rows = db.prepare("SELECT COUNT(*) as count FROM items").get() as { count: number };
      expect(rows.count).toBe(2);
    });

    it("rolls back on thrown error", () => {
      db.exec("CREATE TABLE items (id INTEGER)");

      const insertAndFail = db.transaction(() => {
        db.prepare("INSERT INTO items VALUES (1)").run();
        throw new Error("intentional failure");
      });

      expect(() => insertAndFail()).toThrow("intentional failure");

      const rows = db.prepare("SELECT COUNT(*) as count FROM items").get() as { count: number };
      expect(rows.count).toBe(0);
    });

    it("supports returning values", () => {
      db.exec("CREATE TABLE items (id INTEGER)");

      const insertAndReturn = db.transaction(() => {
        db.prepare("INSERT INTO items VALUES (42)").run();
        return "success";
      });

      const result = insertAndReturn();
      expect(result).toBe("success");
    });
  });

  describe("close", () => {
    it("is idempotent", () => {
      db.close();
      // Should not throw
      expect(() => db.close()).not.toThrow();
    });
  });

  describe("exec", () => {
    it("handles multi-statement SQL", () => {
      db.exec(`
        CREATE TABLE a (id INTEGER);
        CREATE TABLE b (id INTEGER);
        INSERT INTO a VALUES (1);
        INSERT INTO b VALUES (2);
      `);

      const aRows = db.prepare("SELECT * FROM a").all() as Array<{ id: number }>;
      const bRows = db.prepare("SELECT * FROM b").all() as Array<{ id: number }>;

      expect(aRows).toHaveLength(1);
      expect(bRows).toHaveLength(1);
    });
  });

  describe("named parameters", () => {
    it("supports object parameters", () => {
      db.exec("CREATE TABLE users (id INTEGER, name TEXT)");
      db.prepare("INSERT INTO users VALUES (@id, @name)").run({ id: 1, name: "Alice" });

      const row = db.prepare("SELECT * FROM users WHERE id = @id").get({ id: 1 }) as {
        id: number;
        name: string;
      };

      expect(row).toEqual({ id: 1, name: "Alice" });
    });

    it("supports spread positional parameters (multi-arg .run)", () => {
      // This shape is used by team-registry / monitor-registry — single
      // .run(a, b, c) call with multiple positional args. The shim must
      // forward these through to the underlying backend.
      db.exec("CREATE TABLE log (ts INTEGER, level TEXT, msg TEXT)");
      const stmt = db.prepare("INSERT INTO log VALUES (?, ?, ?)");

      const result = stmt.run(1700000000, "info", "hello");
      expect(result.changes).toBe(1);

      const row = db.prepare("SELECT * FROM log WHERE ts = ?").get(1700000000) as {
        ts: number;
        level: string;
        msg: string;
      };
      expect(row).toEqual({ ts: 1700000000, level: "info", msg: "hello" });
    });
  });
});

// ---------------------------------------------------------------------------
// Synchronous shim — proves the openSqliteSync / Error 9 fix
// ---------------------------------------------------------------------------

describe("openSqliteSync (Error 9 runtime shim)", () => {
  it("isBun() returns a boolean matching the actual runtime", () => {
    const expected = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
    expect(isBun()).toBe(expected);
  });

  it("opens an in-memory database synchronously", () => {
    const db = openSqliteSync(":memory:");
    try {
      expect(db.open).toBe(true);
      db.exec("CREATE TABLE t (id INTEGER)");
      db.prepare("INSERT INTO t VALUES (?)").run(42);
      const row = db.prepare("SELECT id FROM t").get() as { id: number };
      expect(row.id).toBe(42);
    } finally {
      db.close();
    }
  });

  it("opens a file-backed database and persists across handles", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sqlite-shim-test-"));
    const dbPath = path.join(dir, "shim.db");

    try {
      const a = openSqliteSync(dbPath);
      a.exec("CREATE TABLE k (k TEXT PRIMARY KEY, v TEXT)");
      a.prepare("INSERT INTO k VALUES (?, ?)").run("hello", "world");
      a.close();

      const b = openSqliteSync(dbPath);
      try {
        const row = b.prepare("SELECT v FROM k WHERE k = ?").get("hello") as { v: string };
        expect(row.v).toBe("world");
      } finally {
        b.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("WAL pragma + synchronous=NORMAL + busy_timeout configure cleanly", () => {
    // File-backed DB so WAL actually engages (in-memory falls back to 'memory').
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sqlite-shim-pragma-"));
    const dbPath = path.join(dir, "wal.db");

    try {
      const db = openSqliteSync(dbPath);
      try {
        db.pragma("journal_mode", "WAL");
        db.pragma("synchronous", "NORMAL");
        db.pragma("busy_timeout", 2000);
        db.pragma("foreign_keys", "ON");

        const journalMode = db.pragma("journal_mode") as Array<{ journal_mode: string }>;
        expect(journalMode[0]?.journal_mode?.toLowerCase()).toBe("wal");

        const fk = db.pragma("foreign_keys") as Array<{ foreign_keys: number }>;
        expect(fk[0]?.foreign_keys).toBe(1);
      } finally {
        db.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("transaction() commits on success and rolls back on error", () => {
    const db = openSqliteSync(":memory:");
    try {
      db.exec("CREATE TABLE n (i INTEGER)");

      const insertOk = db.transaction(() => {
        db.prepare("INSERT INTO n VALUES (1)").run();
        db.prepare("INSERT INTO n VALUES (2)").run();
      });
      insertOk();

      const insertFail = db.transaction(() => {
        db.prepare("INSERT INTO n VALUES (3)").run();
        throw new Error("boom");
      });
      expect(() => insertFail()).toThrow("boom");

      const count = (db.prepare("SELECT COUNT(*) as c FROM n").get() as { c: number }).c;
      expect(count).toBe(2);
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Async shim — proves openSqlite() still works after spread-args refactor
// ---------------------------------------------------------------------------

describe("openSqlite (async)", () => {
  it("matches openSqliteSync output for a basic round-trip", async () => {
    const db = await openSqlite(":memory:");
    try {
      db.exec("CREATE TABLE t (id INTEGER)");
      db.prepare("INSERT INTO t VALUES (?)").run(7);
      const row = db.prepare("SELECT id FROM t").get() as { id: number };
      expect(row.id).toBe(7);
    } finally {
      db.close();
    }
  });
});
