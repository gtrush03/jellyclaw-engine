import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentRegistry } from "./registry.js";
import type { AgentSource } from "./types.js";

function fm(name: string, body = "default prompt body"): string {
  return `---
name: ${name}
description: desc for ${name}
---
${body}
`;
}

describe("AgentRegistry", () => {
  let root: string;
  let userDir: string;
  let projDir: string;
  let legacyDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "jellyclaw-agent-registry-"));
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

  const roots = (): { path: string; source: AgentSource }[] => [
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
    } as unknown as Parameters<AgentRegistry["loadAll"]>[0] extends { logger?: infer L }
      ? L
      : never;
  };

  it("loads agents from all three sources", async () => {
    writeFileSync(join(userDir, "a.md"), fm("a", "user-a"));
    writeFileSync(join(projDir, "b.md"), fm("b", "proj-b"));
    writeFileSync(join(legacyDir, "c.md"), fm("c", "legacy-c"));

    const reg = new AgentRegistry();
    await reg.loadAll({ roots: roots() });

    expect(reg.size()).toBe(3);
    expect(reg.get("a")?.source).toBe("user");
    expect(reg.get("b")?.source).toBe("project");
    expect(reg.get("c")?.source).toBe("legacy");
  });

  it("get() resolves by name and list() returns sorted", async () => {
    writeFileSync(join(userDir, "zulu.md"), fm("zulu"));
    writeFileSync(join(userDir, "alpha.md"), fm("alpha"));
    writeFileSync(join(userDir, "mike.md"), fm("mike"));

    const reg = new AgentRegistry();
    await reg.loadAll({ roots: roots() });
    expect(reg.list().map((a) => a.name)).toEqual(["alpha", "mike", "zulu"]);
    expect(reg.get("mike")?.name).toBe("mike");
    expect(reg.get("nonexistent")).toBeUndefined();
  });

  it("duplicate name across sources: first-wins, warn fired with shadowed path", async () => {
    writeFileSync(join(userDir, "same.md"), fm("same", "user-body"));
    writeFileSync(join(projDir, "same.md"), fm("same", "proj-body"));
    writeFileSync(join(legacyDir, "same.md"), fm("same", "legacy-body"));

    const logger = fakeLogger();
    const reg = new AgentRegistry();
    await reg.loadAll({ roots: roots(), logger });

    expect(reg.size()).toBe(1);
    const kept = reg.get("same");
    expect(kept?.source).toBe("user");

    const warn = logger.warn as unknown as ReturnType<typeof vi.fn>;
    expect(warn).toHaveBeenCalledTimes(2);
    const shadowedSources = warn.mock.calls.map((c) => c[0].shadowedSource).sort();
    expect(shadowedSources).toEqual(["legacy", "project"]);
    const shadowedPaths = warn.mock.calls.map((c) => c[0].shadowed).sort();
    expect(shadowedPaths).toEqual([join(legacyDir, "same.md"), join(projDir, "same.md")].sort());
  });

  it("invalid file is captured as warn; other agents still load", async () => {
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
    const reg = new AgentRegistry();
    await reg.loadAll({ roots: roots(), logger });

    expect(reg.size()).toBe(1);
    expect(reg.get("ok")).toBeDefined();
    const warn = logger.warn as unknown as ReturnType<typeof vi.fn>;
    expect(warn).toHaveBeenCalled();
  });

  describe("reload + subscribe", () => {
    it("reload() picks up a new file as an added diff", async () => {
      writeFileSync(join(userDir, "a.md"), fm("a"));
      const reg = new AgentRegistry();
      await reg.loadAll({ roots: roots() });

      writeFileSync(join(userDir, "b.md"), fm("b"));
      const diff = await reg.reload();
      expect(diff.added).toEqual(["b"]);
      expect(diff.removed).toEqual([]);
      expect(diff.modified).toEqual([]);
    });

    it("reload() picks up a removed file as a removed diff", async () => {
      writeFileSync(join(userDir, "a.md"), fm("a"));
      writeFileSync(join(userDir, "b.md"), fm("b"));
      const reg = new AgentRegistry();
      await reg.loadAll({ roots: roots() });

      rmSync(join(userDir, "a.md"));
      const diff = await reg.reload();
      expect(diff.added).toEqual([]);
      expect(diff.removed).toEqual(["a"]);
      expect(diff.modified).toEqual([]);
    });

    it("reload() picks up an mtime change as a modified diff", async () => {
      writeFileSync(join(userDir, "stays.md"), fm("stays", "v1"));
      const reg = new AgentRegistry();
      await reg.loadAll({ roots: roots() });

      // Path change forces modified (also satisfies mtime sense since file moves).
      rmSync(join(userDir, "stays.md"));
      writeFileSync(join(projDir, "stays.md"), fm("stays", "v2"));

      const diff = await reg.reload();
      expect(diff.added).toEqual([]);
      expect(diff.removed).toEqual([]);
      expect(diff.modified).toEqual(["stays"]);
    });

    it("subscribe() fires on reload diff; unsubscribe stops future notifications", async () => {
      const reg = new AgentRegistry();
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

    it("listener throw does not break reload; warn fired and other listeners still run", async () => {
      const logger = fakeLogger();
      const reg = new AgentRegistry();
      await reg.loadAll({ roots: roots(), logger });

      const calls: string[] = [];
      reg.subscribe(() => {
        calls.push("first");
        throw new Error("boom");
      });
      reg.subscribe(() => {
        calls.push("second");
      });

      writeFileSync(join(userDir, "x.md"), fm("x"));
      await expect(reg.reload({ roots: roots(), logger })).resolves.toBeDefined();
      expect(calls).toEqual(["first", "second"]);
      const warn = logger.warn as unknown as ReturnType<typeof vi.fn>;
      const listenerWarn = warn.mock.calls.find((c) => c[1] === "agent registry listener threw");
      expect(listenerWarn).toBeDefined();
    });
  });
});
