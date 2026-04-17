/**
 * Tests for resume handler (T4-02).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Scheduler } from "../scheduler.js";
import { JobStore } from "../store.js";
import { createResumeHandler, registerResumeHandlers, type JobPayload } from "./resume.js";

describe("ResumeHandler", () => {
  let tempDir: string;
  let store: JobStore;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "jc-resume-test-"));
    store = new JobStore({ stateDir: tempDir });
    store.open();
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("handleWakeup", () => {
    it("processes wakeup job and marks done", async () => {
      const continuedSessions: Array<{ sessionId: string; prompt: string; reason: string }> = [];
      const mockContinueSession = vi.fn().mockImplementation((sessionId, prompt, reason) => {
        continuedSessions.push({ sessionId, prompt, reason });
        return Promise.resolve();
      });

      const handler = createResumeHandler({
        store,
        continueSession: mockContinueSession,
      });

      // Insert a wakeup job.
      const payload: JobPayload = {
        prompt: "Check build status",
        reason: "CI completion",
        owner_session: "session-123",
      };
      const job = store.insertJob({
        id: "wakeup-test-1",
        kind: "wakeup",
        fire_at: Date.now() - 1000,
        payload: JSON.stringify(payload),
        owner: "session-123",
      });

      // Mark as running (simulating scheduler claim).
      store.claimJob(job.id);

      // Handle the wakeup.
      await handler.handleWakeup(store.getById(job.id)!);

      // Should have continued session.
      expect(mockContinueSession).toHaveBeenCalledWith("session-123", "Check build status", "CI completion");

      // Job should be marked done.
      const updatedJob = store.getById(job.id);
      expect(updatedJob?.status).toBe("done");

      // Should have completed event.
      const events = store.listEvents(job.id);
      expect(events.some((e) => e.event === "completed")).toBe(true);
    });

    it("marks job failed on continuation error", async () => {
      const mockContinueSession = vi.fn().mockRejectedValue(new Error("Session not found"));

      const handler = createResumeHandler({
        store,
        continueSession: mockContinueSession,
      });

      const payload: JobPayload = {
        prompt: "Test",
        reason: "Test",
        owner_session: "session-456",
      };
      const job = store.insertJob({
        id: "wakeup-error-test",
        kind: "wakeup",
        fire_at: Date.now() - 1000,
        payload: JSON.stringify(payload),
        owner: "session-456",
      });
      store.claimJob(job.id);

      await handler.handleWakeup(store.getById(job.id)!);

      // Job should be marked failed.
      const updatedJob = store.getById(job.id);
      expect(updatedJob?.status).toBe("failed");
      expect(updatedJob?.error).toBe("Session not found");

      // Should have error event.
      const events = store.listEvents(job.id);
      expect(events.some((e) => e.event === "error")).toBe(true);
    });

    it("handles invalid payload JSON", async () => {
      const mockContinueSession = vi.fn();

      const handler = createResumeHandler({
        store,
        continueSession: mockContinueSession,
      });

      const job = store.insertJob({
        id: "wakeup-bad-payload",
        kind: "wakeup",
        fire_at: Date.now() - 1000,
        payload: "not valid json",
        owner: "session-789",
      });
      store.claimJob(job.id);

      await handler.handleWakeup(store.getById(job.id)!);

      // Should NOT call continue session.
      expect(mockContinueSession).not.toHaveBeenCalled();

      // Job should be marked failed.
      const updatedJob = store.getById(job.id);
      expect(updatedJob?.status).toBe("failed");
      expect(updatedJob?.error).toBe("Invalid payload JSON");

      // Should have error event.
      const events = store.listEvents(job.id);
      expect(events.some((e) => e.event === "error")).toBe(true);
    });
  });

  describe("handleCron", () => {
    it("processes cron job without marking done", async () => {
      const mockContinueSession = vi.fn().mockResolvedValue(undefined);

      const handler = createResumeHandler({
        store,
        continueSession: mockContinueSession,
      });

      const payload: JobPayload = {
        prompt: "Daily report",
        reason: "Scheduled",
        owner_session: "session-cron",
        expression: "0 9 * * *",
      };
      const job = store.insertJob({
        id: "cron-test-1",
        kind: "cron",
        fire_at: Date.now() - 1000,
        cron_expr: "0 9 * * *",
        payload: JSON.stringify(payload),
        owner: "session-cron",
      });
      store.claimJob(job.id);

      await handler.handleCron(store.getById(job.id)!);

      // Should have continued session.
      expect(mockContinueSession).toHaveBeenCalledWith("session-cron", "Daily report", "Scheduled");

      // Should have completed event (but not marked done - scheduler handles reschedule).
      const events = store.listEvents(job.id);
      expect(events.some((e) => e.event === "completed")).toBe(true);
    });

    it("does not mark cron job failed on error (lets scheduler reschedule)", async () => {
      const mockContinueSession = vi.fn().mockRejectedValue(new Error("Transient error"));

      const handler = createResumeHandler({
        store,
        continueSession: mockContinueSession,
      });

      const payload: JobPayload = {
        prompt: "Test",
        reason: "Test",
        owner_session: "session-cron-error",
        expression: "*/5 * * * *",
      };
      const job = store.insertJob({
        id: "cron-error-test",
        kind: "cron",
        fire_at: Date.now() - 1000,
        cron_expr: "*/5 * * * *",
        payload: JSON.stringify(payload),
        owner: "session-cron-error",
      });
      store.claimJob(job.id);

      await handler.handleCron(store.getById(job.id)!);

      // Job should still be running (scheduler will reschedule).
      const updatedJob = store.getById(job.id);
      expect(updatedJob?.status).toBe("running");

      // Should have error event.
      const events = store.listEvents(job.id);
      expect(events.some((e) => e.event === "error")).toBe(true);
    });
  });

  describe("budget checking", () => {
    it("skips wakeup job when budget exceeded", async () => {
      const mockContinueSession = vi.fn();
      const mockCheckBudget = vi.fn().mockReturnValue({ exceeded: true, reason: "daily cap hit" });

      const handler = createResumeHandler({
        store,
        continueSession: mockContinueSession,
        checkBudget: mockCheckBudget,
      });

      const payload: JobPayload = {
        prompt: "Test",
        reason: "Test",
        owner_session: "session-budget",
      };
      const job = store.insertJob({
        id: "wakeup-budget-test",
        kind: "wakeup",
        fire_at: Date.now() - 1000,
        payload: JSON.stringify(payload),
        owner: "session-budget",
      });
      store.claimJob(job.id);

      await handler.handleWakeup(store.getById(job.id)!);

      // Should NOT call continue session.
      expect(mockContinueSession).not.toHaveBeenCalled();

      // Job should be marked failed.
      const updatedJob = store.getById(job.id);
      expect(updatedJob?.status).toBe("failed");
      expect(updatedJob?.error).toBe("budget_exceeded");

      // Should have skipped event.
      const events = store.listEvents(job.id);
      expect(events.some((e) => e.event === "skipped")).toBe(true);
    });

    it("reschedules cron job when budget exceeded", async () => {
      let currentTime = 1000000;
      const fakeNow = (): number => currentTime;

      const mockContinueSession = vi.fn();
      const mockCheckBudget = vi.fn().mockReturnValue({ exceeded: true, reason: "daily cap" });

      const handler = createResumeHandler({
        store,
        continueSession: mockContinueSession,
        checkBudget: mockCheckBudget,
        now: fakeNow,
      });

      const payload: JobPayload = {
        prompt: "Test",
        reason: "Test",
        owner_session: "session-budget-cron",
        expression: "*/5 * * * *",
      };
      const job = store.insertJob({
        id: "cron-budget-test",
        kind: "cron",
        fire_at: currentTime - 1000,
        cron_expr: "*/5 * * * *",
        payload: JSON.stringify(payload),
        owner: "session-budget-cron",
      });
      store.claimJob(job.id);

      await handler.handleCron(store.getById(job.id)!);

      // Should NOT call continue session.
      expect(mockContinueSession).not.toHaveBeenCalled();

      // Job should be rescheduled (pending with new fire_at).
      const updatedJob = store.getById(job.id);
      expect(updatedJob?.status).toBe("pending");
      expect(updatedJob?.fire_at).toBeGreaterThan(currentTime);

      // Should have skipped event.
      const events = store.listEvents(job.id);
      expect(events.some((e) => e.event === "skipped")).toBe(true);
    });
  });

  describe("survives-restart", () => {
    it("scheduler restarts and pending jobs still fire", async () => {
      let currentTime = 2000000;
      const fakeNow = (): number => currentTime;

      // Create scheduler with resume handlers.
      const scheduler1 = new Scheduler({
        stateDir: tempDir,
        tickIntervalMs: 50,
        heartbeatIntervalMs: 60000,
        now: fakeNow,
      });

      const firedJobs1: string[] = [];
      const mockContinue1 = vi.fn().mockImplementation(() => {
        return Promise.resolve();
      });

      const handler1 = createResumeHandler({
        store: scheduler1.store,
        continueSession: mockContinue1,
        now: fakeNow,
      });

      scheduler1.registerHandler("wakeup", async (job) => {
        firedJobs1.push(job.id);
        await handler1.handleWakeup(job);
      });

      scheduler1.start();

      // Schedule a wakeup job 30 seconds out.
      const fireAt = currentTime + 30000;
      scheduler1.store.insertJob({
        id: "restart-wakeup",
        kind: "wakeup",
        fire_at: fireAt,
        payload: JSON.stringify({ prompt: "Restart test", reason: "Test", owner_session: "s1" }),
        owner: "s1",
      });

      // Advance 10s - not enough to fire.
      for (let i = 0; i < 200; i++) {
        currentTime += 50;
        await scheduler1.waitForTick();
      }
      expect(firedJobs1).not.toContain("restart-wakeup");

      // Stop scheduler (simulating process restart).
      await scheduler1.stop();

      // Create new scheduler instance.
      const scheduler2 = new Scheduler({
        stateDir: tempDir,
        tickIntervalMs: 50,
        heartbeatIntervalMs: 60000,
        now: fakeNow,
      });

      const firedJobs2: string[] = [];
      const mockContinue2 = vi.fn().mockResolvedValue(undefined);

      const handler2 = createResumeHandler({
        store: scheduler2.store,
        continueSession: mockContinue2,
        now: fakeNow,
      });

      scheduler2.registerHandler("wakeup", async (job) => {
        firedJobs2.push(job.id);
        await handler2.handleWakeup(job);
      });

      scheduler2.start();

      // Advance time past fire_at.
      for (let i = 0; i < 500; i++) {
        currentTime += 50;
        await scheduler2.waitForTick();

        if (firedJobs2.includes("restart-wakeup")) {
          break;
        }
      }

      // Should have fired after restart.
      expect(firedJobs2).toContain("restart-wakeup");
      expect(mockContinue2).toHaveBeenCalledWith("s1", "Restart test", "Test");

      await scheduler2.stop();
    });
  });

  describe("registerResumeHandlers", () => {
    it("registers both wakeup and cron handlers", async () => {
      let currentTime = 3000000;
      const fakeNow = (): number => currentTime;

      const scheduler = new Scheduler({
        stateDir: tempDir,
        tickIntervalMs: 50,
        heartbeatIntervalMs: 60000,
        now: fakeNow,
      });

      const continuedSessions: string[] = [];
      const mockContinueSession = vi.fn().mockImplementation((sessionId) => {
        continuedSessions.push(sessionId);
        return Promise.resolve();
      });

      registerResumeHandlers(scheduler, {
        continueSession: mockContinueSession,
        now: fakeNow,
      });

      scheduler.start();

      // Insert both types of jobs.
      scheduler.store.insertJob({
        id: "wakeup-register-test",
        kind: "wakeup",
        fire_at: currentTime + 100,
        payload: JSON.stringify({ prompt: "W", reason: "W", owner_session: "w1" }),
        owner: "w1",
      });
      scheduler.store.insertJob({
        id: "cron-register-test",
        kind: "cron",
        fire_at: currentTime + 200,
        cron_expr: "*/5 * * * *",
        payload: JSON.stringify({ prompt: "C", reason: "C", owner_session: "c1" }),
        owner: "c1",
      });

      // Advance time past both fire_at values.
      for (let i = 0; i < 50; i++) {
        currentTime += 50;
        await scheduler.waitForTick();
      }

      // Both should have fired.
      expect(continuedSessions).toContain("w1");
      expect(continuedSessions).toContain("c1");

      await scheduler.stop();
    });
  });
});
