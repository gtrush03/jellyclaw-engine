/**
 * Permission-engine matrix tests (Phase 08).
 *
 * We exercise every stage of the decision pipeline and the deny-wins
 * invariant explicitly. The tests inject an in-memory audit sink so the
 * default `~/.jellyclaw/logs/permissions.jsonl` file is never touched.
 */

import { describe, expect, it } from "vitest";
import { decide, defaultIsSideEffectFree, redactInputForAudit } from "./engine.js";
import { compilePermissions } from "./rules.js";
import type { AskHandler, CompiledPermissions, PermissionAuditEntry, ToolCall } from "./types.js";

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

const allowAll: AskHandler = async () => "allow";
const denyAll: AskHandler = async () => "deny";
const throwingAsk: AskHandler = async () => {
  await Promise.resolve();
  throw new Error("simulated handler failure");
};

function perms(opts: Partial<Parameters<typeof compilePermissions>[0]>): CompiledPermissions {
  return compilePermissions({
    mode: opts.mode ?? "default",
    ...(opts.allow ? { allow: opts.allow } : {}),
    ...(opts.deny ? { deny: opts.deny } : {}),
    ...(opts.ask ? { ask: opts.ask } : {}),
    ...(opts.mcpTools ? { mcpTools: opts.mcpTools } : {}),
  });
}

describe("decide — bypassPermissions", () => {
  it("allows everything, including Bash(rm -rf /)", async () => {
    const h = makeHarness();
    const d = await decide({
      call: call("Bash", { command: "rm -rf /" }),
      permissions: perms({ mode: "bypassPermissions" }),
      sessionId: "s1",
      audit: h.sink,
    });
    expect(d).toBe("allow");
    expect(h.entries).toHaveLength(1);
    expect(h.entries[0]?.decision).toBe("allow");
    expect(h.entries[0]?.reason).toBe("mode:bypassPermissions");
  });
});

describe("decide — plan mode", () => {
  it("denies Bash", async () => {
    const h = makeHarness();
    const d = await decide({
      call: call("Bash", { command: "ls" }),
      permissions: perms({ mode: "plan" }),
      sessionId: "s1",
      audit: h.sink,
    });
    expect(d).toBe("deny");
    expect(h.entries[0]?.reason).toMatch(/plan/);
  });

  it("denies Write", async () => {
    const h = makeHarness();
    const d = await decide({
      call: call("Write", { file_path: "src/a" }),
      permissions: perms({ mode: "plan" }),
      sessionId: "s1",
      audit: h.sink,
    });
    expect(d).toBe("deny");
  });

  it("denies WebFetch", async () => {
    const h = makeHarness();
    const d = await decide({
      call: call("WebFetch", { url: "https://example.com" }),
      permissions: perms({ mode: "plan" }),
      sessionId: "s1",
      audit: h.sink,
    });
    expect(d).toBe("deny");
  });

  it("denies an MCP tool not flagged readonly", async () => {
    const h = makeHarness();
    const d = await decide({
      call: call("mcp__github__create_issue", { title: "x" }),
      permissions: perms({ mode: "plan" }),
      sessionId: "s1",
      audit: h.sink,
    });
    expect(d).toBe("deny");
  });

  it("allows Read, Grep, Glob", async () => {
    for (const name of ["Read", "Grep", "Glob"]) {
      const h = makeHarness();
      const d = await decide({
        call: call(name, {}),
        permissions: perms({ mode: "plan" }),
        sessionId: "s1",
        audit: h.sink,
      });
      expect(d).toBe("allow");
    }
  });

  it("allows an MCP tool explicitly flagged readonly", async () => {
    const h = makeHarness();
    const d = await decide({
      call: call("mcp__github__get_issue", { number: 1 }),
      permissions: perms({
        mode: "plan",
        mcpTools: { mcp__github__get_issue: "readonly" },
      }),
      sessionId: "s1",
      audit: h.sink,
    });
    expect(d).toBe("allow");
  });
});

