/**
 * Tests for ScheduleWakeup tool (T4-02).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IpcServer } from "../daemon/ipc.js";
import { Scheduler } from "../daemon/scheduler.js";
import { createLogger } from "../logger.js";
import {
  scheduleWakeupInputSchema,
  scheduleWakeupTool,
  type ScheduleWakeupInput,
} from "./schedule-wakeup.js";
import type { ToolContext } from "./types.js";

describe("ScheduleWakeup", () => {
  let tempDir: string;
  let scheduler: Scheduler;
  let server: IpcServer;
  let ctx: ToolContext;
  const originalEnv = process.env.JELLYCLAW_SCHEDULER_SOCKET;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "jc-schedule-test-"));

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
      sessionId: "test-session-123",
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

  describe("input validation", () => {
    it("accepts valid input", () => {
      const input = {
        delaySeconds: 300,
        prompt: "Check the status",
        reason: "Periodic check",
      };
      expect(() => scheduleWakeupInputSchema.parse(input)).not.toThrow();
    });

    it("rejects delay < 60", () => {
      const input = {
        delaySeconds: 30,
        prompt: "Too soon",
        reason: "Invalid",
      };
      expect(() => scheduleWakeupInputSchema.parse(input)).toThrow();
    });

    it("rejects delay > 3600", () => {
      const input = {
        delaySeconds: 7200,
        prompt: "Too late",
        reason: "Invalid",
      };
      expect(() => scheduleWakeupInputSchema.parse(input)).toThrow();
    });

    it("rejects empty prompt", () => {
      const input = {
        delaySeconds: 300,
        prompt: "",
        reason: "Empty prompt",
      };
      expect(() => scheduleWakeupInputSchema.parse(input)).toThrow();
    });
  });

  describe("schedules-correctly", () => {
    it("creates a wakeup job with correct fire_at", async () => {
      const input: ScheduleWakeupInput = {
        delaySeconds: 120,
        prompt: "Check build status",
        reason: "Waiting for CI",
      };

      const before = Date.now();
      const result = await scheduleWakeupTool.handler(input, ctx);
      const after = Date.now();

      // Should return job_id and fire_at_unix_ms.
      expect(result.job_id).toMatch(/^wakeup-/);
      expect(result.fire_at_unix_ms).toBeGreaterThanOrEqual(before + 120000);
      expect(result.fire_at_unix_ms).toBeLessThanOrEqual(after + 120000);

      // Job should be in the store.
      const job = scheduler.store.getById(result.job_id);
      expect(job).toBeDefined();
      expect(job!.kind).toBe("wakeup");
      expect(job!.status).toBe("pending");
      expect(job!.owner).toBe("test-session-123");

      // Payload should contain prompt and reason.
      const payload = JSON.parse(job!.payload);
      expect(payload.prompt).toBe("Check build status");
      expect(payload.reason).toBe("Waiting for CI");
      expect(payload.owner_session).toBe("test-session-123");
    });

    it("schedules job at edge case delays", async () => {
      // Min delay (60s).
      const minResult = await scheduleWakeupTool.handler(
        { delaySeconds: 60, prompt: "Min delay", reason: "Test" },
        ctx,
      );
      expect(minResult.job_id).toMatch(/^wakeup-/);

      // Max delay (3600s).
      const maxResult = await scheduleWakeupTool.handler(
        { delaySeconds: 3600, prompt: "Max delay", reason: "Test" },
        ctx,
      );
      expect(maxResult.job_id).toMatch(/^wakeup-/);

      // Both jobs should exist.
      expect(scheduler.store.getById(minResult.job_id)).toBeDefined();
      expect(scheduler.store.getById(maxResult.job_id)).toBeDefined();
    });
  });

  describe("error handling", () => {
    it("throws daemon_unreachable when server not running", async () => {
      await server.stop();

      const input: ScheduleWakeupInput = {
        delaySeconds: 300,
        prompt: "Test",
        reason: "Test",
      };

      await expect(scheduleWakeupTool.handler(input, ctx)).rejects.toMatchObject({
        code: "daemon_unreachable",
      });
    });
  });
});
