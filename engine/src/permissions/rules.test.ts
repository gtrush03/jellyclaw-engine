import { describe, expect, it } from "vitest";
import {
  compilePermissions,
  DEFAULT_ALLOW_PATTERNS,
  firstMatch,
  matchRule,
  parseRule,
} from "./rules.js";
import type { PermissionRule, PermissionRuleWarning, ToolCall } from "./types.js";

function isRule(x: PermissionRule | PermissionRuleWarning): x is PermissionRule {
  return "match" in x;
}

function call(name: string, input: Record<string, unknown> = {}): ToolCall {
  return { name, input };
}

describe("parseRule — happy paths", () => {
  it("parses naked Bash", () => {
    const r = parseRule("Bash", "allow");
    expect(isRule(r)).toBe(true);
    if (!isRule(r)) return;
    expect(r.toolName).toBe("Bash");
    expect(r.pattern).toBeUndefined();
    expect(r.ruleClass).toBe("allow");
    expect(r.source).toBe("Bash");
  });

  it("parses Bash(git *)", () => {
    const r = parseRule("Bash(git *)", "allow");
    expect(isRule(r)).toBe(true);
    if (!isRule(r)) return;
    expect(r.toolName).toBe("Bash");
    expect(r.pattern).toBe("git *");
  });

  it("parses Write(src/**)", () => {
    const r = parseRule("Write(src/**)", "allow");
    expect(isRule(r)).toBe(true);
    if (!isRule(r)) return;
    expect(r.toolName).toBe("Write");
    expect(r.pattern).toBe("src/**");
  });

  it("parses Edit(**)", () => {
    const r = parseRule("Edit(**)", "allow");
    expect(isRule(r)).toBe(true);
  });

  it("parses mcp__github__* (wildcard suffix)", () => {
    const r = parseRule("mcp__github__*", "allow");
    expect(isRule(r)).toBe(true);
    if (!isRule(r)) return;
    expect(r.toolName).toBe("mcp__github__*");
  });

  it("parses mcp__github__create_issue (exact)", () => {
    const r = parseRule("mcp__github__create_issue", "allow");
    expect(isRule(r)).toBe(true);
  });

  it("parses mcp__linear-bot__list_issues (hyphen in server)", () => {
    const r = parseRule("mcp__linear-bot__list_issues", "allow");
    expect(isRule(r)).toBe(true);
  });
});

describe("parseRule — warnings", () => {
  it("warns on unmatched open paren: Bash(", () => {
    const r = parseRule("Bash(", "deny");
    expect(isRule(r)).toBe(false);
    if (isRule(r)) return;
    expect(r.reason).toMatch(/\)/);
  });

  it("warns on unmatched close paren: Bash)", () => {
    const r = parseRule("Bash)", "deny");
    expect(isRule(r)).toBe(false);
  });

  it("warns on empty pattern: Bash()", () => {
    const r = parseRule("Bash()", "deny");
    expect(isRule(r)).toBe(false);
    if (isRule(r)) return;
    expect(r.reason).toMatch(/empty pattern/i);
  });

  it("warns on uppercase MCP server: mcp__BadCaps__foo", () => {
    const r = parseRule("mcp__BadCaps__foo", "deny");
    expect(isRule(r)).toBe(false);
    if (isRule(r)) return;
    expect(r.reason).toMatch(/MCP/);
  });

  it("warns on malformed MCP name: mcp__bar_ (missing __ and tool)", () => {
    const r = parseRule("mcp__bar_", "deny");
    expect(isRule(r)).toBe(false);
  });

  it("warns on tool name starting with digit: 123-bad", () => {
    const r = parseRule("123-bad", "deny");
    expect(isRule(r)).toBe(false);
  });

  it("warns on empty source string", () => {
    const r = parseRule("", "deny");
    expect(isRule(r)).toBe(false);
  });

  it("warns on whitespace-only source", () => {
    const r = parseRule("   ", "deny");
    expect(isRule(r)).toBe(false);
  });
});