describe("decide — default mode", () => {
  it("allows Read without asking", async () => {
    const h = makeHarness();
    let asked = false;
    const d = await decide({
      call: call("Read", { file_path: "a" }),
      permissions: perms({ mode: "default" }),
      sessionId: "s1",
      audit: h.sink,
      askHandler: async () => {
        await Promise.resolve();
        asked = true;
        return "allow";
      },
    });
    expect(d).toBe("allow");
    expect(asked).toBe(false);
  });

  it("asks on Bash with no rule", async () => {
    const h = makeHarness();
    let asked = false;
    const d = await decide({
      call: call("Bash", { command: "echo hi" }),
      permissions: perms({ mode: "default" }),
      sessionId: "s1",
      audit: h.sink,
      askHandler: async () => {
        await Promise.resolve();
        asked = true;
        return "allow";
      },
    });
    expect(d).toBe("allow");
    expect(asked).toBe(true);
  });

  it("asks on Bash with no rule, denies when handler denies", async () => {
    const h = makeHarness();
    const d = await decide({
      call: call("Bash", { command: "echo hi" }),
      permissions: perms({ mode: "default" }),
      sessionId: "s1",
      audit: h.sink,
      askHandler: denyAll,
    });
    expect(d).toBe("deny");
  });

  it("deny rule beats allow rule for the same tool (deny-wins invariant)", async () => {
    const h = makeHarness();
    // `Bash(rm *)` uses picomatch defaults, so `*` does NOT cross path
    // separators — `rm foo` matches, `rm -rf /` does not. See rules.test.ts.
    const p = perms({
      mode: "default",
      allow: ["Bash"],
      deny: ["Bash(rm *)"],
    });
    const d1 = await decide({
      call: call("Bash", { command: "rm foo" }),
      permissions: p,
      sessionId: "s1",
      audit: h.sink,
    });
    expect(d1).toBe("deny");

    const d2 = await decide({
      call: call("Bash", { command: "git status" }),
      permissions: p,
      sessionId: "s1",
      audit: h.sink,
    });
    expect(d2).toBe("allow");
  });
});

describe("decide — acceptEdits mode", () => {
  it("allows Write without asking", async () => {
    const h = makeHarness();
    let asked = false;
    const d = await decide({
      call: call("Write", { file_path: "src/foo" }),
      permissions: perms({ mode: "acceptEdits" }),
      sessionId: "s1",
      audit: h.sink,
      askHandler: async () => {
        await Promise.resolve();
        asked = true;
        return "deny";
      },
    });
    expect(d).toBe("allow");
    expect(asked).toBe(false);
  });

  it("allows Edit and MultiEdit without asking", async () => {
    for (const name of ["Edit", "MultiEdit"]) {
      const h = makeHarness();
      const d = await decide({
        call: call(name, { file_path: "src/foo" }),
        permissions: perms({ mode: "acceptEdits" }),
        sessionId: "s1",
        audit: h.sink,
      });
      expect(d).toBe("allow");
    }
  });

  it("still asks for Bash", async () => {
    const h = makeHarness();
    let asked = false;
    const d = await decide({
      call: call("Bash", { command: "git status" }),
      permissions: perms({ mode: "acceptEdits" }),
      sessionId: "s1",
      audit: h.sink,
      askHandler: async () => {
        await Promise.resolve();
        asked = true;
        return "deny";
      },
    });
    expect(d).toBe("deny");
    expect(asked).toBe(true);
  });
});

