/**
 * Tests for Monitor tools (T4-04).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentEvent } from "../events.js";
import { MonitorRuntime } from "../daemon/handlers/monitor.js";
import { _resetMonitorRuntime, monitorStopTool, monitorTool } from "./monitor.js";
import { MonitorRegistry } from "./monitor-registry.js";
import type { ToolContext } from "./types.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createMockContext(sessionId: string, cwd: string): ToolContext {
  return {
    sessionId,
    cwd,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      fatal: vi.fn(),
      child: () => createMockContext(sessionId, cwd).logger,
      level: "info",
      silent: vi.fn(),
    } as unknown as ToolContext["logger"],
    signal: new AbortController().signal,
  };
}

interface CollectedEvent {
  type: string;
  monitor_id?: string;
  lines?: string[];
  dropped?: number;
  fs_event?: { type: string; path: string };
}

function createTestRuntime(
  tempDir: string,
  events: CollectedEvent[],
): { runtime: MonitorRuntime; registry: MonitorRegistry } {
  const emitter = {
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

  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as import("pino").Logger;

  const runtime = new MonitorRuntime({
    stateDir: tempDir,
    logger,
    emitter,
  });

  return { runtime, registry: runtime.registry };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Monitor", () => {
  let tempDir: string;
  let events: CollectedEvent[];
  let runtime: MonitorRuntime;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "monitor-test-"));
    events = [];
    const testRuntime = createTestRuntime(tempDir, events);
    runtime = testRuntime.runtime;
    runtime.start();
    _resetMonitorRuntime(runtime);
  });

  afterEach(async () => {
    await runtime.stop();
    _resetMonitorRuntime();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("tail-file-emits", () => {
    it("tailing a file emits events for each line written", async () => {
      // Create a test file.
      const testFile = path.join(tempDir, "test.log");
      fs.writeFileSync(testFile, "");

      const ctx = createMockContext("session-123", tempDir);
      const result = await monitorTool.handler(
        {
          kind: "tail",
          target: testFile,
        },
        ctx,
      );

      expect(result.monitor_id).toBeDefined();
      expect(result.started_at).toBeGreaterThan(0);

      // Wait a bit for tail to start.
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Append lines to the file.
      fs.appendFileSync(testFile, "line 1\n");
      await new Promise((resolve) => setTimeout(resolve, 100));
      fs.appendFileSync(testFile, "line 2\n");
      await new Promise((resolve) => setTimeout(resolve, 100));
      fs.appendFileSync(testFile, "line 3\n");

      // Wait for events to be emitted.
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Check that events were emitted.
      const monitorEvents = events.filter(
        (e) => e.type === "monitor.event" && e.monitor_id === result.monitor_id,
      );

      // Events may be batched, so count total lines.
      let totalLines = 0;
      const allLines: string[] = [];
      for (const ev of monitorEvents) {
        if (ev.lines) {
          totalLines += ev.lines.length;
          allLines.push(...ev.lines);
        }
      }

      expect(totalLines).toBe(3);
      expect(allLines).toContain("line 1");
      expect(allLines).toContain("line 2");
      expect(allLines).toContain("line 3");
    });
  });

  describe("stop-cleans-up", () => {
    it("MonitorStop kills process and cleans registry", async () => {
      // Create a test file.
      const testFile = path.join(tempDir, "stop-test.log");
      fs.writeFileSync(testFile, "");

      const ctx = createMockContext("session-stop", tempDir);
      const result = await monitorTool.handler(
        {
          kind: "tail",
          target: testFile,
        },
        ctx,
      );

      // Wait for tail to start.
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Verify monitor is running.
      expect(runtime.isRunning(result.monitor_id)).toBe(true);
      expect(runtime.registry.getById(result.monitor_id)?.status).toBe("running");

      // Stop the monitor.
      const stopResult = await monitorStopTool.handler({ id: result.monitor_id }, ctx);

      expect(stopResult.id).toBe(result.monitor_id);
      expect(stopResult.stopped_at).toBeGreaterThan(0);

      // Wait for cleanup.
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Monitor should no longer be running.
      expect(runtime.isRunning(result.monitor_id)).toBe(false);

      // Registry should show stopped.
      const monitor = runtime.registry.getById(result.monitor_id);
      expect(monitor?.status).toBe("stopped");

      // Further writes should not emit events.
      const eventCountBefore = events.filter((e) => e.type === "monitor.event").length;
      fs.appendFileSync(testFile, "after stop\n");
      await new Promise((resolve) => setTimeout(resolve, 200));
      const eventCountAfter = events.filter((e) => e.type === "monitor.event").length;

      expect(eventCountAfter).toBe(eventCountBefore);
    });
  });

  describe("line-cap", () => {
    it("truncates lines longer than 8KB", async () => {
      // Create a test file.
      const testFile = path.join(tempDir, "long-line.log");
      fs.writeFileSync(testFile, "");

      const ctx = createMockContext("session-cap", tempDir);
      const result = await monitorTool.handler(
        {
          kind: "tail",
          target: testFile,
        },
        ctx,
      );

      // Wait for tail to start.
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Write a 20KB line.
      const longLine = "x".repeat(20 * 1024);
      fs.appendFileSync(testFile, longLine + "\n");

      // Wait for event.
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Find the event.
      const monitorEvents = events.filter(
        (e) => e.type === "monitor.event" && e.monitor_id === result.monitor_id && e.lines,
      );

      expect(monitorEvents.length).toBeGreaterThan(0);

      const line = monitorEvents[0]?.lines?.[0];
      expect(line).toBeDefined();

      // Line should be truncated.
      const lineBytes = Buffer.byteLength(line ?? "", "utf8");
      expect(lineBytes).toBeLessThanOrEqual(8192);

      // Should contain elision marker.
      expect(line).toContain("elided");
    });
  });

  describe("rate-limit-batching", () => {
    it("coalesces rapid lines into batched events", async () => {
      // Create a test file.
      const testFile = path.join(tempDir, "rapid.log");
      fs.writeFileSync(testFile, "");

      const ctx = createMockContext("session-rate", tempDir);
      const result = await monitorTool.handler(
        {
          kind: "tail",
          target: testFile,
        },
        ctx,
      );

      // Wait for tail to start.
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Write 200 lines rapidly.
      const lines: string[] = [];
      for (let i = 0; i < 200; i++) {
        lines.push(`line ${i}`);
      }
      fs.appendFileSync(testFile, lines.join("\n") + "\n");

      // Wait for events to be batched and emitted.
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Count events and total lines.
      const monitorEvents = events.filter(
        (e) => e.type === "monitor.event" && e.monitor_id === result.monitor_id && e.lines,
      );

      // Should have fewer than 10 events due to batching.
      expect(monitorEvents.length).toBeLessThan(10);

      // Count total lines received.
      let totalLines = 0;
      for (const ev of monitorEvents) {
        if (ev.lines) {
          totalLines += ev.lines.length;
        }
      }

      // Should have received all 200 lines (nothing dropped).
      expect(totalLines).toBe(200);
    });
  });

  describe("pattern filtering", () => {
    it("only emits lines matching pattern", async () => {
      // Create a test file.
      const testFile = path.join(tempDir, "pattern.log");
      fs.writeFileSync(testFile, "");

      const ctx = createMockContext("session-pattern", tempDir);
      const result = await monitorTool.handler(
        {
          kind: "tail",
          target: testFile,
          pattern: "ERROR",
        },
        ctx,
      );

      // Wait for tail to start.
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Write lines, some matching, some not.
      fs.appendFileSync(testFile, "INFO: normal line\n");
      fs.appendFileSync(testFile, "ERROR: something bad\n");
      fs.appendFileSync(testFile, "DEBUG: debug info\n");
      fs.appendFileSync(testFile, "ERROR: another error\n");

      // Wait for events.
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Get all lines from events.
      const monitorEvents = events.filter(
        (e) => e.type === "monitor.event" && e.monitor_id === result.monitor_id && e.lines,
      );

      const allLines: string[] = [];
      for (const ev of monitorEvents) {
        if (ev.lines) {
          allLines.push(...ev.lines);
        }
      }

      // Should only have ERROR lines.
      expect(allLines).toHaveLength(2);
      expect(allLines.every((l) => l.includes("ERROR"))).toBe(true);
    });
  });

  describe("validation", () => {
    it("rejects invalid regex pattern", async () => {
      const ctx = createMockContext("session-invalid", tempDir);

      await expect(
        monitorTool.handler(
          {
            kind: "cmd",
            target: "echo test",
            pattern: "[invalid",
          },
          ctx,
        ),
      ).rejects.toThrow("Invalid regex");
    });

    it("rejects non-existent file for tail", async () => {
      const ctx = createMockContext("session-notfound", tempDir);

      await expect(
        monitorTool.handler(
          {
            kind: "tail",
            target: "/nonexistent/file.log",
          },
          ctx,
        ),
      ).rejects.toThrow("does not exist");
    });
  });
});