describe("match — Bash", () => {
  it("Bash(git *) matches git status", () => {
    const r = parseRule("Bash(git *)", "allow");
    expect(isRule(r)).toBe(true);
    if (!isRule(r)) return;
    expect(matchRule(r, call("Bash", { command: "git status" }))).toBe(true);
  });

  it("Bash(git *) does not match rm -rf /", () => {
    const r = parseRule("Bash(git *)", "allow");
    if (!isRule(r)) throw new Error("unreachable");
    expect(matchRule(r, call("Bash", { command: "rm -rf /" }))).toBe(false);
  });

  it("Bash(git *) does not match an empty input (no command field)", () => {
    const r = parseRule("Bash(git *)", "allow");
    if (!isRule(r)) throw new Error("unreachable");
    expect(matchRule(r, call("Bash", {}))).toBe(false);
  });

  it("naked Bash matches any Bash call", () => {
    const r = parseRule("Bash", "allow");
    if (!isRule(r)) throw new Error("unreachable");
    expect(matchRule(r, call("Bash", { command: "rm -rf /" }))).toBe(true);
    expect(matchRule(r, call("Bash", {}))).toBe(true);
  });

  it("naked Bash does not match Write calls", () => {
    const r = parseRule("Bash", "allow");
    if (!isRule(r)) throw new Error("unreachable");
    expect(matchRule(r, call("Write", { file_path: "foo" }))).toBe(false);
  });
});

describe("match — Write / path tools", () => {
  it("Write(src/**) matches src/foo.ts", () => {
    const r = parseRule("Write(src/**)", "allow");
    if (!isRule(r)) throw new Error("unreachable");
    expect(matchRule(r, call("Write", { file_path: "src/foo.ts" }))).toBe(true);
  });

  it("Write(src/**) matches ./src/foo.ts via path normalization", () => {
    const r = parseRule("Write(src/**)", "allow");
    if (!isRule(r)) throw new Error("unreachable");
    expect(matchRule(r, call("Write", { file_path: "./src/foo.ts" }))).toBe(true);
  });

  it("Write(src/**) does not match etc/x", () => {
    const r = parseRule("Write(src/**)", "allow");
    if (!isRule(r)) throw new Error("unreachable");
    expect(matchRule(r, call("Write", { file_path: "etc/x" }))).toBe(false);
  });

  it("Write(src/**) matches dotfiles under src via dot:true", () => {
    const r = parseRule("Write(src/**)", "allow");
    if (!isRule(r)) throw new Error("unreachable");
    expect(matchRule(r, call("Write", { file_path: "src/.hidden/x" }))).toBe(true);
  });

  it("Grep(**/*.ts) uses input.pattern when file_path absent", () => {
    const r = parseRule("Grep(**/*.ts)", "allow");
    if (!isRule(r)) throw new Error("unreachable");
    expect(matchRule(r, call("Grep", { pattern: "src/a.ts" }))).toBe(true);
  });
});

describe("match — MCP", () => {
  it("mcp__github__* matches mcp__github__create_issue", () => {
    const r = parseRule("mcp__github__*", "allow");
    if (!isRule(r)) throw new Error("unreachable");
    expect(matchRule(r, call("mcp__github__create_issue"))).toBe(true);
  });

  it("mcp__github__* does not match mcp__linear__anything", () => {
    const r = parseRule("mcp__github__*", "allow");
    if (!isRule(r)) throw new Error("unreachable");
    expect(matchRule(r, call("mcp__linear__anything"))).toBe(false);
  });

  it("mcp__github__* does not match mcp__github-bot__foo (server name exact)", () => {
    const r = parseRule("mcp__github__*", "allow");
    if (!isRule(r)) throw new Error("unreachable");
    expect(matchRule(r, call("mcp__github-bot__foo"))).toBe(false);
  });

  it("mcp__github__create_issue exact only matches that tool", () => {
    const r = parseRule("mcp__github__create_issue", "allow");
    if (!isRule(r)) throw new Error("unreachable");
    expect(matchRule(r, call("mcp__github__create_issue"))).toBe(true);
    expect(matchRule(r, call("mcp__github__delete_issue"))).toBe(false);
  });
});

describe("negation safety (nonegate)", () => {
  it("Bash(!rm*) does NOT invert — leading ! is literal", () => {
    // A deny rule with pattern `!rm*` must not silently match everything
    // that isn't `rm*`. picomatch { nonegate: true } guarantees this.
    const r = parseRule("Bash(!rm*)", "deny");
    if (!isRule(r)) throw new Error("unreachable");
    // `rm -rf /` starts with `rm`, not `!rm`, so does NOT match literal `!rm*`.
    expect(matchRule(r, call("Bash", { command: "rm -rf /" }))).toBe(false);
    // Anything else also does not match.
    expect(matchRule(r, call("Bash", { command: "ls" }))).toBe(false);
  });
});

