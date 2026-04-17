/**
 * Tests for MonitorRegistry (T4-04).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type CreateMonitorInput, MonitorRegistry } from "./monitor-registry.js";

describe("MonitorRegistry", () => {
  let tempDir: string;
  let registry: MonitorRegistry;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "monitor-registry-test-"));
    registry = new MonitorRegistry({ stateDir: tempDir });
    registry.open();
  });

  afterEach(() => {
    registry.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("basic operations", () => {
    it("creates a monitor", () => {
      const input: CreateMonitorInput = {
        id: "mon-123",
        owner: "session-abc",
        kind: "tail",
        target: "/var/log/test.log",
        pattern: "ERROR",
        max_lines: 100,
        persistent: true,
        notify: "agent",
      };

      const monitor = registry.create(input);

      expect(monitor.id).toBe("mon-123");
      expect(monitor.owner).toBe("session-abc");
      expect(monitor.kind).toBe("tail");
      expect(monitor.target).toBe("/var/log/test.log");
      expect(monitor.pattern).toBe("ERROR");
      expect(monitor.max_lines).toBe(100);
      expect(monitor.persistent).toBe(true);
      expect(monitor.notify).toBe("agent");
      expect(monitor.status).toBe("running");
      expect(monitor.events_emitted).toBe(0);
    });

    it("gets a monitor by id", () => {
      registry.create({
        id: "mon-456",
        owner: "session-abc",
        kind: "watch",
        target: "/tmp/watch",
      });

      const monitor = registry.getById("mon-456");
      expect(monitor).toBeDefined();
      expect(monitor?.id).toBe("mon-456");
      expect(monitor?.kind).toBe("watch");
    });

    it("returns undefined for non-existent monitor", () => {
      const monitor = registry.getById("nonexistent");
      expect(monitor).toBeUndefined();
    });

    it("gets monitor by id and owner", () => {
      registry.create({
        id: "mon-789",
        owner: "session-A",
        kind: "cmd",
        target: "echo hello",
      });

      // Correct owner.
      const monitor = registry.getByIdAndOwner("mon-789", "session-A");
      expect(monitor).toBeDefined();

      // Wrong owner.
      const wrongOwner = registry.getByIdAndOwner("mon-789", "session-B");
      expect(wrongOwner).toBeUndefined();
    });
  });

  describe("listing", () => {
    it("lists monitors by owner", () => {
      registry.create({
        id: "mon-1",
        owner: "session-A",
        kind: "tail",
        target: "/log1",
      });
      registry.create({
        id: "mon-2",
        owner: "session-A",
        kind: "tail",
        target: "/log2",
      });
      registry.create({
        id: "mon-3",
        owner: "session-B",
        kind: "tail",
        target: "/log3",
      });

      const listA = registry.listAll("session-A");
      expect(listA).toHaveLength(2);
      expect(listA.map((m) => m.id).sort()).toEqual(["mon-1", "mon-2"]);

      const listB = registry.listAll("session-B");
      expect(listB).toHaveLength(1);
      expect(listB[0]?.id).toBe("mon-3");
    });

    it("lists persistent monitors", () => {
      registry.create({
        id: "mon-persistent",
        owner: "session-A",
        kind: "tail",
        target: "/log1",
        persistent: true,
      });
      registry.create({
        id: "mon-ephemeral",
        owner: "session-A",
        kind: "tail",
        target: "/log2",
        persistent: false,
      });

      const persistent = registry.listPersistent();
      expect(persistent).toHaveLength(1);
      expect(persistent[0]?.id).toBe("mon-persistent");
    });
  });

  describe("status updates", () => {
    it("marks monitor as stopped", () => {
      registry.create({
        id: "mon-stop",
        owner: "session-A",
        kind: "tail",
        target: "/log",
      });

      registry.markStopped("mon-stop");

      const monitor = registry.getById("mon-stop");
      expect(monitor?.status).toBe("stopped");
      expect(monitor?.stopped_at).toBeDefined();
    });

    it("marks monitor as exhausted", () => {
      registry.create({
        id: "mon-exhaust",
        owner: "session-A",
        kind: "tail",
        target: "/log",
        max_lines: 10,
      });

      registry.markExhausted("mon-exhaust");

      const monitor = registry.getById("mon-exhaust");
      expect(monitor?.status).toBe("exhausted");
    });

    it("marks monitor as error", () => {
      registry.create({
        id: "mon-error",
        owner: "session-A",
        kind: "tail",
        target: "/log",
      });

      registry.markError("mon-error", "file not found");

      const monitor = registry.getById("mon-error");
      expect(monitor?.status).toBe("error");
      expect(monitor?.error).toBe("file not found");
    });

    it("increments emitted count", () => {
      registry.create({
        id: "mon-emit",
        owner: "session-A",
        kind: "tail",
        target: "/log",
      });

      registry.incrementEmitted("mon-emit", 5);
      expect(registry.getById("mon-emit")?.events_emitted).toBe(5);

      registry.incrementEmitted("mon-emit", 3);
      expect(registry.getById("mon-emit")?.events_emitted).toBe(8);
    });
  });

  describe("daemon restart handling", () => {
    it("marks non-persistent monitors as stopped", () => {
      registry.create({
        id: "mon-persistent",
        owner: "session-A",
        kind: "tail",
        target: "/log1",
        persistent: true,
      });
      registry.create({
        id: "mon-ephemeral",
        owner: "session-A",
        kind: "tail",
        target: "/log2",
        persistent: false,
      });

      const count = registry.markNonPersistentStopped();
      expect(count).toBe(1);

      // Persistent should still be running.
      expect(registry.getById("mon-persistent")?.status).toBe("running");

      // Ephemeral should be stopped with daemon_restart error.
      const ephemeral = registry.getById("mon-ephemeral");
      expect(ephemeral?.status).toBe("stopped");
      expect(ephemeral?.error).toBe("daemon_restart");
    });
  });

  describe("deletion", () => {
    it("deletes a monitor", () => {
      registry.create({
        id: "mon-delete",
        owner: "session-A",
        kind: "tail",
        target: "/log",
      });

      expect(registry.exists("mon-delete")).toBe(true);

      const deleted = registry.delete("mon-delete");
      expect(deleted).toBe(true);
      expect(registry.exists("mon-delete")).toBe(false);
    });

    it("returns false when deleting non-existent monitor", () => {
      const deleted = registry.delete("nonexistent");
      expect(deleted).toBe(false);
    });
  });
});
