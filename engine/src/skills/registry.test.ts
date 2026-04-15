import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SkillRegistry } from "./registry.js";
import type { SkillSource } from "./types.js";

function fm(name: string, body = "default body"): string {
  return `---
name: ${name}
description: desc for ${name}
---
${body}
`;
}

describe("SkillRegistry", () => {
  let root: string;
  let userDir: string;
  let projDir: string;
  let legacyDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "jellyclaw-registry-"));
    userDir = join(root, "user");
    projDir = join(root, "proj");
    legacyDir = join(root, "legacy");
    mkdirSync(userDir);
    mkdirSync(projDir);
    mkdirSync(legacyDir);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const roots = (): { path: string; source: SkillSource }[] => [
    { path: userDir, source: "user" },
    { path: projDir, source: "project" },
    { path: legacyDir, source: "legacy" },
  ];

  const fakeLogger = () => {
    const warn = vi.fn();
    return {
      warn,
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      fatal: vi.fn(),
    } as unknown as Parameters<SkillRegistry["loadAll"]>[0] extends { logger?: infer L }
      ? L
      : never;
  };

  it("loads skills from all three sources", async () => {
    writeFileSync(join(userDir, "a.md"), fm("a", "user-a"));
    writeFileSync(join(projDir, "b.md"), fm("b", "proj-b"));
    writeFileSync(join(legacyDir, "c.md"), fm("c", "legacy-c"));

    const reg = new SkillRegistry();
    await reg.loadAll({ roots: roots() });

    expect(reg.size()).toBe(3);
    expect(reg.get("a")?.source).toBe("user");
    expect(reg.get("b")?.source).toBe("project");
    expect(reg.get("c")?.source).toBe("legacy");
  });

  it("first-wins: user shadows project and legacy", async () => {
    writeFileSync(join(userDir, "same.md"), fm("same", "user-body"));
    writeFileSync(join(projDir, "same.md"), fm("same", "proj-body"));
    writeFileSync(join(legacyDir, "same.md"), fm("same", "legacy-body"));

    const logger = fakeLogger();
    const reg = new SkillRegistry();
    await reg.loadAll({ roots: roots(), logger });

    expect(reg.size()).toBe(1);
    const kept = reg.get("same");
    expect(kept?.source).toBe("user");
    expect(kept?.body).toContain("user-body");

    // Shadowed paths must be warned about — one per shadowed file.
    const warn = logger.warn as unknown as ReturnType<typeof vi.fn>;
    expect(warn).toHaveBeenCalledTimes(2);
    const shadowedSources = warn.mock.calls.map((c) => c[0].shadowedSource).sort();
    expect(shadowedSources).toEqual(["legacy", "project"]);
  });

  it("first-wins: project shadows legacy when user is absent", async () => {
    writeFileSync(join(projDir, "same.md"), fm("same", "proj-body"));
    writeFileSync(join(legacyDir, "same.md"), fm("same", "legacy-body"));

    const reg = new SkillRegistry();
    await reg.loadAll({ roots: roots() });

    expect(reg.get("same")?.source).toBe("project");
  });

  it("get() returns undefined for unknown skill", async () => {
    const reg = new SkillRegistry();
    await reg.loadAll({ roots: roots() });
    expect(reg.get("nonexistent")).toBeUndefined();
  });

  it("list() returns all skills sorted alphabetically", async () => {
    writeFileSync(join(userDir, "zulu.md"), fm("zulu"));
    writeFileSync(join(userDir, "alpha.md"), fm("alpha"));
    writeFileSync(join(userDir, "mike.md"), fm("mike"));

    const reg = new SkillRegistry();
    await reg.loadAll({ roots: roots() });
    expect(reg.list().map((s) => s.name)).toEqual(["alpha", "mike", "zulu"]);
  });

  it("drops a single bad skill with a warn and keeps loading the rest", async () => {
    writeFileSync(join(userDir, "ok.md"), fm("ok"));
    writeFileSync(
      join(userDir, "bad.md"),
      `---
name: Bad_Name
description: d
---
body
`,
    );

    const logger = fakeLogger();
    const reg = new SkillRegistry();
    await reg.loadAll({ roots: roots(), logger });

    expect(reg.size()).toBe(1);
    expect(reg.get("ok")).toBeDefined();
    const warn = logger.warn as unknown as ReturnType<typeof vi.fn>;
    expect(warn).toHaveBeenCalled();
  });

  it("loadAll is idempotent — repeated calls refresh the registry", async () => {
    writeFileSync(join(userDir, "a.md"), fm("a"));
    const reg = new SkillRegistry();
    await reg.loadAll({ roots: roots() });
    expect(reg.size()).toBe(1);

    rmSync(join(userDir, "a.md"));
    writeFileSync(join(userDir, "b.md"), fm("b"));
    await reg.loadAll({ roots: roots() });
    expect(reg.size()).toBe(1);
    expect(reg.get("a")).toBeUndefined();
    expect(reg.get("b")).toBeDefined();
  });
});
