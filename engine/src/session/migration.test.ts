/**
 * Tests for the migration runner in `db.ts` — ensures v1 is applied on
 * first open and that re-opening is a no-op.
 *
 * Forward-compat note: when we add a v2 migration, add a test here that
 *   (a) opens with just v1 in `MIGRATIONS`, closes,
 *   (b) temporarily pushes a v2 migration onto the list,
 *   (c) re-opens and asserts `schema_version` contains both rows and
 *       v2-specific schema changes are visible.
 * For now, only v1 exists, so only the "applied + idempotent" cases run.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { __testing, openDb } from "./db.js";
import { SessionPaths } from "./paths.js";

interface VersionRow {
  readonly v: number;
}
interface CountRow {
  readonly c: number;
}

describe("migration runner", () => {
  let tmpDir: string;
  let paths: SessionPaths;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "jellyclaw-mig-"));
    paths = new SessionPaths({ home: tmpDir });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("applies v1 on first open", async () => {
    const db = await openDb({ paths });
    try {
      const rows = db.raw.prepare("SELECT v FROM schema_version").all() as VersionRow[];
      expect(rows).toEqual([{ v: 1 }]);
      expect(__testing.currentSchemaVersion(db.raw)).toBe(1);
    } finally {
      db.close();
    }
  });

  it("is a no-op on re-open (idempotent)", async () => {
    const first = await openDb({ paths });
    const tablesBefore = first.raw
      .prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table'")
      .get() as CountRow;
    first.close();

    const second = await openDb({ paths });
    try {
      const rows = second.raw.prepare("SELECT v FROM schema_version").all() as VersionRow[];
      expect(rows).toEqual([{ v: 1 }]);

      const tablesAfter = second.raw
        .prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table'")
        .get() as CountRow;
      expect(tablesAfter.c).toBe(tablesBefore.c);
    } finally {
      second.close();
    }
  });

  it("exposes a MIGRATIONS list ordered by version", () => {
    const versions = __testing.MIGRATIONS.map((m) => m.v);
    const sorted = [...versions].sort((a, b) => a - b);
    expect(versions).toEqual(sorted);
    expect(versions[0]).toBe(1);
  });
});
