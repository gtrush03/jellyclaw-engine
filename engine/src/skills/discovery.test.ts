import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultRoots, discoverSkills } from "./discovery.js";

function fm(name: string, extra = ""): string {
  return `---
name: ${name}
description: test skill ${name}
${extra}
---
body for ${name}
`;
}

describe("discoverSkills", () => {
  let root: string;
  let userDir: string;
  let projDir: string;
  let legacyDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "jellyclaw-discovery-"));
    userDir = join(root, "user");
    projDir = join(root, "proj");
    legacyDir = join(root, "legacy");
    mkdirSync(userDir, { recursive: true });
    mkdirSync(projDir, { recursive: true });
    mkdirSync(legacyDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const roots = (): { path: string; source: "user" | "project" | "legacy" }[] => [
    { path: userDir, source: "user" },
    { path: projDir, source: "project" },
    { path: legacyDir, source: "legacy" },
  ];

  it("returns empty list when no roots exist", () => {
    const missing = [{ path: join(root, "nope"), source: "user" as const }];
    expect(discoverSkills({ roots: missing })).toEqual([]);
  });

  it("finds flat <name>.md files", () => {
    writeFileSync(join(userDir, "alpha.md"), fm("alpha"));
    writeFileSync(join(userDir, "beta.md"), fm("beta"));

    const found = discoverSkills({ roots: roots() });
    expect(found).toHaveLength(2);
    expect(found.map((f) => f.name).sort()).toEqual(["alpha", "beta"]);
    expect(found.every((f) => f.source === "user")).toBe(true);
  });

  it("finds dir-per-skill <name>/SKILL.md files", () => {
    mkdirSync(join(userDir, "gamma"));
    writeFileSync(join(userDir, "gamma", "SKILL.md"), fm("gamma"));

    const found = discoverSkills({ roots: roots() });
    expect(found).toHaveLength(1);
    expect(found[0]?.name).toBe("gamma");
    expect(found[0]?.path).toBe(join(userDir, "gamma", "SKILL.md"));
  });

  it("prefers dir-per-skill over flat within the same root", () => {
    mkdirSync(join(userDir, "delta"));
    writeFileSync(join(userDir, "delta", "SKILL.md"), fm("delta", "# dir winner"));
    writeFileSync(join(userDir, "delta.md"), fm("delta", "# flat loser"));

    const found = discoverSkills({ roots: roots() });
    expect(found).toHaveLength(1);
    expect(found[0]?.path).toBe(join(userDir, "delta", "SKILL.md"));
  });

  it("walks all three roots in configured order", () => {
    writeFileSync(join(userDir, "u.md"), fm("u"));
    writeFileSync(join(projDir, "p.md"), fm("p"));
    writeFileSync(join(legacyDir, "l.md"), fm("l"));

    const found = discoverSkills({ roots: roots() });
    expect(found.map((f) => f.source)).toEqual(["user", "project", "legacy"]);
    expect(found.map((f) => f.name)).toEqual(["u", "p", "l"]);
  });

  it("returns overlapping names across roots — registry decides, not discovery", () => {
    writeFileSync(join(userDir, "same.md"), fm("same"));
    writeFileSync(join(projDir, "same.md"), fm("same"));
    writeFileSync(join(legacyDir, "same.md"), fm("same"));

    const found = discoverSkills({ roots: roots() });
    expect(found).toHaveLength(3);
    expect(found.map((f) => f.source)).toEqual(["user", "project", "legacy"]);
  });

  it("ignores non-markdown files and invalid names", () => {
    writeFileSync(join(userDir, "notes.txt"), "ignore me");
    writeFileSync(join(userDir, "Invalid_Name.md"), fm("whatever"));
    writeFileSync(join(userDir, "ok.md"), fm("ok"));

    const found = discoverSkills({ roots: roots() });
    expect(found.map((f) => f.name)).toEqual(["ok"]);
  });

  it("sorts deterministically within a root", () => {
    writeFileSync(join(userDir, "zulu.md"), fm("zulu"));
    writeFileSync(join(userDir, "alpha.md"), fm("alpha"));
    writeFileSync(join(userDir, "mike.md"), fm("mike"));

    const found = discoverSkills({ roots: roots() });
    expect(found.map((f) => f.name)).toEqual(["alpha", "mike", "zulu"]);
  });

  it("defaultRoots returns user → project → legacy in order", () => {
    const r = defaultRoots("/tmp/project", "/home/me");
    expect(r.map((x) => x.source)).toEqual(["user", "project", "legacy"]);
    expect(r[0]?.path).toBe("/home/me/.jellyclaw/skills");
    expect(r[1]?.path).toBe("/tmp/project/.jellyclaw/skills");
    expect(r[2]?.path).toBe("/tmp/project/.claude/skills");
  });
});
