/**
 * Phase 09.02 — wish idempotency ledger.
 *
 * Filesystem is the source of truth: every wish gets one file at
 * `~/.jellyclaw/wishes/<wishId>.json`. SQLite's `wishes` table is a mirror,
 * kept in sync on every write. On any mismatch at `check()` time the FS wins
 * and we reconcile SQLite from it.
 *
 * Durability: every write is atomic (`.tmp` + `rename`). First-time creates
 * use `fs.open(path, "wx")` so a race between two processes resolves to
 * exactly one winner; losers retry `check()`. Within a single instance,
 * writes are serialized through a private promise chain — mirrors the
 * pattern used by `SessionWriter`.
 */

import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { Logger } from "pino";
import { z } from "zod";

import { createLogger } from "../logger.js";
import type { Db } from "./db.js";
import type { SessionPaths } from "./paths.js";
import {
  type BeginWishOptions,
  type WishCheckOutcome,
  WishConflictError,
  type WishRecord,
} from "./types.js";

// ---------------------------------------------------------------------------
// Zod schema for the on-disk record
// ---------------------------------------------------------------------------

const WishRecordSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["running", "done", "failed"]),
  attempt: z.number().int().positive(),
  startedAt: z.number().int().nonnegative(),
  finishedAt: z.number().int().nonnegative().nullable(),
  sessionId: z.string().nullable(),
  resultJson: z.string().nullable(),
  error: z.string().nullable(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function atomicWrite(path: string, body: string): Promise<void> {
  const suffix = randomBytes(8).toString("hex");
  const tmp = `${path}.${suffix}.tmp`;
  try {
    await writeFile(tmp, body, "utf8");
    await rename(tmp, path);
  } catch (err) {
    // Best-effort cleanup of the temp file if rename never happened.
    try {
      await unlink(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

function serialize(record: WishRecord): string {
  return JSON.stringify(record, null, 2);
}

function syntheticFreshRecord(id: string): WishRecord {
  return {
    id,
    status: "running",
    attempt: 0,
    startedAt: 0,
    finishedAt: null,
    sessionId: null,
    resultJson: null,
    error: null,
  };
}

// ---------------------------------------------------------------------------
// WishLedger
// ---------------------------------------------------------------------------

export interface WishLedgerOptions {
  readonly logger?: Logger;
  /** Injected clock for deterministic tests. Defaults to `Date.now`. */
  readonly now?: () => number;
}

export class WishLedger {
  private readonly paths: SessionPaths;
  private readonly db: Db;
  private readonly logger: Logger;
  private readonly now: () => number;

  // Same pattern as SessionWriter: a per-instance promise chain so concurrent
  // operations on this object don't interleave FS + SQLite writes.
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(paths: SessionPaths, db: Db, opts: WishLedgerOptions = {}) {
    this.paths = paths;
    this.db = db;
    this.logger = opts.logger ?? createLogger({ name: "wish-ledger" });
    this.now = opts.now ?? Date.now;
  }

  // ---- private helpers ----------------------------------------------------

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.then(() => fn());
    this.writeQueue = next.catch(() => undefined);
    return next;
  }

  private wishPath(id: string): string {
    return this.paths.wishFile(id);
  }

  private async readFromDisk(id: string): Promise<WishRecord | null> {
    const path = this.wishPath(id);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      this.logger.warn({ err, id }, "wish-ledger: wish file is not valid JSON; treating as absent");
      return null;
    }
    const result = WishRecordSchema.safeParse(parsed);
    if (!result.success) {
      this.logger.warn(
        { id, issues: result.error.issues },
        "wish-ledger: wish record failed schema; treating as absent",
      );
      return null;
    }
    return result.data;
  }

  private mirrorToSqlite(record: WishRecord): void {
    this.db.raw
      .prepare(
        `INSERT INTO wishes (id, session_id, status, attempt, started_at, finished_at, result_json, error)
         VALUES (@id, @sessionId, @status, @attempt, @startedAt, @finishedAt, @resultJson, @error)
         ON CONFLICT(id) DO UPDATE SET
           session_id  = excluded.session_id,
           status      = excluded.status,
           attempt     = excluded.attempt,
           started_at  = excluded.started_at,
           finished_at = excluded.finished_at,
           result_json = excluded.result_json,
           error       = excluded.error`,
      )
      .run(record);
  }

  private sqliteRowExists(id: string): boolean {
    const row = this.db.raw.prepare("SELECT id FROM wishes WHERE id = ?").get(id);
    return row !== undefined;
  }

  private async ensureWishesDir(): Promise<void> {
    await mkdir(dirname(this.wishPath("_")), { recursive: true });
  }

  // ---- public API ---------------------------------------------------------

  /**
   * Inspect the current state of a wish. If the FS record exists but the
   * SQLite row is missing, this method will reconcile (upsert the FS record
   * into SQLite) before returning — filesystem is source of truth.
   */
  check(wishId: string): Promise<WishCheckOutcome> {
    return this.enqueue(async () => {
      const record = await this.readFromDisk(wishId);
      if (!record) {
        return { kind: "fresh" as const, record: syntheticFreshRecord(wishId) };
      }

      // Reconcile SQLite from FS if the mirror lost sync.
      if (!this.sqliteRowExists(wishId)) {
        this.logger.info({ id: wishId }, "wish-ledger: reconciling SQLite row from FS record");
        this.mirrorToSqlite(record);
      }

      switch (record.status) {
        case "running":
          return { kind: "running", record };
        case "done":
          return { kind: "cached", record };
        case "failed":
          return { kind: "retry", record };
      }
    });
  }

  /**
   * Begin a wish. Behaviour depends on the existing record:
   *
   *   - fresh                 → atomically create a new `running` record.
   *   - cached (done)         → return the cached record unchanged.
   *   - retry (failed)        → bump attempt, write new `running` record.
   *   - running && !force     → throw `WishConflictError`.
   *   - running &&  force     → bump attempt, overwrite record with `running`.
   */
  begin(opts: BeginWishOptions): Promise<WishRecord> {
    return this.enqueue(async () => {
      await this.ensureWishesDir();

      // Bypass the public check() (which goes through the queue) — we're
      // already inside the queue. Read directly.
      const existing = await this.readFromDisk(opts.wishId);

      // --- cached: done ---
      if (existing && existing.status === "done") {
        if (!this.sqliteRowExists(opts.wishId)) this.mirrorToSqlite(existing);
        return existing;
      }

      // --- running without force: conflict ---
      if (existing && existing.status === "running" && !opts.force) {
        throw new WishConflictError(opts.wishId, existing);
      }

      // Determine next attempt.
      let attempt: number;
      if (!existing) attempt = 1;
      else attempt = existing.attempt + 1;

      const now = this.now();
      const record: WishRecord = {
        id: opts.wishId,
        status: "running",
        attempt,
        startedAt: now,
        finishedAt: null,
        sessionId: opts.sessionId ?? null,
        resultJson: null,
        error: null,
      };

      if (!existing) {
        // Exclusive create guards against cross-process races.
        const path = this.wishPath(opts.wishId);
        try {
          const handle = await open(path, "wx");
          try {
            await handle.writeFile(serialize(record), "utf8");
          } finally {
            await handle.close();
          }
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "EEXIST") {
            // Another process won the race. Re-read and recurse into the
            // normal path (non-fresh branches).
            const winnerRecord = await this.readFromDisk(opts.wishId);
            if (winnerRecord && winnerRecord.status === "running" && !opts.force) {
              throw new WishConflictError(opts.wishId, winnerRecord);
            }
            if (winnerRecord && winnerRecord.status === "done") {
              if (!this.sqliteRowExists(opts.wishId)) this.mirrorToSqlite(winnerRecord);
              return winnerRecord;
            }
            // running+force or failed — overwrite.
            const bumped: WishRecord = {
              ...record,
              attempt: (winnerRecord?.attempt ?? 0) + 1,
            };
            await atomicWrite(path, serialize(bumped));
            this.mirrorToSqlite(bumped);
            return bumped;
          }
          throw err;
        }
      } else {
        // Existing record: atomic overwrite. (Either failed → retry, or
        // running+force.)
        await atomicWrite(this.wishPath(opts.wishId), serialize(record));
      }

      this.mirrorToSqlite(record);
      return record;
    });
  }

  /** Mark a wish as successfully completed. Throws if the wish was never begun. */
  complete(wishId: string, resultJson: string): Promise<WishRecord> {
    return this.enqueue(async () => {
      const existing = await this.readFromDisk(wishId);
      if (!existing) {
        throw new Error(`wish-ledger: cannot complete unknown wish ${wishId}`);
      }
      const record: WishRecord = {
        ...existing,
        status: "done",
        finishedAt: this.now(),
        resultJson,
        error: null,
      };
      await atomicWrite(this.wishPath(wishId), serialize(record));
      this.mirrorToSqlite(record);
      return record;
    });
  }

  /** Mark a wish as failed. Throws if the wish was never begun. */
  fail(wishId: string, error: string): Promise<WishRecord> {
    return this.enqueue(async () => {
      const existing = await this.readFromDisk(wishId);
      if (!existing) {
        throw new Error(`wish-ledger: cannot fail unknown wish ${wishId}`);
      }
      const record: WishRecord = {
        ...existing,
        status: "failed",
        finishedAt: this.now(),
        resultJson: null,
        error,
      };
      await atomicWrite(this.wishPath(wishId), serialize(record));
      this.mirrorToSqlite(record);
      return record;
    });
  }
}
