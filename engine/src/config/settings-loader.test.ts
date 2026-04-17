/**
 * Tests for settings-loader.ts (T2-05).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HookRegistry, type RunSingleHookFn, runHooksWith } from "../hooks/registry.js";
import type { HookEvent, HookOutcome, PreToolUsePayload } from "../hooks/types.js";
import { decide } from "../permissions/engine.js";
import { loadClaudeSettings } from "./settings-loader.js";

describe("loadClaudeSettings", () => {
  let tmpHome: string;
  let tmpCwd: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "settings-home-"));
    tmpCwd = mkdtempSync(join(tmpdir(), "settings-cwd-"));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(tmpCwd, { recursive: true, force: true });
  });

  function writeUserSettings(content: object): void {
    const dir = join(tmpHome, ".claude");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "settings.json"), JSON.stringify(content));
  }

  function writeProjectSettings(content: object): void {
    const dir = join(tmpCwd, ".claude");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "settings.json"), JSON.stringify(content));
  }

  function writeLocalSettings(content: object): void {
    const dir = join(tmpCwd, ".claude");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "settings.local.json"), JSON.stringify(content));
  }

  it("returns empty results when no settings files exist", () => {
    const result = loadClaudeSettings({ home: tmpHome, cwd: tmpCwd });
    expect(result.hookConfigs).toEqual([]);
    expect(result.permissions.rules).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("collects warnings for invalid JSON", () => {
    const dir = join(tmpHome, ".claude");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "settings.json"), "{ invalid json }");

    const result = loadClaudeSettings({ home: tmpHome, cwd: tmpCwd });
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain("JSON parse error");
  });

  // ---------------------------------------------------------------------------
  // Test 1: pre-tool-hook-loaded
  // ---------------------------------------------------------------------------

  describe("pre-tool-hook-loaded", () => {
    it("loads PreToolUse hooks from settings.json and they fire via HookRegistry", async () => {
      writeUserSettings({
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              command: "echo",
              args: ["from-hook"],
              timeout: 5000,
            },
          ],
        },
      });

      const result = loadClaudeSettings({ home: tmpHome, cwd: tmpCwd });
      expect(result.hookConfigs).toHaveLength(1);
      expect(result.hookConfigs[0]?.event).toBe("PreToolUse");
      expect(result.hookConfigs[0]?.command).toBe("echo");

      // Build registry from loaded configs.
      const registry = new HookRegistry(result.hookConfigs);
      expect(registry.all).toHaveLength(1);

      // Build a PreToolUse event.
      const event: HookEvent & { kind: "PreToolUse" } = {
        kind: "PreToolUse",
        payload: {
          sessionId: "test-session",
          toolName: "Bash",
          toolInput: { command: "ls -la" },
          callId: "call-123",
        } satisfies PreToolUsePayload,
      };

      // Get matching hooks.
      const matching = registry.hooksFor(event);
      expect(matching).toHaveLength(1);

      // Create a mock runner that records calls.
      const calls: Array<{ hookName: string; event: HookEvent }> = [];
      // biome-ignore lint/suspicious/useAwait: async required by RunSingleHookFn interface
      const mockRunner: RunSingleHookFn = async (hook, ev, _sessionId, _opts) => {
        calls.push({ hookName: hook.name, event: ev });
        return {
          hookName: hook.name,
          event: ev.kind,
          decision: "neutral",
          durationMs: 0,
          exitCode: 0,
          timedOut: false,
        } as HookOutcome<"PreToolUse">;
      };

      // Run hooks.
      const runResult = await runHooksWith(mockRunner, {
        event,
        sessionId: "test-session",
        hooks: matching,
      });

      expect(calls).toHaveLength(1);
      expect(calls[0]?.hookName).toBe("echo#0");
      expect(runResult.decision).toBe("neutral");
    });
  });

  // ---------------------------------------------------------------------------
  // Test 2: deny-rule-blocks
  // ---------------------------------------------------------------------------

  describe("deny-rule-blocks", () => {
    it("deny rule from settings.json causes tool call to be denied", async () => {
      writeUserSettings({
        permissions: {
          deny: ["Bash(rm -rf *)"],
        },
      });

      const result = loadClaudeSettings({ home: tmpHome, cwd: tmpCwd });
      expect(result.permissions.rules.length).toBeGreaterThan(0);

      // Use the permission engine's decide() function.
      const decision = await decide({
        call: { name: "Bash", input: { command: "rm -rf /tmp/foo" } },
        permissions: result.permissions,
        sessionId: "test-session",
      });

      expect(decision).toBe("deny");
    });

    it("non-matching deny rule does not block", async () => {
      writeUserSettings({
        permissions: {
          deny: ["Bash(rm -rf *)"],
        },
      });

      const result = loadClaudeSettings({ home: tmpHome, cwd: tmpCwd });

      const decision = await decide({
        call: { name: "Bash", input: { command: "ls -la" } },
        permissions: result.permissions,
        sessionId: "test-session",
        // Provide an askHandler that allows, since mode:default asks for
        // non-read-only tools when no rule matches.
        askHandler: async () => "allow",
      });

      // Default mode allows read-only tools, ask for others.
      // Bash is not read-only, so it will ask in default mode.
      // Since our askHandler allows, we should NOT get deny.
      expect(decision).not.toBe("deny");
    });
  });

  // ---------------------------------------------------------------------------
  // Test 3: layering-priority
  // ---------------------------------------------------------------------------

  describe("layering-priority", () => {
    it("project settings override user settings", () => {
      writeUserSettings({
        permissions: {
          defaultMode: "acceptEdits",
        },
      });

      writeProjectSettings({
        permissions: {
          defaultMode: "default",
        },
      });

      const result = loadClaudeSettings({ home: tmpHome, cwd: tmpCwd });
      expect(result.permissions.mode).toBe("default");
    });

    it("local settings override both user and project", () => {
      writeUserSettings({
        permissions: {
          defaultMode: "acceptEdits",
        },
      });

      writeProjectSettings({
        permissions: {
          defaultMode: "default",
        },
      });

      writeLocalSettings({
        permissions: {
          defaultMode: "plan",
        },
      });

      const result = loadClaudeSettings({ home: tmpHome, cwd: tmpCwd });
      expect(result.permissions.mode).toBe("plan");
    });

    it("deny-wins: deny rules from any layer cause denial", async () => {
      // User allows Bash.
      writeUserSettings({
        permissions: {
          allow: ["Bash"],
        },
      });

      // Project denies Bash.
      writeProjectSettings({
        permissions: {
          deny: ["Bash"],
        },
      });

      const result = loadClaudeSettings({ home: tmpHome, cwd: tmpCwd });

      // Both rules should be present.
      const allowRules = result.permissions.rules.filter((r) => r.ruleClass === "allow");
      const denyRules = result.permissions.rules.filter((r) => r.ruleClass === "deny");
      expect(allowRules.length).toBeGreaterThan(0);
      expect(denyRules.length).toBeGreaterThan(0);

      // Deny should win.
      const decision = await decide({
        call: { name: "Bash", input: { command: "ls" } },
        permissions: result.permissions,
        sessionId: "test-session",
      });

      expect(decision).toBe("deny");
    });

    it("local ask rule does not override deny from project", async () => {
      // User allows Bash.
      writeUserSettings({
        permissions: {
          allow: ["Bash"],
        },
      });

      // Project denies Bash.
      writeProjectSettings({
        permissions: {
          deny: ["Bash"],
        },
      });

      // Local adds ask rule.
      writeLocalSettings({
        permissions: {
          ask: ["Bash"],
        },
      });

      const result = loadClaudeSettings({ home: tmpHome, cwd: tmpCwd });

      // All three rule types should be present.
      const allowRules = result.permissions.rules.filter((r) => r.ruleClass === "allow");
      const denyRules = result.permissions.rules.filter((r) => r.ruleClass === "deny");
      const askRules = result.permissions.rules.filter((r) => r.ruleClass === "ask");
      expect(allowRules.length).toBeGreaterThan(0);
      expect(denyRules.length).toBeGreaterThan(0);
      expect(askRules.length).toBeGreaterThan(0);

      // Deny should still win.
      const decision = await decide({
        call: { name: "Bash", input: { command: "ls" } },
        permissions: result.permissions,
        sessionId: "test-session",
      });

      expect(decision).toBe("deny");
    });

    it("hooks concatenate across layers", () => {
      writeUserSettings({
        hooks: {
          PreToolUse: [{ command: "user-hook" }],
        },
      });

      writeProjectSettings({
        hooks: {
          PreToolUse: [{ command: "project-hook" }],
        },
      });

      writeLocalSettings({
        hooks: {
          PreToolUse: [{ command: "local-hook" }],
        },
      });

      const result = loadClaudeSettings({ home: tmpHome, cwd: tmpCwd });
      expect(result.hookConfigs).toHaveLength(3);
      expect(result.hookConfigs.map((h) => h.command)).toEqual([
        "user-hook",
        "project-hook",
        "local-hook",
      ]);
    });
  });

  // ---------------------------------------------------------------------------
  // Additional tests
  // ---------------------------------------------------------------------------

  it("overrideMode takes precedence over settings", () => {
    writeUserSettings({
      permissions: {
        defaultMode: "acceptEdits",
      },
    });

    const result = loadClaudeSettings({
      home: tmpHome,
      cwd: tmpCwd,
      overrideMode: "plan",
    });

    expect(result.permissions.mode).toBe("plan");
  });

  it("loads multiple hook event types", () => {
    writeUserSettings({
      hooks: {
        PreToolUse: [{ command: "pre-hook" }],
        PostToolUse: [{ command: "post-hook" }],
        Stop: [{ command: "stop-hook" }],
      },
    });

    const result = loadClaudeSettings({ home: tmpHome, cwd: tmpCwd });
    expect(result.hookConfigs).toHaveLength(3);

    const events = result.hookConfigs.map((h) => h.event);
    expect(events).toContain("PreToolUse");
    expect(events).toContain("PostToolUse");
    expect(events).toContain("Stop");
  });

  it("passes through hook config options", () => {
    writeUserSettings({
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash(*)",
            command: "/usr/bin/my-hook",
            args: ["--verbose"],
            timeout: 10000,
            blocking: true,
            name: "my-bash-hook",
            env: { FOO: "bar" },
          },
        ],
      },
    });

    const result = loadClaudeSettings({ home: tmpHome, cwd: tmpCwd });
    expect(result.hookConfigs).toHaveLength(1);

    const hook = result.hookConfigs[0];
    expect(hook?.matcher).toBe("Bash(*)");
    expect(hook?.command).toBe("/usr/bin/my-hook");
    expect(hook?.args).toEqual(["--verbose"]);
    expect(hook?.timeout).toBe(10000);
    expect(hook?.blocking).toBe(true);
    expect(hook?.name).toBe("my-bash-hook");
    expect(hook?.env).toEqual({ FOO: "bar" });
  });
});
