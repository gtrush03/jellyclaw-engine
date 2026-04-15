import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Db } from "./db.js";
import { openDb } from "./db.js";
import { WishLedger } from "./idempotency.js";
import { SessionPaths } from "./paths.js";
import { WishConflictError } from "./types.js";

describe("WishLedger", () => {
  let home: string;
  let paths: SessionPaths;
  let db: Db;
  let ledger: WishLedger;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "jellyclaw-wish-"));
    paths = new SessionPaths({ home });
    // wishes/ must exist before begin(), which mkdir's; but safe to pre-create.
    mkdirSync(paths.wishesRoot(), { recursive: true });
    db = await openDb({ paths });
    ledger = new WishLedger(paths, db);
  });

  afterEach(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("begin fresh → file created, SQLite row present, status=running, attempt=1", async () => {
    const record = await ledger.begin({ wishId: "w1" });
    expect(record.status).toBe("running");
    expect(record.attempt).toBe(1);

    const onDisk = JSON.parse(readFileSync(paths.wishFile("w1"), "utf8")) as { status: string };
    expect(onDisk.status).toBe("running");

    const row = db.raw.prepare("SELECT id, status, attempt FROM wishes WHERE id = ?").get("w1") as {
      id: string;
      status: string;
      attempt: number;
    };
    expect(row).toMatchObject({ id: "w1", status: "running", attempt: 1 });
  });

  it("begin existing running without force → WishConflictError", async () => {
    await ledger.begin({ wishId: "w1" });
    await expect(ledger.begin({ wishId: "w1" })).rejects.toBeInstanceOf(WishConflictError);
  });

  it("begin existing running WITH force → attempt bumped, status=running", async () => {
    await ledger.begin({ wishId: "w1" });
    const forced = await ledger.begin({ wishId: "w1", force: true });
    expect(forced.status).toBe("running");
    expect(forced.attempt).toBe(2);
  });

  it("begin existing done → returns cached record, kind=cached on check", async () => {
    await ledger.begin({ wishId: "w1" });
    await ledger.complete("w1", JSON.stringify({ ok: true }));

    const again = await ledger.begin({ wishId: "w1" });
    expect(again.status).toBe("done");
    expect(again.resultJson).toBe(JSON.stringify({ ok: true }));

    const check = await ledger.check("w1");
    expect(check.kind).toBe("cached");
  });

  it("begin existing failed → retry; attempt bumped to 2", async () => {
    await ledger.begin({ wishId: "w1" });
    await ledger.fail("w1", "oops");
    const retried = await ledger.begin({ wishId: "w1" });
    expect(retried.status).toBe("running");
    expect(retried.attempt).toBe(2);
  });

  it("complete then re-check → kind=cached, resultJson present", async () => {
    await ledger.begin({ wishId: "w1" });
    await ledger.complete("w1", '{"v":1}');
    const check = await ledger.check("w1");
    expect(check.kind).toBe("cached");
    expect(check.record.resultJson).toBe('{"v":1}');
  });

  it("fail then check → kind=retry, error present", async () => {
    await ledger.begin({ wishId: "w1" });
    await ledger.fail("w1", "boom");
    const check = await ledger.check("w1");
    expect(check.kind).toBe("retry");
    expect(check.record.error).toBe("boom");
  });

  it("concurrent begin: exactly one 'fresh' win across 10 Promise.all", async () => {
    // Each call needs its own ledger instance to simulate independent actors
    // (the in-process queue would otherwise serialize a single ledger's calls
    // trivially). This exercises the fs.open(wx) race guard.
    const ledgers = Array.from({ length: 10 }, () => new WishLedger(paths, db));
    const results = await Promise.allSettled(ledgers.map((l) => l.begin({ wishId: "race" })));

    let freshWinners = 0;
    let conflictsOrObserved = 0;
    for (const r of results) {
      if (r.status === "fulfilled") {
        if (r.value.attempt === 1 && r.value.status === "running") freshWinners += 1;
        else conflictsOrObserved += 1;
      } else {
        if (r.reason instanceof WishConflictError) conflictsOrObserved += 1;
        else throw r.reason;
      }
    }
    expect(freshWinners).toBe(1);
    expect(freshWinners + conflictsOrObserved).toBe(10);
  });

  it("reconciliation: deleting SQLite row → check() rebuilds it from FS", async () => {
    await ledger.begin({ wishId: "w1" });
    db.raw.prepare("DELETE FROM wishes WHERE id = ?").run("w1");
    expect(db.raw.prepare("SELECT id FROM wishes WHERE id = ?").get("w1")).toBeUndefined();

    const check = await ledger.check("w1");
    expect(check.kind).toBe("running");
    const row = db.raw.prepare("SELECT id FROM wishes WHERE id = ?").get("w1");
    expect(row).toBeDefined();
  });

  it("fresh check when wish does not exist", async () => {
    const check = await ledger.check("never-begun");
    expect(check.kind).toBe("fresh");
  });

  it("atomic writes leave the wish file always parseable", async () => {
    await ledger.begin({ wishId: "w1" });
    await ledger.complete("w1", "{}");
    const body = readFileSync(paths.wishFile("w1"), "utf8");
    expect(() => JSON.parse(body)).not.toThrow();
  });

  it("complete on unknown wish throws", async () => {
    await expect(ledger.complete("ghost", "{}")).rejects.toThrow();
  });
});