describe("compilePermissions", () => {
  it("defaults mode to 'default' when omitted", () => {
    const c = compilePermissions({});
    expect(c.mode).toBe("default");
    // Now includes DEFAULT_ALLOW_PATTERNS for browser MCP tools (Phase 07.5)
    expect(c.rules.length).toBe(DEFAULT_ALLOW_PATTERNS.length);
    expect(c.rules.every((r) => r.ruleClass === "allow")).toBe(true);
    expect(c.warnings).toEqual([]);
    expect(c.mcpTools).toEqual({});
  });

  it("accepts an explicit mode", () => {
    const c = compilePermissions({ mode: "plan" });
    expect(c.mode).toBe("plan");
  });

  it("collects good rules and warnings together", () => {
    const c = compilePermissions({
      allow: ["Bash(git *)", "Bash("],
      deny: ["Write(**)", "mcp__BadCaps__x"],
    });
    // 1 user allow + 3 default allows + 1 deny = 5 rules
    // 1 user allow warning + 1 deny warning = 2 warnings
    const userRules = c.rules.filter((r) => !DEFAULT_ALLOW_PATTERNS.includes(r.source));
    expect(userRules.length).toBe(2); // Bash(git *) and Write(**)
    expect(c.warnings.length).toBe(2);
    const allowRule = userRules.find((r) => r.ruleClass === "allow");
    const denyRule = userRules.find((r) => r.ruleClass === "deny");
    expect(allowRule?.source).toBe("Bash(git *)");
    expect(denyRule?.source).toBe("Write(**)");
  });

  it("preserves source order within a class", () => {
    const c = compilePermissions({
      allow: ["Bash(git *)", "Write(src/**)", "Edit(**)"],
    });
    const allowRules = c.rules.filter((r) => r.ruleClass === "allow");
    // User rules come first, then defaults
    expect(allowRules.map((r) => r.source)).toEqual([
      "Bash(git *)",
      "Write(src/**)",
      "Edit(**)",
      ...DEFAULT_ALLOW_PATTERNS,
    ]);
  });

  it("passes mcpTools through unchanged", () => {
    const c = compilePermissions({ mcpTools: { mcp__github__get_issue: "readonly" } });
    expect(c.mcpTools).toEqual({ mcp__github__get_issue: "readonly" });
  });

  it("tags each rule with the correct ruleClass", () => {
    const c = compilePermissions({
      allow: ["Read"],
      ask: ["Write(src/**)"],
      deny: ["Bash(rm *)"],
    });
    const byClass = Object.fromEntries(c.rules.map((r) => [r.source, r.ruleClass]));
    expect(byClass["Read"]).toBe("allow");
    expect(byClass["Write(src/**)"]).toBe("ask");
    expect(byClass["Bash(rm *)"]).toBe("deny");
  });
});

describe("firstMatch", () => {
  it("returns first-in-order matching rule of the given class", () => {
    const c = compilePermissions({
      allow: ["Bash(git *)", "Bash(**)"],
    });
    const hit = firstMatch(c.rules, call("Bash", { command: "git push" }), "allow");
    expect(hit?.source).toBe("Bash(git *)");
  });

  it("returns undefined when nothing matches", () => {
    const c = compilePermissions({ allow: ["Bash(git *)"] });
    const hit = firstMatch(c.rules, call("Bash", { command: "rm -rf /" }), "allow");
    expect(hit).toBeUndefined();
  });

  it("filters by ruleClass — ignores matching rules in other classes", () => {
    const c = compilePermissions({
      deny: ["Bash(rm *)"],
      allow: ["Bash(git *)"],
    });
    // `rm foo` stays within a single path segment so picomatch `rm *` matches.
    // A deny rule matches, but we asked for allow only.
    const hit = firstMatch(c.rules, call("Bash", { command: "rm foo" }), "allow");
    expect(hit).toBeUndefined();
    const denyHit = firstMatch(c.rules, call("Bash", { command: "rm foo" }), "deny");
    expect(denyHit?.source).toBe("Bash(rm *)");
  });
});

// ---------------------------------------------------------------------------
// Browser MCP auto-allow tests (Phase 07.5 T2-01)
// ---------------------------------------------------------------------------

describe("DEFAULT_ALLOW_PATTERNS", () => {
  it("includes mcp__playwright__* pattern", () => {
    expect(DEFAULT_ALLOW_PATTERNS).toContain("mcp__playwright__*");
  });

  it("includes mcp__playwright-extension__* pattern", () => {
    expect(DEFAULT_ALLOW_PATTERNS).toContain("mcp__playwright-extension__*");
  });

  it("includes mcp__chrome-devtools__* pattern", () => {
    expect(DEFAULT_ALLOW_PATTERNS).toContain("mcp__chrome-devtools__*");
  });
});

