/**
 * Tests for plugin loader (T4-05).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { _resetPluginLoader, PluginLoader } from "./loader.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

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

describe("PluginLoader", () => {
  // Use process.cwd() to get the repo root, works in both vitest (source) and built (dist).
  const fixturesDir = path.resolve(process.cwd(), "test/fixtures/plugins");

  beforeEach(() => {
    _resetPluginLoader();
  });

  afterEach(() => {
    _resetPluginLoader();
  });

  describe("plugin-skill-namespaced", () => {
    it("lists skills with namespaced id pluginId:localId", () => {
      const loader = new PluginLoader({
        pluginsDir: fixturesDir,
        logger: createTestLogger(),
      });
      loader.loadAll();

      const skills = loader.listSkills();
      const fooSkill = skills.find((s) => s.id === "testplug:foo");

      expect(fooSkill).toBeDefined();
      expect(fooSkill?.pluginId).toBe("testplug");
      expect(fooSkill?.localId).toBe("foo");
    });

    it("resolves skill by namespaced id", () => {
      const loader = new PluginLoader({
        pluginsDir: fixturesDir,
        logger: createTestLogger(),
      });
      loader.loadAll();

      const skill = loader.getSkill("testplug:foo");

      expect(skill).toBeDefined();
      expect(skill?.path).toContain("testplug/skills/foo/SKILL.md");
    });
  });

  describe("plugin-agent-via-task", () => {
    it("loads plugin agents with namespaced id", () => {
      const loader = new PluginLoader({
        pluginsDir: fixturesDir,
        logger: createTestLogger(),
      });
      loader.loadAll();

      const agents = loader.listAgents();
      const barAgent = agents.find((a) => a.id === "testplug:bar");

      expect(barAgent).toBeDefined();
      expect(barAgent?.pluginId).toBe("testplug");
      expect(barAgent?.localId).toBe("bar");
    });

    it("agent has frontmatter with tools whitelist", () => {
      const loader = new PluginLoader({
        pluginsDir: fixturesDir,
        logger: createTestLogger(),
      });
      loader.loadAll();

      const agent = loader.getAgent("testplug:bar");

      expect(agent).toBeDefined();
      expect(agent?.frontmatter.tools).toEqual(["Bash", "Read"]);
      expect(agent?.prompt).toContain("bar agent from the testplug plugin");
    });
  });

  describe("plugin-hooks-fire", () => {
    it("loads plugin hooks", () => {
      const loader = new PluginLoader({
        pluginsDir: fixturesDir,
        logger: createTestLogger(),
      });
      loader.loadAll();

      const hooks = loader.listHooks();
      const preToolHook = hooks.find((h) => h.id === "testplug:PreToolUse");

      expect(preToolHook).toBeDefined();
      expect(preToolHook?.event).toBe("PreToolUse");
      expect(preToolHook?.config.command).toBe("echo");
      expect(preToolHook?.config.args).toEqual(["hook-fired"]);
    });
  });

  describe("plugin-slash-command", () => {
    it("loads plugin slash commands", () => {
      const loader = new PluginLoader({
        pluginsDir: fixturesDir,
        logger: createTestLogger(),
      });
      loader.loadAll();

      const commands = loader.listCommands();
      const helloCmd = commands.find((c) => c.id === "testplug:hello");

      expect(helloCmd).toBeDefined();
      expect(helloCmd?.description).toBe("A test slash command from testplug");
      expect(helloCmd?.body).toContain("Hello from the testplug plugin!");
    });

    it("command is resolvable by namespaced id", () => {
      const loader = new PluginLoader({
        pluginsDir: fixturesDir,
        logger: createTestLogger(),
      });
      loader.loadAll();

      const cmd = loader.getCommand("testplug:hello");

      expect(cmd).toBeDefined();
      expect(cmd?.argumentHint).toBe("[name]");
    });
  });

  describe("invalid-manifest-skipped", () => {
    it("skips plugins with invalid JSON but loads valid ones", () => {
      const loader = new PluginLoader({
        pluginsDir: fixturesDir,
        logger: createTestLogger(),
      });
      loader.loadAll();

      // testplug should be loaded.
      expect(loader.plugins.has("testplug")).toBe(true);

      // invalid-json and missing-manifest should not be loaded.
      expect(loader.plugins.has("invalid-json")).toBe(false);
      expect(loader.plugins.has("missing-manifest")).toBe(false);

      // Should have warnings.
      const warnings = loader.warnings;
      expect(warnings.length).toBeGreaterThan(0);
      expect(warnings.some((w) => w.includes("invalid-json") || w.includes("parse"))).toBe(true);
      expect(warnings.some((w) => w.includes("missing-manifest") || w.includes("not found"))).toBe(
        true,
      );

      // testplug's skill should still be reachable.
      const skill = loader.getSkill("testplug:foo");
      expect(skill).toBeDefined();
    });
  });

  describe("collision detection", () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "loader-collision-test-"));
    });

    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it("first plugin wins on id collision", () => {
      // Create two plugins with same id in different directories.
      const dir1 = path.join(tempDir, "dir1");
      const dir2 = path.join(tempDir, "dir2");

      fs.mkdirSync(path.join(dir1, "same-id"), { recursive: true });
      fs.mkdirSync(path.join(dir2, "same-id"), { recursive: true });

      fs.writeFileSync(
        path.join(dir1, "same-id", "plugin.json"),
        JSON.stringify({ id: "same-id", version: "1.0.0" }),
      );
      fs.writeFileSync(
        path.join(dir2, "same-id", "plugin.json"),
        JSON.stringify({ id: "same-id", version: "2.0.0" }),
      );

      const loader = new PluginLoader({
        pluginsDir: `${dir1},${dir2}`,
        logger: createTestLogger(),
      });
      loader.loadAll();

      // First one wins.
      const plugin = loader.plugins.get("same-id");
      expect(plugin?.plugin.manifest.version).toBe("1.0.0");

      // Collision warning should be logged.
      expect(loader.warnings.some((w) => w.includes("collision"))).toBe(true);
    });
  });

  describe("reloadAll", () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "loader-reload-test-"));
    });

    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it("returns diff of added/removed/unchanged", () => {
      // Create initial plugin.
      fs.mkdirSync(path.join(tempDir, "plugin-a"), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, "plugin-a", "plugin.json"),
        JSON.stringify({ id: "plugin-a", version: "1.0.0" }),
      );

      const loader = new PluginLoader({
        pluginsDir: tempDir,
        logger: createTestLogger(),
      });
      loader.loadAll();

      expect(loader.plugins.has("plugin-a")).toBe(true);

      // Add another plugin.
      fs.mkdirSync(path.join(tempDir, "plugin-b"), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, "plugin-b", "plugin.json"),
        JSON.stringify({ id: "plugin-b", version: "1.0.0" }),
      );

      const diff = loader.reloadAll();

      expect(diff.added).toContain("plugin-b");
      expect(diff.unchanged).toContain("plugin-a");
      expect(diff.removed).toEqual([]);
    });
  });

  describe("component loading", () => {
    it("loads all component types from testplug", () => {
      const loader = new PluginLoader({
        pluginsDir: fixturesDir,
        logger: createTestLogger(),
      });
      loader.loadAll();

      const plugin = loader.plugins.get("testplug");

      expect(plugin).toBeDefined();
      expect(plugin?.skills.length).toBe(1);
      expect(plugin?.agents.length).toBe(1);
      expect(plugin?.commands.length).toBe(1);
      expect(plugin?.hooks.length).toBe(1);
    });
  });
});
