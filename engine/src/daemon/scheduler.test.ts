/**
 * Tests for the scheduler daemon (T4-01).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { nextFireTime, parseCronExpression } from "./cron-parser.js";
import { Scheduler } from "./scheduler.js";

describe("Scheduler", () => {
  let tempDir: string;
  let scheduler: Scheduler;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "jc-scheduler-test-"));
  });

  afterEach(async () => {
    if (scheduler) {
      await scheduler.stop();
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("wakeup-fires-10s", () => {
    it("fires a wakeup job within the accuracy window", async () => {
      // Use a fake clock.
      let currentTime = 1000000;
      const fakeNow = (): number => currentTime;

      scheduler = new Scheduler({
        stateDir: tempDir,
        tickIntervalMs: 50,
        heartbeatIntervalMs: 60000, // Disable heartbeat noise.
        now: fakeNow,
      });

      const firedJobs: string[] = [];
      const fireTimes: number[] = [];

      scheduler.registerHandler("wakeup", (job) => {
        firedJobs.push(job.id);
        fireTimes.push(currentTime);
        return Promise.resolve();
      });

      await scheduler.start();

      // Schedule a job 10 seconds out.
      const scheduledFireAt = currentTime + 10000;
      scheduler.store.insertJob({
        id: "wakeup-10s",
        kind: "wakeup",
        fire_at: scheduledFireAt,
        payload: JSON.stringify({ test: true }),
        owner: "test",
      });

      // Advance time in steps.
      for (let i = 0; i < 220; i++) {
        currentTime += 50;
        await scheduler.waitForTick();

        if (firedJobs.includes("wakeup-10s")) {
          break;
        }
      }

      // Should have fired.
      expect(firedJobs).toContain("wakeup-10s");

      // Check timing: should fire between t+9s and t+13s (±3s accuracy).
      const fireTime = fireTimes[0]!;
      const delta = fireTime - 1000000;
      expect(delta).toBeGreaterThanOrEqual(9000);
      expect(delta).toBeLessThanOrEqual(13000);

      // Check that job_events recorded both fired and completed.
      const events = scheduler.store.listEvents("wakeup-10s");
      expect(events.some((e) => e.event === "fired")).toBe(true);
      expect(events.some((e) => e.event === "completed")).toBe(true);
    });
  });

  describe("survives-restart", () => {
    it("persists pending jobs across scheduler restart", async () => {
      let currentTime = 2000000;
      const fakeNow = (): number => currentTime;

      // Create first scheduler instance.
      scheduler = new Scheduler({
        stateDir: tempDir,
        tickIntervalMs: 50,
        heartbeatIntervalMs: 60000,
        now: fakeNow,
      });

      const firedJobs: string[] = [];

      scheduler.registerHandler("wakeup", (job) => {
        firedJobs.push(job.id);
        return Promise.resolve();
      });

      await scheduler.start();

      // Schedule a job 30 seconds out.
      const fireAt = currentTime + 30000;
      scheduler.store.insertJob({
        id: "restart-job",
        kind: "wakeup",
        fire_at: fireAt,
        payload: "{}",
        owner: "test",
      });

      // Advance time 10s — not enough to fire.
      for (let i = 0; i < 200; i++) {
        currentTime += 50;
        await scheduler.waitForTick();
      }

      expect(firedJobs).not.toContain("restart-job");

      // Stop scheduler.
      await scheduler.stop();

      // Create new scheduler instance (simulating restart).
      const scheduler2 = new Scheduler({
        stateDir: tempDir,
        tickIntervalMs: 50,
        heartbeatIntervalMs: 60000,
        now: fakeNow,
      });

      const firedJobs2: string[] = [];
      scheduler2.registerHandler("wakeup", (job) => {
        firedJobs2.push(job.id);
        return Promise.resolve();
      });

      await scheduler2.start();

      // Advance time past fire_at.
      for (let i = 0; i < 500; i++) {
        currentTime += 50;
        await scheduler2.waitForTick();

        if (firedJobs2.includes("restart-job")) {
          break;
        }
      }

      expect(firedJobs2).toContain("restart-job");

      // Clean up.
      await scheduler2.stop();
      scheduler = null as unknown as Scheduler;
    });
  });

  describe("cron-expression-parser", () => {
    // Table-driven tests for cron expressions.
    const testCases: Array<{ expr: string; description: string }> = [
      { expr: "*/5 * * * *", description: "every 5 minutes" },
      { expr: "0 */2 * * *", description: "every 2 hours" },
      { expr: "0 0 * * *", description: "midnight daily" },
      { expr: "0 0 * * 1-5", description: "midnight weekdays" },
      { expr: "30 4 * * *", description: "4:30 AM daily" },
      { expr: "0 0 1 * *", description: "midnight first of month" },
      { expr: "0 0 * * 0", description: "midnight Sunday" },
      { expr: "0 0 * * 7", description: "midnight Sunday (7=Sunday)" },
      { expr: "0 12 * * 1", description: "noon Monday" },
      { expr: "15 10 * * *", description: "10:15 daily" },
      { expr: "0 0 15 * *", description: "midnight 15th of month" },
      { expr: "0 0 * 6 *", description: "midnight every June" },
      { expr: "0 0 1 1 *", description: "midnight Jan 1" },
      { expr: "0 22 * * 1-5", description: "10 PM weekdays" },
      { expr: "*/15 9-17 * * *", description: "every 15 min during business hours" },
      { expr: "0 0,12 * * *", description: "midnight and noon" },
      { expr: "0 6 * * 1,3,5", description: "6 AM Mon/Wed/Fri" },
      { expr: "5 4 * * *", description: "4:05 AM daily" },
      { expr: "0 */3 * * *", description: "every 3 hours" },
      { expr: "0 0 * * 6,0", description: "midnight weekends" },
    ];

    for (const tc of testCases) {
      it(`parses: ${tc.expr} (${tc.description})`, () => {
        expect(() => parseCronExpression(tc.expr)).not.toThrow();
        const parsed = parseCronExpression(tc.expr);
        expect(parsed.minutes.size).toBeGreaterThan(0);
        expect(parsed.hours.size).toBeGreaterThan(0);
      });
    }

    it("rejects invalid expressions", () => {
      expect(() => parseCronExpression("* * *")).toThrow(); // Only 3 fields.
      expect(() => parseCronExpression("60 * * * *")).toThrow(); // Minute out of range.
      expect(() => parseCronExpression("* 25 * * *")).toThrow(); // Hour out of range.
    });
  });

  describe("nextFireTime", () => {
    it("computes next fire time for */5 * * * *", () => {
      // Start at 2024-01-15 10:03:00.
      const start = new Date("2024-01-15T10:03:00Z").getTime();
      const next = nextFireTime("*/5 * * * *", start);

      // Should be 10:05:00.
      const nextDate = new Date(next);
      expect(nextDate.getUTCMinutes()).toBe(5);
      expect(nextDate.getUTCHours()).toBe(10);
    });

    it("computes next fire time for 0 */2 * * *", () => {
      // Start at a time with odd hour, next should be even hour.
      const startDate = new Date();
      startDate.setMinutes(30, 0, 0);
      startDate.setHours(11); // 11:30 local time
      const start = startDate.getTime();

      const next = nextFireTime("0 */2 * * *", start);
      const nextDate = new Date(next);

      // Should be at minute 0 and an even hour.
      expect(nextDate.getMinutes()).toBe(0);
      expect(nextDate.getHours() % 2).toBe(0);
      expect(nextDate.getHours()).toBeGreaterThanOrEqual(12);
    });

    it("computes next fire time for weekday constraint 0 0 * * 1-5", () => {
      // Start on a Saturday in local time.
      const startDate = new Date();
      // Find next Saturday.
      while (startDate.getDay() !== 6) {
        startDate.setDate(startDate.getDate() + 1);
      }
      startDate.setHours(10, 0, 0, 0); // 10:00 local time on Saturday
      const start = startDate.getTime();

      const next = nextFireTime("0 0 * * 1-5", start);
      const nextDate = new Date(next);

      // Should be Monday (day 1) at 00:00 local time.
      expect(nextDate.getDay()).toBe(1); // Monday.
      expect(nextDate.getHours()).toBe(0);
      expect(nextDate.getMinutes()).toBe(0);
    });
  });

  describe("cron job rescheduling", () => {
    it("reschedules cron job after firing", async () => {
      let currentTime = 3000000;
      const fakeNow = (): number => currentTime;

      scheduler = new Scheduler({
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

      await scheduler.start();

      // Insert a cron job that fires at currentTime + 1000.
      scheduler.store.insertJob({
        id: "cron-job",
        kind: "cron",
        fire_at: currentTime + 1000,
        cron_expr: "*/5 * * * *",
        payload: "{}",
        owner: "test",
      });

      // Advance time past first fire.
      for (let i = 0; i < 30; i++) {
        currentTime += 50;
        await scheduler.waitForTick();
      }

      expect(fireCount).toBe(1);

      // Job should now be pending with new fire_at.
      const job = scheduler.store.getById("cron-job");
      expect(job?.status).toBe("pending");
      expect(job?.fire_at).toBeGreaterThan(3001000);
      expect(job?.fire_count).toBe(1);
    });
  });
});