describe("browser MCP auto-allow (Phase 07.5)", () => {
  it("mcp__playwright__browser_navigate → allow under any permission mode", () => {
    // Test with default mode
    const cDefault = compilePermissions({ mode: "default" });
    const hitDefault = firstMatch(cDefault.rules, call("mcp__playwright__browser_navigate"), "allow");
    expect(hitDefault).toBeDefined();
    expect(hitDefault?.source).toBe("mcp__playwright__*");

    // Test with plan mode
    const cPlan = compilePermissions({ mode: "plan" });
    const hitPlan = firstMatch(cPlan.rules, call("mcp__playwright__browser_navigate"), "allow");
    expect(hitPlan).toBeDefined();

    // Test with acceptEdits mode
    const cAccept = compilePermissions({ mode: "acceptEdits" });
    const hitAccept = firstMatch(cAccept.rules, call("mcp__playwright__browser_navigate"), "allow");
    expect(hitAccept).toBeDefined();
  });

  it("mcp__playwright__browser_evaluate → allow (NOT ask; carve-out was removed)", () => {
    const c = compilePermissions({ mode: "default" });
    const hit = firstMatch(c.rules, call("mcp__playwright__browser_evaluate"), "allow");
    expect(hit).toBeDefined();
    expect(hit?.source).toBe("mcp__playwright__*");

    // Should NOT match any ask rule
    const askHit = firstMatch(c.rules, call("mcp__playwright__browser_evaluate"), "ask");
    expect(askHit).toBeUndefined();
  });

  it("mcp__playwright__browser_run_code → allow", () => {
    const c = compilePermissions({});
    const hit = firstMatch(c.rules, call("mcp__playwright__browser_run_code"), "allow");
    expect(hit).toBeDefined();
    expect(hit?.source).toBe("mcp__playwright__*");
  });

  it("mcp__playwright__browser_file_upload → allow", () => {
    const c = compilePermissions({});
    const hit = firstMatch(c.rules, call("mcp__playwright__browser_file_upload"), "allow");
    expect(hit).toBeDefined();
    expect(hit?.source).toBe("mcp__playwright__*");
  });

  it("mcp__chrome-devtools__lighthouse_audit → allow (wildcard handles T3-02 even though deferred)", () => {
    const c = compilePermissions({});
    const hit = firstMatch(c.rules, call("mcp__chrome-devtools__lighthouse_audit"), "allow");
    expect(hit).toBeDefined();
    expect(hit?.source).toBe("mcp__chrome-devtools__*");
  });

  it("mcp__playwright-extension__browser_snapshot → allow", () => {
    const c = compilePermissions({});
    const hit = firstMatch(c.rules, call("mcp__playwright-extension__browser_snapshot"), "allow");
    expect(hit).toBeDefined();
    expect(hit?.source).toBe("mcp__playwright-extension__*");
  });

  it("mcp__some-other-server__foo → NOT auto-allowed by this patch", () => {
    const c = compilePermissions({});
    const hit = firstMatch(c.rules, call("mcp__some-other-server__foo"), "allow");
    // Should NOT match any of the default browser patterns
    expect(hit).toBeUndefined();
  });

  it("Bash still respects existing rules (no regression)", () => {
    // User can still deny Bash
    const c = compilePermissions({
      deny: ["Bash(rm *)"],
      allow: ["Bash(git *)"],
    });

    // rm command matches deny (use "rm foo" not "rm -rf /" to avoid path separator issue)
    const denyHit = firstMatch(c.rules, call("Bash", { command: "rm foo" }), "deny");
    expect(denyHit).toBeDefined();
    expect(denyHit?.source).toBe("Bash(rm *)");

    // git command matches allow
    const allowHit = firstMatch(c.rules, call("Bash", { command: "git push" }), "allow");
    expect(allowHit).toBeDefined();
    expect(allowHit?.source).toBe("Bash(git *)");

    // Browser rules don't affect Bash - git * matches, not mcp__playwright__*
    const bashGitHit = firstMatch(c.rules, call("Bash", { command: "git status" }), "allow");
    expect(bashGitHit?.source).toBe("Bash(git *)"); // NOT mcp__playwright__*
  });
});
