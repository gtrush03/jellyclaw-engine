/**
 * Tests for the scheduler job store (T4-01).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { JobStore } from "./store.js";

describe("JobStore", () => {
  let tempDir: string;
  let store: JobStore;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "jc-store-test-"));
    store = new JobStore({ stateDir: tempDir });
  });

  afterEach(() => {
    if (store.isOpen) {
      store.close();
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("schema-migrate", () => {
    it("creates schema on fresh DB", () => {
      store.open();
      expect(store.getSchemaVersion()).toBe(1);

      // Verify tables exist by inserting a job.
      const job = store.insertJob({
        id: "test-001",
        kind: "wakeup",
        fire_at: Date.now() + 10000,
        payload: JSON.stringify({ foo: "bar" }),
        owner: "system",
      });
      expect(job.id).toBe("test-001");
    });

    it("reopening existing DB at current schema_version is a no-op", () => {
      store.open();
      store.insertJob({
        id: "test-002",
        kind: "wakeup",
        fire_at: Date.now() + 10000,
        payload: "{}",
        owner: "system",
      });
      store.close();

      // Reopen.
      const store2 = new JobStore({ stateDir: tempDir });
      store2.open();

      expect(store2.getSchemaVersion()).toBe(1);
      const job = store2.getById("test-002");
      expect(job).toBeDefined();
      expect(job?.id).toBe("test-002");

      store2.close();
    });
  });

  describe("insert/cancel/listDue ordering", () => {
    it("inserts and retrieves jobs", () => {
      store.open();

      const job1 = store.insertJob({
        id: "job-a",
        kind: "wakeup",
        fire_at: 1000,
        payload: "{}",
        owner: "user-1",
      });
      const job2 = store.insertJob({
        id: "job-b",
        kind: "cron",
        fire_at: 500,
        cron_expr: "*/5 * * * *",
        payload: "{}",
        owner: "user-2",
      });

      expect(job1.status).toBe("pending");
      expect(job2.kind).toBe("cron");

      // List due — job-b fires first.
      const due = store.listDue(1000);
      expect(due.length).toBe(2);
      expect(due[0]?.id).toBe("job-b");
      expect(due[1]?.id).toBe("job-a");
    });

    it("cancels pending jobs", () => {
      store.open();

      store.insertJob({
        id: "job-c",
        kind: "wakeup",
        fire_at: 2000,
        payload: "{}",
        owner: "system",
      });

      const cancelled = store.cancel("job-c");
      expect(cancelled).toBe(true);

      const job = store.getById("job-c");
      expect(job?.status).toBe("cancelled");

      // Not in due list.
      const due = store.listDue(3000);
      expect(due.length).toBe(0);
    });

    it("cannot cancel non-pending jobs", () => {
      store.open();

      store.insertJob({
        id: "job-d",
        kind: "wakeup",
        fire_at: 1000,
        payload: "{}",
        owner: "system",
      });

      // Claim it (sets to running).
      store.claimJob("job-d");

      const cancelled = store.cancel("job-d");
      expect(cancelled).toBe(false);
    });
  });

  describe("wal checkpoint after 100 jobs", () => {
    it("checkpoints without error", () => {
      store.open();

      for (let i = 0; i < 100; i++) {
        store.insertJob({
          id: `bulk-${i}`,
          kind: "wakeup",
          fire_at: Date.now() + i * 1000,
          payload: "{}",
          owner: "bulk",
        });
      }

      // Force checkpoint.
      expect(() => store.checkpoint()).not.toThrow();

      // Verify jobs exist.
      const all = store.listAll({ owner: "bulk" });
      expect(all.length).toBe(100);
    });
  });

  describe("concurrent writer coordination via BEGIN IMMEDIATE", () => {
    it("handles concurrent inserts", async () => {
      store.open();

      // Simulate concurrent writes.
      const promises = [];
      for (let i = 0; i < 10; i++) {
        promises.push(
          new Promise<void>((resolve, reject) => {
            try {
              store.insertJob({
                id: `concurrent-${i}`,
                kind: "wakeup",
                fire_at: Date.now() + i * 100,
                payload: "{}",
                owner: "concurrent",
              });
              resolve();
            } catch (err) {
              reject(err);
            }
          }),
        );
      }

      await Promise.all(promises);

      const all = store.listAll({ owner: "concurrent" });
      expect(all.length).toBe(10);
    });
  });

  describe("job events", () => {
    it("appends and lists events", () => {
      store.open();

      store.insertJob({
        id: "event-job",
        kind: "wakeup",
        fire_at: 1000,
        payload: "{}",
        owner: "system",
      });

      store.appendEvent("event-job", "fired");
      store.appendEvent("event-job", "completed", "success");

      const events = store.listEvents("event-job");
      expect(events.length).toBe(2);
      expect(events[0]?.event).toBe("fired");
      expect(events[1]?.event).toBe("completed");
      expect(events[1]?.detail).toBe("success");
    });
  });

  describe("markDone and markError", () => {
    it("marks job as done", () => {
      store.open();

      store.insertJob({
        id: "done-job",
        kind: "wakeup",
        fire_at: 1000,
        payload: "{}",
        owner: "system",
      });

      store.claimJob("done-job");
      store.markDone("done-job", 1500);

      const job = store.getById("done-job");
      expect(job?.status).toBe("done");
      expect(job?.fire_count).toBe(1);
      expect(job?.last_fired_at).toBe(1500);
    });

    it("marks job as failed with error", () => {
      store.open();

      store.insertJob({
        id: "fail-job",
        kind: "wakeup",
        fire_at: 1000,
        payload: "{}",
        owner: "system",
      });

      store.claimJob("fail-job");
      store.markError("fail-job", "something went wrong", 1600);

      const job = store.getById("fail-job");
      expect(job?.status).toBe("failed");
      expect(job?.error).toBe("something went wrong");
    });
  });

  describe("countPending and countRunning", () => {
    it("returns correct counts", () => {
      store.open();

      store.insertJob({
        id: "count-1",
        kind: "wakeup",
        fire_at: 1000,
        payload: "{}",
        owner: "system",
      });
      store.insertJob({
        id: "count-2",
        kind: "wakeup",
        fire_at: 2000,
        payload: "{}",
        owner: "system",
      });

      expect(store.countPending()).toBe(2);
      expect(store.countRunning()).toBe(0);

      store.claimJob("count-1");

      expect(store.countPending()).toBe(1);
      expect(store.countRunning()).toBe(1);
    });
  });
});
