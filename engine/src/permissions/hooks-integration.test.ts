/**
 * Permissions ↔ hooks composition tests (Phase 08.02).
 *
 * These tests exercise {@link decideWithHooks} with a fake
 * `preToolHook` runner. They do NOT spawn real child processes — that's
 * the job of `hooks/permissions-hooks-integration.test.ts`, which wires
 * the real registry + runner end-to-end. Here we verify only the
 * composition rules between a hook's terminal decision and the
 * permission pipeline.
 */

import { describe, expect, it, vi } from "vitest";
import type { HookRunResult } from "../hooks/types.js";
import { decideWithHooks } from "./engine.js";
import { compilePermissions } from "./rules.js";
import type { CompiledPermissions, PermissionAuditEntry, ToolCall } from "./types.js";

interface Harness {
  readonly entries: PermissionAuditEntry[];
  readonly sink: (entry: PermissionAuditEntry) => void;
}

function makeHarness(): Harness {
  const entries: PermissionAuditEntry[] = [];
  return { entries, sink: (entry) => entries.push(entry) };
}

function call(name: string, input: Record<string, unknown> = {}): ToolCall {
  return { name, input };
}

function perms(opts: Partial<Parameters<typeof compilePermissions>[0]>): CompiledPermissions {
  return compilePermissions({
    mode: opts.mode ?? "default",
    ...(opts.allow ? { allow: opts.allow } : {}),
    ...(opts.deny ? { deny: opts.deny } : {}),
    ...(opts.ask ? { ask: opts.ask } : {}),
    ...(opts.mcpTools ? { mcpTools: opts.mcpTools } : {}),
  });
}

function hookResult(
  decision: "allow" | "deny" | "modify" | "neutral",
  extras: Partial<HookRunResult<"PreToolUse">> = {},
): HookRunResult<"PreToolUse"> {
  return {
    event: "PreToolUse",
    outcomes: [],
    decision,
    ...extras,
  };
}

describe("decideWithHooks — hook deny is authoritative", () => {
  it("denies in bypassPermissions mode when hook denies", async () => {
    const h = makeHarness();
    const d = await decideWithHooks({
      call: call("Bash", { command: "rm -rf /" }),
      permissions: perms({ mode: "bypassPermissions" }),
      sessionId: "s1",
      audit: h.sink,
      preToolHook: async () =>
        hookResult("deny", { reason: "explicit block", denyingHookName: "guard" }),
    });
    expect(d).toBe("deny");
    expect(h.entries).toHaveLength(1);
    expect(h.entries[0]?.decision).toBe("deny");
    expect(h.entries[0]?.reason).toContain("hook:guard");
  });

  it("denies even when a rule would allow", async () => {
    const h = makeHarness();
    const d = await decideWithHooks({
      call: call("Bash", { command: "echo hi" }),
      permissions: perms({ mode: "default", allow: ["Bash"] }),
      sessionId: "s1",
      audit: h.sink,
      preToolHook: async () => hookResult("deny", { denyingHookName: "g", reason: "nope" }),
    });
    expect(d).toBe("deny");
  });
});

describe("decideWithHooks — hook modify replaces the call", () => {
  it("rule evaluation sees the modified toolInput", async () => {
    const h = makeHarness();
    const observed: string[] = [];
    const d = await decideWithHooks({
      call: call("Bash", { command: "rm -rf /" }),
      permissions: perms({
        mode: "default",
        allow: ["Bash(echo *)"],
        deny: ["Bash(rm *)"],
      }),
      sessionId: "s1",
      audit: h.sink,
      askHandler: async (c) => {
        await Promise.resolve();
        observed.push(String(c.input.command));
        return "allow";
      },
      preToolHook: async () =>
        hookResult("modify", {
          modified: {
            sessionId: "s1",
            toolName: "Bash",
            toolInput: { command: "echo safe" },
            callId: "c1",
          },
        }),
    });
    expect(d).toBe("allow");
    // The deny rule for `rm *` should NOT fire because input was rewritten.
    expect(h.entries.at(-1)?.decision).toBe("allow");
    expect(h.entries.at(-1)?.input).toEqual({ command: "echo safe" });
  });
});

describe("decideWithHooks — hook neutral is identical to no hook", () => {
  it("behaves exactly like decide() when hook is neutral", async () => {
    const h = makeHarness();
    const d = await decideWithHooks({
      call: call("Read", { file_path: "a" }),
      permissions: perms({ mode: "default" }),
      sessionId: "s1",
      audit: h.sink,
      preToolHook: async () => hookResult("neutral"),
    });
    expect(d).toBe("allow");
    expect(h.entries[0]?.reason).toBe("mode-default:readonly");
  });

  it("with no hook provided, delegates to decide() normally", async () => {
    const h = makeHarness();
    const d = await decideWithHooks({
      call: call("Bash", { command: "ls" }),
      permissions: perms({ mode: "default", deny: ["Bash"] }),
      sessionId: "s1",
      audit: h.sink,
    });
    expect(d).toBe("deny");
  });
});

describe("decideWithHooks — hook allow is advisory", () => {
  it("does not override a matching deny rule", async () => {
    const h = makeHarness();
    const d = await decideWithHooks({
      call: call("Bash", { command: "rm -rf x" }),
      permissions: perms({ mode: "default", allow: ["Bash"], deny: ["Bash(rm *)"] }),
      sessionId: "s1",
      audit: h.sink,
      preToolHook: async () => hookResult("allow"),
    });
    expect(d).toBe("deny");
  });

  it("still produces the allow from rule evaluation when no deny matches", async () => {
    const h = makeHarness();
    const d = await decideWithHooks({
      call: call("Read", { file_path: "x" }),
      permissions: perms({ mode: "default" }),
      sessionId: "s1",
      audit: h.sink,
      preToolHook: async () => hookResult("allow"),
    });
    expect(d).toBe("allow");
  });
});

describe("decideWithHooks — plan-mode refusal", () => {
  it("denies a side-effectful tool WITHOUT invoking the hook", async () => {
    const h = makeHarness();
    const spy = vi.fn(async (): Promise<HookRunResult<"PreToolUse">> => hookResult("allow"));
    const d = await decideWithHooks({
      call: call("Bash", { command: "ls" }),
      permissions: perms({ mode: "plan" }),
      sessionId: "s1",
      audit: h.sink,
      preToolHook: spy,
    });
    expect(d).toBe("deny");
    expect(spy).not.toHaveBeenCalled();
  });

  it("still invokes the hook for a side-effect-free tool in plan mode", async () => {
    const h = makeHarness();
    const spy = vi.fn(async (): Promise<HookRunResult<"PreToolUse">> => hookResult("neutral"));
    const d = await decideWithHooks({
      call: call("Read", { file_path: "a" }),
      permissions: perms({ mode: "plan" }),
      sessionId: "s1",
      audit: h.sink,
      preToolHook: spy,
    });
    expect(d).toBe("allow");
    expect(spy).toHaveBeenCalledOnce();
  });
});

describe("decideWithHooks — bypass belt-and-suspenders", () => {
  it("allows when hook is neutral and mode=bypassPermissions", async () => {
    const h = makeHarness();
    const d = await decideWithHooks({
      call: call("Bash", { command: "anything" }),
      permissions: perms({ mode: "bypassPermissions" }),
      sessionId: "s1",
      audit: h.sink,
      preToolHook: async () => hookResult("neutral"),
    });
    expect(d).toBe("allow");
    expect(h.entries[0]?.reason).toBe("mode:bypassPermissions");
  });
});
