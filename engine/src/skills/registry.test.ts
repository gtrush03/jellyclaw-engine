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

  describe("reload + subscribe", () => {
    it("reload() returns a correct diff across write/delete/modify cycles", async () => {
      writeFileSync(join(userDir, "a.md"), fm("a", "v1"));
      writeFileSync(join(userDir, "stays.md"), fm("stays"));
      const reg = new SkillRegistry();
      await reg.loadAll({ roots: roots() });

      // Add b.md, remove a.md, modify stays.md (new path via move to project dir).
      rmSync(join(userDir, "a.md"));
      writeFileSync(join(userDir, "b.md"), fm("b"));
      // Force a path change for "stays": move it to project dir. Since user
      // is now absent, project wins — name stays, path changes.
      rmSync(join(userDir, "stays.md"));
      writeFileSync(join(projDir, "stays.md"), fm("stays", "v2"));

      const diff = await reg.reload();
      expect(diff.added).toEqual(["b"]);
      expect(diff.removed).toEqual(["a"]);
      expect(diff.modified).toEqual(["stays"]);
    });

    it("subscribe() notifies listeners after reload() and unsubscribe stops future notifications", async () => {
      const reg = new SkillRegistry();
      await reg.loadAll({ roots: roots() });

      const events: { added: string[]; removed: string[]; modified: string[] }[] = [];
      const unsub = reg.subscribe((e) => {
        events.push({ added: [...e.added], removed: [...e.removed], modified: [...e.modified] });
      });

      writeFileSync(join(userDir, "one.md"), fm("one"));
      await reg.reload({ roots: roots() });
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ added: ["one"], removed: [], modified: [] });

      unsub();
      writeFileSync(join(userDir, "two.md"), fm("two"));
      await reg.reload({ roots: roots() });
      expect(events).toHaveLength(1);
    });

    it("a throwing listener does not stop other listeners and does not propagate", async () => {
      const reg = new SkillRegistry();
      await reg.loadAll({ roots: roots() });

      const calls: string[] = [];
      reg.subscribe(() => {
        calls.push("first");
        throw new Error("boom");
      });
      reg.subscribe(() => {
        calls.push("second");
      });

      writeFileSync(join(userDir, "x.md"), fm("x"));
      await expect(reg.reload({ roots: roots() })).resolves.toBeDefined();
      expect(calls).toEqual(["first", "second"]);
    });

    it("reload() without a prior loadAll treats previous snapshot as empty", async () => {
      writeFileSync(join(userDir, "a.md"), fm("a"));
      writeFileSync(join(projDir, "b.md"), fm("b"));

      const reg = new SkillRegistry();
      const diff = await reg.reload({ roots: roots() });
      expect(diff.added.sort()).toEqual(["a", "b"]);
      expect(diff.removed).toEqual([]);
      expect(diff.modified).toEqual([]);
    });
  });
});
