/**
 * Tests for permission-mode-resolver.ts (T2-06).
 */

import { describe, expect, it } from "vitest";
import { decide } from "../permissions/engine.js";
import { compilePermissions } from "../permissions/rules.js";
import { InvalidPermissionModeError, resolvePermissionMode } from "./permission-mode-resolver.js";

describe("resolvePermissionMode", () => {
  // ---------------------------------------------------------------------------
  // Test 1: default-mode
  // ---------------------------------------------------------------------------

  describe("default-mode", () => {
    it("returns 'default' when no flag, no settings, no env", () => {
      const mode = resolvePermissionMode({});
      expect(mode).toBe("default");
    });

    it("returns 'default' with empty env", () => {
      const mode = resolvePermissionMode({ env: {} });
      expect(mode).toBe("default");
    });

    it("default mode with no rules returns 'deny' for non-read-only tool (no askHandler)", async () => {
      // In default mode, tools not in READ_ONLY_TOOLS trigger an ask.
      // Without an askHandler, the decision resolves to "deny" per the
      // default-deny invariant (engine.ts:12).
      const mode = resolvePermissionMode({});
      expect(mode).toBe("default");

      const permissions = compilePermissions({ mode });

      const decision = await decide({
        call: { name: "Bash", input: { command: "ls" } },
        permissions,
        sessionId: "test-session",
        // No askHandler → invokeAsk returns "deny"
      });

      // Default mode without askHandler denies (safe default).
      expect(decision).toBe("deny");
    });

    it("default mode allows read-only tools without asking", async () => {
      const mode = resolvePermissionMode({});
      const permissions = compilePermissions({ mode });

      const decision = await decide({
        call: { name: "Read", input: { file_path: "/tmp/test.txt" } },
        permissions,
        sessionId: "test-session",
      });

      expect(decision).toBe("allow");
    });
  });

  // ---------------------------------------------------------------------------
  // Test 2: bypass-via-flag
  // ---------------------------------------------------------------------------

  describe("bypass-via-flag", () => {
    it("flag 'bypassPermissions' wins over settings and env", () => {
      const mode = resolvePermissionMode({
        flag: "bypassPermissions",
        settings: "plan",
        env: { JELLYCLAW_PERMISSION_MODE: "default" },
      });
      expect(mode).toBe("bypassPermissions");
    });

    it("bypassPermissions mode allows all tools without asking", async () => {
      const mode = resolvePermissionMode({ flag: "bypassPermissions" });
      const permissions = compilePermissions({ mode });

      // Bash (side-effectful) should be allowed without asking.
      const bashDecision = await decide({
        call: { name: "Bash", input: { command: "rm -rf /tmp/foo" } },
        permissions,
        sessionId: "test-session",
      });
      expect(bashDecision).toBe("allow");

      // Write (edit tool) should also be allowed.
      const writeDecision = await decide({
        call: { name: "Write", input: { file_path: "/tmp/test.txt", content: "hello" } },
        permissions,
        sessionId: "test-session",
      });
      expect(writeDecision).toBe("allow");
    });

    it("settings win over env when no flag", () => {
      const mode = resolvePermissionMode({
        settings: "acceptEdits",
        env: { JELLYCLAW_PERMISSION_MODE: "plan" },
      });
      expect(mode).toBe("acceptEdits");
    });

    it("env wins over default when no flag or settings", () => {
      const mode = resolvePermissionMode({
        env: { JELLYCLAW_PERMISSION_MODE: "plan" },
      });
      expect(mode).toBe("plan");
    });
  });

  // ---------------------------------------------------------------------------
  // Test 3: plan-mode-blocks
  // ---------------------------------------------------------------------------

  describe("plan-mode-blocks", () => {
    it("flag 'plan' sets plan mode", () => {
      const mode = resolvePermissionMode({ flag: "plan" });
      expect(mode).toBe("plan");
    });

    it("plan mode denies Write tool regardless of allow rules", async () => {
      const mode = resolvePermissionMode({ flag: "plan" });
      const permissions = compilePermissions({
        mode,
        allow: ["Write"], // Allow rule should NOT override plan-mode invariant
      });

      const decision = await decide({
        call: { name: "Write", input: { file_path: "/tmp/test.txt", content: "hello" } },
        permissions,
        sessionId: "test-session",
      });

      expect(decision).toBe("deny");
    });

    it("plan mode denies Edit tool regardless of allow rules", async () => {
      const mode = resolvePermissionMode({ flag: "plan" });
      const permissions = compilePermissions({
        mode,
        allow: ["Edit"],
      });

      const decision = await decide({
        call: {
          name: "Edit",
          input: { file_path: "/tmp/test.txt", old_string: "a", new_string: "b" },
        },
        permissions,
        sessionId: "test-session",
      });

      expect(decision).toBe("deny");
    });

    it("plan mode denies Bash tool (side-effectful)", async () => {
      const mode = resolvePermissionMode({ flag: "plan" });
      const permissions = compilePermissions({ mode });

      const decision = await decide({
        call: { name: "Bash", input: { command: "ls" } },
        permissions,
        sessionId: "test-session",
      });

      expect(decision).toBe("deny");
    });

    it("plan mode allows Read tool (side-effect-free)", async () => {
      const mode = resolvePermissionMode({ flag: "plan" });
      const permissions = compilePermissions({ mode });

      const decision = await decide({
        call: { name: "Read", input: { file_path: "/tmp/test.txt" } },
        permissions,
        sessionId: "test-session",
      });

      expect(decision).toBe("allow");
    });

    it("plan mode allows Glob tool (side-effect-free)", async () => {
      const mode = resolvePermissionMode({ flag: "plan" });
      const permissions = compilePermissions({ mode });

      const decision = await decide({
        call: { name: "Glob", input: { pattern: "**/*.ts" } },
        permissions,
        sessionId: "test-session",
      });

      expect(decision).toBe("allow");
    });
  });

  // ---------------------------------------------------------------------------
  // Invalid value handling
  // ---------------------------------------------------------------------------

  describe("InvalidPermissionModeError", () => {
    it("throws for invalid flag value", () => {
      expect(() => resolvePermissionMode({ flag: "invalid" })).toThrow(InvalidPermissionModeError);
      expect(() => resolvePermissionMode({ flag: "invalid" })).toThrow(
        /Invalid permission mode "invalid" from flag/,
      );
      expect(() => resolvePermissionMode({ flag: "invalid" })).toThrow(
        /Valid values: default, acceptEdits, bypassPermissions, plan/,
      );
    });

    it("throws for invalid settings value", () => {
      expect(() => resolvePermissionMode({ settings: "nope" })).toThrow(InvalidPermissionModeError);
      expect(() => resolvePermissionMode({ settings: "nope" })).toThrow(/from settings/);
    });

    it("throws for invalid env value", () => {
      expect(() => resolvePermissionMode({ env: { JELLYCLAW_PERMISSION_MODE: "bad" } })).toThrow(
        InvalidPermissionModeError,
      );
      expect(() => resolvePermissionMode({ env: { JELLYCLAW_PERMISSION_MODE: "bad" } })).toThrow(
        /from env/,
      );
    });

    it("error includes the invalid value and source", () => {
      try {
        resolvePermissionMode({ flag: "typo" });
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(InvalidPermissionModeError);
        const e = err as InvalidPermissionModeError;
        expect(e.invalidValue).toBe("typo");
        expect(e.source).toBe("flag");
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  describe("edge cases", () => {
    it("empty string flag falls through to next source", () => {
      const mode = resolvePermissionMode({
        flag: "",
        settings: "acceptEdits",
      });
      expect(mode).toBe("acceptEdits");
    });

    it("empty string settings falls through to env", () => {
      const mode = resolvePermissionMode({
        settings: "",
        env: { JELLYCLAW_PERMISSION_MODE: "plan" },
      });
      expect(mode).toBe("plan");
    });

    it("empty string env falls through to default", () => {
      const mode = resolvePermissionMode({
        env: { JELLYCLAW_PERMISSION_MODE: "" },
      });
      expect(mode).toBe("default");
    });

    it("accepts all valid mode values via flag", () => {
      expect(resolvePermissionMode({ flag: "default" })).toBe("default");
      expect(resolvePermissionMode({ flag: "acceptEdits" })).toBe("acceptEdits");
      expect(resolvePermissionMode({ flag: "bypassPermissions" })).toBe("bypassPermissions");
      expect(resolvePermissionMode({ flag: "plan" })).toBe("plan");
    });
  });
});
