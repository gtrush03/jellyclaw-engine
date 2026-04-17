/**
 * Tests for Cron tools (T4-02).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { nextFireTime } from "../daemon/cron-parser.js";
import { IpcServer } from "../daemon/ipc.js";
import { Scheduler } from "../daemon/scheduler.js";
import { createLogger } from "../logger.js";
import {
  cronCreateInputSchema,
  cronCreateTool,
  cronDeleteTool,
  cronListTool,
  type CronCreateInput,
  type CronDeleteInput,
} from "./cron.js";
import type { ToolContext } from "./types.js";

describe("Cron tools", () => {
  let tempDir: string;
  let scheduler: Scheduler;
  let server: IpcServer;
  let ctx: ToolContext;
  const originalEnv = process.env.JELLYCLAW_SCHEDULER_SOCKET;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "jc-cron-test-"));

    scheduler = new Scheduler({
      stateDir: tempDir,
      tickIntervalMs: 1000,
      heartbeatIntervalMs: 60000,
    });
    scheduler.start();

    const socketPath = path.join(tempDir, "scheduler.sock");
    process.env.JELLYCLAW_SCHEDULER_SOCKET = socketPath;

    server = new IpcServer({ scheduler, socketPath });
    server.start();

    ctx = {
      sessionId: "test-session-456",
      cwd: tempDir,
      logger: createLogger({ name: "test", destination: "stderr" }),
    } as ToolContext;
  });

  afterEach(async () => {
    await server.stop();
    await scheduler.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalEnv) {
      process.env.JELLYCLAW_SCHEDULER_SOCKET = originalEnv;
    } else {
      delete process.env.JELLYCLAW_SCHEDULER_SOCKET;
    }
  });

  describe("CronCreate", () => {
    describe("input validation", () => {
      it("accepts valid 5-field expression", () => {
        const input = {
          expression: "*/5 * * * *",
          prompt: "Run every 5 minutes",
          reason: "Periodic task",
        };
        expect(() => cronCreateInputSchema.parse(input)).not.toThrow();
      });

      it("rejects invalid expression (3 fields)", () => {
        const input = {
          expression: "* * *",
          prompt: "Invalid",
          reason: "Test",
        };
        expect(() => cronCreateInputSchema.parse(input)).toThrow();
      });

      it("rejects empty prompt", () => {
        const input = {
          expression: "*/5 * * * *",
          prompt: "",
          reason: "Test",
        };
        expect(() => cronCreateInputSchema.parse(input)).toThrow();
      });
    });

    describe("fires-on-schedule", () => {
      it("creates a cron job with correct next_fire_at", async () => {
        const input: CronCreateInput = {
          expression: "*/5 * * * *",
          prompt: "Check metrics",
          reason: "Every 5 minutes",
        };

        const before = Date.now();
        const result = await cronCreateTool.handler(input, ctx);

        // Should return job_id and next_fire_at_unix_ms.
        expect(result.job_id).toMatch(/^cron-/);

        // Next fire should be at the next 5-minute mark.
        const expectedNext = nextFireTime("*/5 * * * *", before);
        expect(result.next_fire_at_unix_ms).toBe(expectedNext);

        // Job should be in the store.
        const job = scheduler.store.getById(result.job_id);
        expect(job).toBeDefined();
        expect(job!.kind).toBe("cron");
        expect(job!.cron_expr).toBe("*/5 * * * *");
        expect(job!.status).toBe("pending");
        expect(job!.owner).toBe("test-session-456");

        // Payload should contain prompt, reason, and expression.
        const payload = JSON.parse(job!.payload);
        expect(payload.prompt).toBe("Check metrics");
        expect(payload.reason).toBe("Every 5 minutes");
        expect(payload.expression).toBe("*/5 * * * *");
      });

      it("rejects invalid cron expressions", async () => {
        // Expression with invalid minute value (60).
        const input: CronCreateInput = {
          expression: "60 * * * *",
          prompt: "Invalid",
          reason: "Test",
        };

        await expect(cronCreateTool.handler(input, ctx)).rejects.toMatchObject({
          code: "invalid_expression",
        });
      });
    });
  });

  describe("CronList", () => {
    describe("list-returns-owned", () => {
      it("returns only jobs owned by session", async () => {
        // Create jobs with this session.
        await cronCreateTool.handler(
          { expression: "*/10 * * * *", prompt: "Job 1", reason: "Test" },
          ctx,
        );
        await cronCreateTool.handler(
          { expression: "0 * * * *", prompt: "Job 2", reason: "Test" },
          ctx,
        );

        // Create job with different session.
        const otherCtx = { ...ctx, sessionId: "other-session" };
        await cronCreateTool.handler(
          { expression: "30 * * * *", prompt: "Other job", reason: "Test" },
          otherCtx,
        );

        // List should only return this session's jobs.
        const result = await cronListTool.handler({}, ctx);
        expect(result).toHaveLength(2);
        expect(result.map((j) => j.prompt).sort()).toEqual(["Job 1", "Job 2"]);
      });

      it("returns job details including fire_count", async () => {
        const createResult = await cronCreateTool.handler(
          { expression: "*/5 * * * *", prompt: "Test job", reason: "Testing" },
          ctx,
        );

        const result = await cronListTool.handler({}, ctx);
        expect(result).toHaveLength(1);

        const job = result[0]!;
        expect(job.id).toBe(createResult.job_id);
        expect(job.expression).toBe("*/5 * * * *");
        expect(job.prompt).toBe("Test job");
        expect(job.reason).toBe("Testing");
        expect(job.fire_count).toBe(0);
        expect(job.status).toBe("pending");
      });

      it("returns empty array when no jobs", async () => {
        const result = await cronListTool.handler({}, ctx);
        expect(result).toEqual([]);
      });
    });
  });

  describe("CronDelete", () => {
    describe("delete-cancels", () => {
      it("cancels an owned job", async () => {
        const createResult = await cronCreateTool.handler(
          { expression: "*/5 * * * *", prompt: "To delete", reason: "Test" },
          ctx,
        );

        const deleteInput: CronDeleteInput = { id: createResult.job_id };
        const deleteResult = await cronDeleteTool.handler(deleteInput, ctx);
        expect(deleteResult.deleted).toBe(true);

        // Job should be cancelled in store.
        const job = scheduler.store.getById(createResult.job_id);
        expect(job!.status).toBe("cancelled");

        // Should no longer appear in list.
        const listResult = await cronListTool.handler({}, ctx);
        expect(listResult).toHaveLength(0);
      });

      it("rejects deletion of job owned by another session", async () => {
        // Create job with different session.
        const otherCtx = { ...ctx, sessionId: "other-session" };
        const createResult = await cronCreateTool.handler(
          { expression: "*/5 * * * *", prompt: "Other job", reason: "Test" },
          otherCtx,
        );

        // Try to delete from this session.
        const deleteInput: CronDeleteInput = { id: createResult.job_id };
        await expect(cronDeleteTool.handler(deleteInput, ctx)).rejects.toMatchObject({
          code: "forbidden",
        });
      });

      it("throws unknown_job for non-existent job", async () => {
        const deleteInput: CronDeleteInput = { id: "nonexistent-job" };
        await expect(cronDeleteTool.handler(deleteInput, ctx)).rejects.toMatchObject({
          code: "unknown_job",
        });
      });
    });
  });

  describe("integration with scheduler", () => {
    it("cron job fires and reschedules", async () => {
      let currentTime = 5000000;
      const fakeNow = (): number => currentTime;

      const scheduler = new Scheduler({
        stateDir: tempDir,
        tickIntervalMs: 50,
        heartbeatIntervalMs: 60000,
        now: fakeNow,
      });

      let fireCount = 0;
      scheduler.registerHandler("cron", () => {
        fireCount++;
        return Promise.resolve();
      });

      scheduler.start();

      // Insert a cron job that fires at currentTime + 100.
      scheduler.store.insertJob({
        id: "cron-integration-test",
        kind: "cron",
        fire_at: currentTime + 100,
        cron_expr: "*/5 * * * *",
        payload: JSON.stringify({ prompt: "Test", reason: "Integration" }),
        owner: "test-session",
      });

      // Advance time past first fire.
      for (let i = 0; i < 20; i++) {
        currentTime += 50;
        await scheduler.waitForTick();
      }

      expect(fireCount).toBe(1);

      // Job should be rescheduled with new fire_at.
      const job = scheduler.store.getById("cron-integration-test");
      expect(job?.status).toBe("pending");
      expect(job?.fire_count).toBe(1);
      expect(job?.fire_at).toBeGreaterThan(5001000);

      await scheduler.stop();
    });
  });
});
