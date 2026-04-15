/**
 * Tests for `db.ts` — open, pragmas, schema application, corruption recovery,
 * and clean close.
 */

import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type Db, openDb } from "./db.js";
import { SessionPaths } from "./paths.js";

interface PragmaIntRow {
  readonly synchronous?: number;
  readonly foreign_keys?: number;
}
interface JournalRow {
  readonly journal_mode: string;
}
interface TableRow {
  readonly name: string;
}

describe("openDb", () => {
  let tmpDir: string;
  let paths: SessionPaths;
  let db: Db | null;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "jellyclaw-db-"));
    paths = new SessionPaths({ home: tmpDir });
    db = null;
  });

  afterEach(() => {
    if (db) {
      try {
        db.close();
      } catch {
        // already closed
      }
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates the sessions directory and opens a fresh DB", async () => {
    db = await openDb({ paths });
    expect(db.raw.open).toBe(true);
  });

  it("applies WAL / NORMAL / foreign_keys pragmas", async () => {
    db = await openDb({ paths });
    const journal = db.raw.pragma("journal_mode") as JournalRow[];
    expect(journal[0]?.journal_mode).toBe("wal");

    const sync = db.raw.pragma("synchronous") as PragmaIntRow[];
    expect(sync[0]?.synchronous).toBe(1); // NORMAL = 1

    const fk = db.raw.pragma("foreign_keys") as PragmaIntRow[];
    expect(fk[0]?.foreign_keys).toBe(1);
  });

  it("applies the v1 schema (all expected tables present)", async () => {
    db = await openDb({ paths });
    const rows = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as TableRow[];
    const names = new Set(rows.map((r) => r.name));
    for (const expected of [
      "sessions",
      "messages",
      "tool_calls",
      "tokens",
      "cost",
      "wishes",
      "messages_fts",
      "schema_version",
    ]) {
      expect(names.has(expected), `expected table '${expected}' to exist`).toBe(true);
    }
  });

  it("quarantines a corrupt DB and opens a fresh one", async () => {
    // Seed a garbage file at the index path BEFORE opening.
    const dbPath = paths.indexDb();
    // Ensure parent dir exists (paths helper is pure — it doesn't mkdir).
    const { mkdirSync } = await import("node:fs");
    mkdirSync(paths.sessionsRoot(), { recursive: true });
    writeFileSync(dbPath, Buffer.alloc(100, 0xff));

    db = await openDb({ paths });
    expect(db.raw.open).toBe(true);

    // Fresh DB should have the schema applied.
    const rows = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'")
      .all() as TableRow[];
    expect(rows.length).toBe(1);

    // A quarantined file should exist in the sessions root.
    const files = readdirSync(paths.sessionsRoot());
    const corrupt = files.find((f) => f.startsWith(`${basename(dbPath)}.corrupt-`));
    expect(corrupt, `expected a corrupt-* sidecar in ${files.join(", ")}`).toBeDefined();
  });

  it("close() marks raw.open as false", async () => {
    db = await openDb({ paths });
    expect(db.raw.open).toBe(true);
    db.close();
    expect(db.raw.open).toBe(false);
    db = null; // prevent double-close in afterEach
  });
});
