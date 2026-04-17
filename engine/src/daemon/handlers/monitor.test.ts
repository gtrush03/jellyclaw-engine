/**
 * Tests for MonitorRuntime (T4-04).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentEvent } from "../../events.js";
import { MonitorRuntime } from "./monitor.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface CollectedEvent {
  type: string;
  monitor_id?: string;
  lines?: string[];
  reason?: string;
}

function createTestEmitter(events: CollectedEvent[]): { emit: (event: AgentEvent) => void } {
  return {
    emit: (event: AgentEvent) => {
      if (
        event.type === "monitor.started" ||
        event.type === "monitor.event" ||
        event.type === "monitor.stopped"
      ) {
        events.push(event as CollectedEvent);
      }
    },
  };
}

function createTestLogger(): import("pino").Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: () => createTestLogger(),
    level: "info",
    silent: vi.fn(),
  } as unknown as import("pino").Logger;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MonitorRuntime", () => {
  let tempDir: string;
  let events: CollectedEvent[];
  let runtime: MonitorRuntime;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "monitor-runtime-test-"));
    events = [];
    runtime = new MonitorRuntime({
      stateDir: tempDir,
      logger: createTestLogger(),
      emitter: createTestEmitter(events),
    });
    runtime.start();
  });

  afterEach(async () => {
    await runtime.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("survives-restart", () => {
    it("persistent monitor is recreated on daemon restart", async () => {
      // Create a directory to watch.
      const watchDir = path.join(tempDir, "watch-dir");
      fs.mkdirSync(watchDir);

      // Create a persistent watch monitor.
      const result = runtime.createMonitor(
        {
          kind: "watch",
          target: watchDir,
          persistent: true,
        },
        "session-persist",
      );

      expect(result.monitor_id).toBeDefined();

      // Wait for watcher to start.
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Verify monitor is running.
      expect(runtime.isRunning(result.monitor_id)).toBe(true);
      expect(runtime.registry.getById(result.monitor_id)?.persistent).toBe(true);

      // Create a new file.
      fs.writeFileSync(path.join(watchDir, "file1.txt"), "hello");
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Should have received an event.
      const eventsBefore = events.filter(
        (e) => e.type === "monitor.event" && e.monitor_id === result.monitor_id,
      );
      expect(eventsBefore.length).toBeGreaterThan(0);

      // Simulate daemon restart: stop and recreate runtime.
      await runtime.stop();

      // Create new runtime instance.
      const events2: CollectedEvent[] = [];
      const runtime2 = new MonitorRuntime({
        stateDir: tempDir,
        logger: createTestLogger(),
        emitter: createTestEmitter(events2),
      });
      runtime2.start();

      // Wait for persistent monitors to be recovered.
      await new Promise((resolve) => setTimeout(resolve, 300));

      // The persistent monitor should be recovered and running.
      expect(runtime2.isRunning(result.monitor_id)).toBe(true);

      // Create another file to verify watcher is working.
      fs.writeFileSync(path.join(watchDir, "file2.txt"), "world");
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Should have received an event in the new runtime.
      const eventsAfter = events2.filter(
        (e) => e.type === "monitor.event" && e.monitor_id === result.monitor_id,
      );
      expect(eventsAfter.length).toBeGreaterThan(0);

      // Non-persistent monitors should NOT be recovered.
      // Create a non-persistent monitor first.
      const nonPersistentResult = runtime2.createMonitor(
        {
          kind: "watch",
          target: watchDir,
          persistent: false,
        },
        "session-ephemeral",
      );

      await runtime2.stop();

      // Create another runtime.
      const events3: CollectedEvent[] = [];
      const runtime3 = new MonitorRuntime({
        stateDir: tempDir,
        logger: createTestLogger(),
        emitter: createTestEmitter(events3),
      });
      runtime3.start();

      await new Promise((resolve) => setTimeout(resolve, 200));

      // Non-persistent should NOT be running.
      expect(runtime3.isRunning(nonPersistentResult.monitor_id)).toBe(false);

      // It should be marked as stopped in registry.
      const ephemeralMon = runtime3.registry.getById(nonPersistentResult.monitor_id);
      expect(ephemeralMon?.status).toBe("stopped");
      expect(ephemeralMon?.error).toBe("daemon_restart");

      // Persistent should still be running.
      expect(runtime3.isRunning(result.monitor_id)).toBe(true);

      await runtime3.stop();
    });
  });

  describe("cmd monitor", () => {
    it("runs a shell command and emits output", async () => {
      const result = runtime.createMonitor(
        {
          kind: "cmd",
          target: "echo line1 && sleep 0.1 && echo line2 && sleep 0.1 && echo line3",
        },
        "session-cmd",
      );

      // Wait for command to complete.
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Check events.
      const monitorEvents = events.filter(
        (e) => e.type === "monitor.event" && e.monitor_id === result.monitor_id && e.lines,
      );

      let totalLines = 0;
      const allLines: string[] = [];
      for (const ev of monitorEvents) {
        if (ev.lines) {
          totalLines += ev.lines.length;
          allLines.push(...ev.lines);
        }
      }

      expect(totalLines).toBe(3);
      expect(allLines).toContain("line1");
      expect(allLines).toContain("line2");
      expect(allLines).toContain("line3");
    });
  });

  describe("max_lines cutoff", () => {
    it("stops after max_lines is reached", async () => {
      // Create a test file.
      const testFile = path.join(tempDir, "maxlines.log");
      fs.writeFileSync(testFile, "");

      const result = runtime.createMonitor(
        {
          kind: "tail",
          target: testFile,
          max_lines: 3,
        },
        "session-max",
      );

      // Wait for tail to start.
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Write more lines than max_lines.
      fs.appendFileSync(testFile, "line 1\n");
      await new Promise((resolve) => setTimeout(resolve, 100));
      fs.appendFileSync(testFile, "line 2\n");
      await new Promise((resolve) => setTimeout(resolve, 100));
      fs.appendFileSync(testFile, "line 3\n");
      await new Promise((resolve) => setTimeout(resolve, 100));
      fs.appendFileSync(testFile, "line 4\n");
      fs.appendFileSync(testFile, "line 5\n");

      // Wait for processing.
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Monitor should be exhausted.
      const monitor = runtime.registry.getById(result.monitor_id);
      expect(monitor?.status).toBe("exhausted");
      expect(runtime.isRunning(result.monitor_id)).toBe(false);

      // Should have stopped event.
      const stoppedEvents = events.filter(
        (e) => e.type === "monitor.stopped" && e.monitor_id === result.monitor_id,
      );
      expect(stoppedEvents.length).toBe(1);
      expect(stoppedEvents[0]?.reason).toBe("exhausted");
    });
  });

  describe("owner scoping", () => {
    it("monitors are scoped to owner session", () => {
      // Create a directory to watch.
      const watchDir = path.join(tempDir, "owner-test");
      fs.mkdirSync(watchDir);

      const result = runtime.createMonitor(
        {
          kind: "watch",
          target: watchDir,
        },
        "session-A",
      );

      // List monitors for session A.
      const listA = runtime.listMonitors("session-A");
      expect(listA).toHaveLength(1);
      expect(listA[0]?.id).toBe(result.monitor_id);

      // List monitors for session B should be empty.
      const listB = runtime.listMonitors("session-B");
      expect(listB).toHaveLength(0);

      // Owner check.
      expect(runtime.ownerCheck(result.monitor_id, "session-A")).toBe("ok");
      expect(runtime.ownerCheck(result.monitor_id, "session-B")).toBe("forbidden");
      expect(runtime.ownerCheck("nonexistent", "session-A")).toBe("not_found");
    });
  });
});