describe("decide — ask-handler injection", () => {
  it("returns allow when handler returns allow", async () => {
    const h = makeHarness();
    const d = await decide({
      call: call("Bash", { command: "ls" }),
      permissions: perms({ mode: "default" }),
      sessionId: "s1",
      audit: h.sink,
      askHandler: allowAll,
    });
    expect(d).toBe("allow");
  });

  it("denies when no handler is provided", async () => {
    const h = makeHarness();
    const d = await decide({
      call: call("Bash", { command: "ls" }),
      permissions: perms({ mode: "default" }),
      sessionId: "s1",
      audit: h.sink,
    });
    expect(d).toBe("deny");
  });

  it("denies when handler throws", async () => {
    const h = makeHarness();
    const d = await decide({
      call: call("Bash", { command: "ls" }),
      permissions: perms({ mode: "default" }),
      sessionId: "s1",
      audit: h.sink,
      askHandler: throwingAsk,
    });
    expect(d).toBe("deny");
  });

  it("runs ask rule through the handler", async () => {
    const h = makeHarness();
    const d = await decide({
      call: call("Write", { file_path: "src/a.ts" }),
      permissions: perms({ mode: "default", ask: ["Write(src/**)"] }),
      sessionId: "s1",
      audit: h.sink,
      askHandler: allowAll,
    });
    expect(d).toBe("allow");
    expect(h.entries[0]?.ruleMatched).toBe("Write(src/**)");
    expect(h.entries[0]?.reason).toMatch(/asked/);
  });

  it("ask rule denies when handler denies", async () => {
    const h = makeHarness();
    const d = await decide({
      call: call("Write", { file_path: "src/a.ts" }),
      permissions: perms({ mode: "default", ask: ["Write(src/**)"] }),
      sessionId: "s1",
      audit: h.sink,
      askHandler: denyAll,
    });
    expect(d).toBe("deny");
  });
});

describe("decide — audit log", () => {
  it("redacts secret values from input in audit entries", async () => {
    const h = makeHarness();
    await decide({
      call: call("Bash", { command: "echo SECRET123" }),
      permissions: perms({ mode: "bypassPermissions" }),
      sessionId: "s1",
      audit: h.sink,
      secrets: ["SECRET123"],
    });
    expect(h.entries).toHaveLength(1);
    expect(h.entries[0]?.input).toEqual({ command: "echo [REDACTED]" });
  });

  it("passes through input unchanged when no secrets configured", async () => {
    const h = makeHarness();
    await decide({
      call: call("Bash", { command: "echo hi" }),
      permissions: perms({ mode: "bypassPermissions" }),
      sessionId: "s1",
      audit: h.sink,
    });
    expect(h.entries[0]?.input).toEqual({ command: "echo hi" });
  });

  it("injection is honoured — real home dir is never written in tests", async () => {
    const h = makeHarness();
    await decide({
      call: call("Read", { file_path: "a" }),
      permissions: perms({ mode: "default" }),
      sessionId: "s1",
      audit: h.sink,
    });
    // If the injection were ignored, nothing would appear in `h.entries`.
    expect(h.entries.length).toBeGreaterThan(0);
  });
});

describe("defaultIsSideEffectFree", () => {
  it("classifies READ_ONLY_TOOLS as side-effect-free", () => {
    const p = perms({ mode: "plan" });
    expect(defaultIsSideEffectFree(call("Read"), p)).toBe(true);
    expect(defaultIsSideEffectFree(call("Grep"), p)).toBe(true);
  });

  it("classifies Bash/Write as side-effectful", () => {
    const p = perms({ mode: "plan" });
    expect(defaultIsSideEffectFree(call("Bash"), p)).toBe(false);
    expect(defaultIsSideEffectFree(call("Write"), p)).toBe(false);
  });

  it("honours mcpTools readonly hint", () => {
    const p = perms({
      mode: "plan",
      mcpTools: { mcp__github__get_issue: "readonly" },
    });
    expect(defaultIsSideEffectFree(call("mcp__github__get_issue"), p)).toBe(true);
    expect(defaultIsSideEffectFree(call("mcp__github__create_issue"), p)).toBe(false);
  });
});

describe("redactInputForAudit", () => {
  it("returns a shallow clone when no secrets", () => {
    const src = { a: "x", b: 1 };
    const out = redactInputForAudit(src, undefined);
    expect(out).toEqual(src);
    expect(out).not.toBe(src);
  });

  it("skips secrets shorter than 6 chars", () => {
    const out = redactInputForAudit({ x: "echo abc" }, ["abc"]);
    expect(out).toEqual({ x: "echo abc" });
  });

  it("replaces longest secret first", () => {
    const out = redactInputForAudit({ x: "SECRETVALUE123" }, ["SECRET", "SECRETVALUE123"]);
    expect(out).toEqual({ x: "[REDACTED]" });
  });
});
