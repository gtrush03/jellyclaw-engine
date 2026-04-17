/**
 * Tests for the scheduler IPC layer (T4-01).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IpcClient, IpcServer } from "./ipc.js";
import { Scheduler } from "./scheduler.js";

describe("IPC", () => {
  let tempDir: string;
  let scheduler: Scheduler;
  let ipcServer: IpcServer;
  let client: IpcClient;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "jc-ipc-test-"));

    scheduler = new Scheduler({
      stateDir: tempDir,
      tickIntervalMs: 1000, // Slow ticks — we're testing IPC, not scheduling.
      heartbeatIntervalMs: 60000,
    });

    scheduler.registerHandler("wakeup", () => {
      // Noop.
      return Promise.resolve();
    });

    scheduler.start();

    ipcServer = new IpcServer({ scheduler });
    ipcServer.start();

    // Wait a bit for server to bind.
    await new Promise((r) => setTimeout(r, 100));

    client = new IpcClient({
      socketPath: path.join(tempDir, "scheduler.sock"),
      timeoutMs: 5000,
    });
  });

  afterEach(async () => {
    await ipcServer.stop();
    await scheduler.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("enqueue-and-list", () => {
    it("enqueues a job over the socket and reads it back via list", async () => {
      // Enqueue a job.
      const job = await client.enqueue({
        id: "ipc-job-1",
        kind: "wakeup",
        fire_at: Date.now() + 60000,
        payload: JSON.stringify({ test: "data" }),
        owner: "ipc-test",
      });

      expect(job.id).toBe("ipc-job-1");
      expect(job.kind).toBe("wakeup");
      expect(job.status).toBe("pending");

      // List all jobs.
      const jobs = await client.list();
      expect(jobs.length).toBe(1);
      expect(jobs[0]?.id).toBe("ipc-job-1");

      // List with filter.
      const filtered = await client.list({ owner: "ipc-test" });
      expect(filtered.length).toBe(1);

      const noMatch = await client.list({ owner: "other" });
      expect(noMatch.length).toBe(0);
    });

    it("cancels a job and verifies status changes", async () => {
      // Enqueue.
      await client.enqueue({
        id: "ipc-job-2",
        kind: "wakeup",
        fire_at: Date.now() + 60000,
        payload: "{}",
        owner: "test",
      });

      // Cancel.
      const cancelled = await client.cancel("ipc-job-2");
      expect(cancelled).toBe(true);

      // Get job.
      const job = await client.get("ipc-job-2");
      expect(job.status).toBe("cancelled");

      // Not in pending list.
      const pending = await client.list({ status: "pending" });
      expect(pending.length).toBe(0);
    });

    it("returns status with correct fields", async () => {
      const status = await client.status();

      expect(typeof status.pid).toBe("number");
      expect(typeof status.pending).toBe("number");
      expect(typeof status.running).toBe("number");
      expect(typeof status.uptime_s).toBe("number");
      expect(typeof status.db_path).toBe("string");
    });

    it("handles unknown verb gracefully", async () => {
      // Use low-level request to send unknown verb.
      const socket = await import("node:net").then((net) =>
        net.createConnection(path.join(tempDir, "scheduler.sock")),
      );

      await new Promise<void>((resolve, reject) => {
        socket.on("connect", () => {
          const request = JSON.stringify({ id: "x", verb: "bogus", params: {} });
          const frame = Buffer.alloc(4 + Buffer.byteLength(request, "utf8"));
          frame.writeUInt32BE(Buffer.byteLength(request, "utf8"), 0);
          frame.write(request, 4, "utf8");
          socket.write(frame);
        });

        let buffer = Buffer.alloc(0);
        socket.on("data", (chunk) => {
          buffer = Buffer.concat([buffer, chunk]);
          if (buffer.length >= 4) {
            const frameLen = buffer.readUInt32BE(0);
            if (buffer.length >= 4 + frameLen) {
              const response = JSON.parse(buffer.subarray(4, 4 + frameLen).toString("utf8"));
              socket.end();

              expect(response.ok).toBe(false);
              expect(response.error.code).toBe("unknown_verb");
              resolve();
            }
          }
        });

        socket.on("error", reject);
      });
    });
  });

  describe("get verb", () => {
    it("retrieves a specific job by id", async () => {
      await client.enqueue({
        id: "get-test-job",
        kind: "wakeup",
        fire_at: Date.now() + 30000,
        payload: JSON.stringify({ key: "value" }),
        owner: "getter",
      });

      const job = await client.get("get-test-job");
      expect(job.id).toBe("get-test-job");
      expect(job.owner).toBe("getter");
    });

    it("returns error for non-existent job", async () => {
      await expect(client.get("non-existent")).rejects.toThrow("not found");
    });
  });
});
