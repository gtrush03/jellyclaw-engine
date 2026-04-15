import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseAgentFile } from "./parser.js";
import { AGENT_BODY_MAX_BYTES, AgentLoadError } from "./types.js";

describe("parseAgentFile", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "jellyclaw-agent-parser-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function write(name: string, contents: string): string {
    const p = join(dir, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(p, contents, "utf8");
    return p;
  }

  it("parses valid frontmatter + body into Agent with trimmed prompt", () => {
    const path = write(
      "ok.md",
      `---
name: code-reviewer
description: Reviews code for bugs
tools: [Read, Grep]
---

   You are a careful code reviewer.

`,
    );

    const agent = parseAgentFile({ path, source: "user" });
    expect(agent.name).toBe("code-reviewer");
    expect(agent.frontmatter.description).toBe("Reviews code for bugs");
    expect(agent.frontmatter.tools).toEqual(["Read", "Grep"]);
    expect(agent.prompt).toBe("You are a careful code reviewer.");
    expect(agent.source).toBe("user");
    expect(agent.path).toBe(path);
    expect(agent.mtimeMs).toBeGreaterThan(0);
  });

  it("rejects missing name", () => {
    const path = write(
      "bad.md",
      `---
description: no name here
---
body
`,
    );
    expect(() => parseAgentFile({ path, source: "user" })).toThrow(AgentLoadError);
    expect(() => parseAgentFile({ path, source: "user" })).toThrow(/name/);
  });

  it("rejects name that violates kebab-case regex (PascalCase)", () => {
    const path = write(
      "bad.md",
      `---
name: FooBar
description: whatever
---
body
`,
    );
    expect(() => parseAgentFile({ path, source: "user" })).toThrow(AgentLoadError);
  });

  it("rejects name that violates kebab-case regex (snake_case)", () => {
    const path = write(
      "bad.md",
      `---
name: foo_bar
description: whatever
---
body
`,
    );
    expect(() => parseAgentFile({ path, source: "user" })).toThrow(AgentLoadError);
  });

  it("rejects tools list containing illegal entry", () => {
    const path = write(
      "bad.md",
      `---
name: foo
description: d
tools: [Read, invalid]
---
body
`,
    );
    expect(() => parseAgentFile({ path, source: "user" })).toThrow(/tool/i);
  });

  it("rejects empty body (whitespace only)", () => {
    const path = write(
      "bad.md",
      `---
name: foo
description: d
---

   \t\n  \n
`,
    );
    expect(() => parseAgentFile({ path, source: "user" })).toThrow(/empty body/);
  });

  it("rejects body exceeding 16 KB (measured in bytes)", () => {
    const bigBody = "x".repeat(AGENT_BODY_MAX_BYTES + 1);
    const path = write(
      "big.md",
      `---
name: big
description: oversized body
---
${bigBody}
`,
    );
    expect(() => parseAgentFile({ path, source: "user" })).toThrow(/16384 bytes/);
  });

  it("rejects unknown frontmatter key (strict mode)", () => {
    const path = write(
      "bad.md",
      `---
name: foo
description: d
foo: bar
---
body
`,
    );
    expect(() => parseAgentFile({ path, source: "user" })).toThrow(AgentLoadError);
  });

  it("accepts mode: primary without further action", () => {
    const path = write(
      "ok.md",
      `---
name: orchestrator
description: Top-level orchestrator
mode: primary
---
I orchestrate.
`,
    );
    const agent = parseAgentFile({ path, source: "user" });
    expect(agent.frontmatter.mode).toBe("primary");
  });

  it("applies defaults: max_turns=20, max_tokens=100000, mode=subagent", () => {
    const path = write(
      "ok.md",
      `---
name: defaulter
description: uses defaults
---
I rely on defaults.
`,
    );
    const agent = parseAgentFile({ path, source: "user" });
    expect(agent.frontmatter.max_turns).toBe(20);
    expect(agent.frontmatter.max_tokens).toBe(100_000);
    expect(agent.frontmatter.mode).toBe("subagent");
  });

  it("rejects name mismatch with expectedName", () => {
    const path = write(
      "ok.md",
      `---
name: foo
description: d
---
body
`,
    );
    expect(() => parseAgentFile({ path, source: "user", expectedName: "bar" })).toThrow(
      /does not match/,
    );
  });

  it("accepts name match with expectedName", () => {
    const path = write(
      "ok.md",
      `---
name: foo
description: d
---
body
`,
    );
    const agent = parseAgentFile({ path, source: "user", expectedName: "foo" });
    expect(agent.name).toBe("foo");
  });
});
