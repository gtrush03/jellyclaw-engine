import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultRoots, discoverAgents } from "./discovery.js";

function fm(name: string, extra = ""): string {
  return `---
name: ${name}
description: test agent ${name}
${extra}
---
body for ${name}
`;
}

describe("discoverAgents", () => {
  let root: string;
  let userDir: string;
  let projDir: string;
  let legacyDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "jellyclaw-agent-discovery-"));
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
    expect(discoverAgents({ roots: missing })).toEqual([]);
  });

  it("gracefully skips missing roots alongside present ones", () => {
    writeFileSync(join(userDir, "alpha.md"), fm("alpha"));
    const mixed = [
      { path: userDir, source: "user" as const },
      { path: join(root, "does-not-exist"), source: "project" as const },
    ];
    const found = discoverAgents({ roots: mixed });
    expect(found.map((f) => f.name)).toEqual(["alpha"]);
  });

  it("finds flat <name>.md files", () => {
    writeFileSync(join(userDir, "alpha.md"), fm("alpha"));
    writeFileSync(join(userDir, "beta.md"), fm("beta"));

    const found = discoverAgents({ roots: roots() });
    expect(found).toHaveLength(2);
    expect(found.map((f) => f.name).sort()).toEqual(["alpha", "beta"]);
    expect(found.every((f) => f.source === "user")).toBe(true);
  });

  it("finds dir-per-agent <name>/AGENT.md files", () => {
    mkdirSync(join(userDir, "gamma"));
    writeFileSync(join(userDir, "gamma", "AGENT.md"), fm("gamma"));

    const found = discoverAgents({ roots: roots() });
    expect(found).toHaveLength(1);
    expect(found[0]?.name).toBe("gamma");
    expect(found[0]?.path).toBe(join(userDir, "gamma", "AGENT.md"));
  });

  it("prefers dir-per-agent over flat within the same root", () => {
    mkdirSync(join(userDir, "delta"));
    writeFileSync(join(userDir, "delta", "AGENT.md"), fm("delta", "# dir winner"));
    writeFileSync(join(userDir, "delta.md"), fm("delta", "# flat loser"));

    const found = discoverAgents({ roots: roots() });
    expect(found).toHaveLength(1);
    expect(found[0]?.path).toBe(join(userDir, "delta", "AGENT.md"));
  });

  it("walks all three roots in configured order", () => {
    writeFileSync(join(userDir, "u.md"), fm("u"));
    writeFileSync(join(projDir, "p.md"), fm("p"));
    writeFileSync(join(legacyDir, "l.md"), fm("l"));

    const found = discoverAgents({ roots: roots() });
    expect(found.map((f) => f.source)).toEqual(["user", "project", "legacy"]);
    expect(found.map((f) => f.name)).toEqual(["u", "p", "l"]);
  });

  it("returns overlapping names across roots — registry decides, not discovery", () => {
    writeFileSync(join(userDir, "same.md"), fm("same"));
    writeFileSync(join(projDir, "same.md"), fm("same"));
    writeFileSync(join(legacyDir, "same.md"), fm("same"));

    const found = discoverAgents({ roots: roots() });
    expect(found).toHaveLength(3);
    expect(found.map((f) => f.source)).toEqual(["user", "project", "legacy"]);
  });

  it("ignores non-markdown files and invalid names", () => {
    writeFileSync(join(userDir, "notes.txt"), "ignore me");
    writeFileSync(join(userDir, "FooBar.md"), fm("whatever"));
    writeFileSync(join(userDir, "foo_bar.md"), fm("whatever"));
    writeFileSync(join(userDir, "ok.md"), fm("ok"));

    const found = discoverAgents({ roots: roots() });
    expect(found.map((f) => f.name)).toEqual(["ok"]);
  });

  it("sorts deterministically within a root", () => {
    writeFileSync(join(userDir, "zulu.md"), fm("zulu"));
    writeFileSync(join(userDir, "alpha.md"), fm("alpha"));
    writeFileSync(join(userDir, "mike.md"), fm("mike"));

    const found = discoverAgents({ roots: roots() });
    expect(found.map((f) => f.name)).toEqual(["alpha", "mike", "zulu"]);
  });

  it("defaultRoots returns user → project → legacy in order", () => {
    const r = defaultRoots("/tmp/project", "/home/me");
    expect(r.map((x) => x.source)).toEqual(["user", "project", "legacy"]);
    expect(r[0]?.path).toBe("/home/me/.jellyclaw/agents");
    expect(r[1]?.path).toBe("/tmp/project/.jellyclaw/agents");
    expect(r[2]?.path).toBe("/tmp/project/.claude/agents");
  });
});
