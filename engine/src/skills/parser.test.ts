import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseSkillFile } from "./parser.js";
import { SKILL_BODY_MAX_BYTES, SkillLoadError } from "./types.js";

describe("parseSkillFile", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "jellyclaw-skill-parser-"));
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

  it("parses valid frontmatter + body", () => {
    const path = write(
      "ok.md",
      `---
name: commit
description: Create a git commit
trigger: "when user says commit"
allowed_tools: [Bash, Read]
---

Run git status then commit.
`,
    );

    const skill = parseSkillFile({ path, source: "user" });
    expect(skill.name).toBe("commit");
    expect(skill.frontmatter.description).toBe("Create a git commit");
    expect(skill.frontmatter.trigger).toBe("when user says commit");
    expect(skill.frontmatter.allowed_tools).toEqual(["Bash", "Read"]);
    expect(skill.body.trim()).toBe("Run git status then commit.");
    expect(skill.source).toBe("user");
    expect(skill.path).toBe(path);
    expect(skill.mtimeMs).toBeGreaterThan(0);
  });

  it("rejects name that violates kebab-case regex", () => {
    const path = write(
      "bad.md",
      `---
name: Bad_Name
description: whatever
---
body
`,
    );

    expect(() => parseSkillFile({ path, source: "user" })).toThrow(SkillLoadError);
  });

  it("rejects missing description", () => {
    const path = write(
      "bad.md",
      `---
name: foo
---
body
`,
    );

    expect(() => parseSkillFile({ path, source: "user" })).toThrow(/description/);
  });

  it("rejects description longer than 1536 chars", () => {
    const longDesc = "x".repeat(1537);
    const path = write(
      "bad.md",
      `---
name: foo
description: ${longDesc}
---
body
`,
    );

    expect(() => parseSkillFile({ path, source: "user" })).toThrow(SkillLoadError);
  });

  it("accepts description of exactly 1536 chars", () => {
    const desc = "x".repeat(1536);
    const path = write(
      "ok.md",
      `---
name: foo
description: ${desc}
---
body
`,
    );
    const skill = parseSkillFile({ path, source: "user" });
    expect(skill.frontmatter.description).toHaveLength(1536);
  });

  it("rejects body exceeding 8 KB (measured in bytes)", () => {
    const bigBody = "x".repeat(SKILL_BODY_MAX_BYTES + 1);
    const path = write(
      "big.md",
      `---
name: big
description: oversized body
---
${bigBody}
`,
    );

    expect(() => parseSkillFile({ path, source: "user" })).toThrow(/8192 bytes/);
  });

  it("rejects malformed YAML", () => {
    const path = write(
      "bad.md",
      `---
name: foo
description: [unterminated
---
body
`,
    );

    expect(() => parseSkillFile({ path, source: "user" })).toThrow(SkillLoadError);
  });

  it("rejects name mismatch with expectedName (containing dir)", () => {
    const path = write(
      "ok.md",
      `---
name: foo
description: d
---
body
`,
    );

    expect(() => parseSkillFile({ path, source: "user", expectedName: "bar" })).toThrow(
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
    const skill = parseSkillFile({ path, source: "user", expectedName: "foo" });
    expect(skill.name).toBe("foo");
  });

  it("measures body size in bytes, not characters", () => {
    // 4-byte UTF-8 char repeated: 2049 chars * 4 bytes = 8196 bytes > 8192
    const emoji = "𝕏"; // 4 bytes in UTF-8
    const body = emoji.repeat(2049);
    const path = write(
      "multibyte.md",
      `---
name: multi
description: multibyte overflow
---
${body}
`,
    );

    expect(() => parseSkillFile({ path, source: "user" })).toThrow(/bytes/);
  });
});
