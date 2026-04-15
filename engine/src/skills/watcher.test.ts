import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SkillRegistry, type SkillsChangedEvent } from "./registry.js";
import type { SkillSource } from "./types.js";
import { SkillWatcher } from "./watcher.js";

function fm(name: string, body = "body"): string {
  return `---
name: ${name}
description: d for ${name}
---
${body}
`;
}

function nextEvent(reg: SkillRegistry, timeoutMs = 2000): Promise<SkillsChangedEvent> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout waiting for skills event")), timeoutMs);
    const unsub = reg.subscribe((e) => {
      clearTimeout(t);
      unsub();
      resolve(e);
    });
  });
}

describe("SkillWatcher", () => {
  let root: string;
  let userDir: string;
  let projDir: string;
  let legacyDir: string;
  let reg: SkillRegistry;
  let watcher: SkillWatcher;

  const rootsFor = (): { path: string; source: SkillSource }[] => [
    { path: userDir, source: "user" },
    { path: projDir, source: "project" },
    { path: legacyDir, source: "legacy" },
  ];

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "jellyclaw-watcher-"));
    userDir = join(root, "user");
    projDir = join(root, "proj");
    legacyDir = join(root, "legacy");
    mkdirSync(userDir);
    mkdirSync(projDir);
    mkdirSync(legacyDir);
    reg = new SkillRegistry();
    await reg.loadAll({ roots: rootsFor() });
    watcher = new SkillWatcher({
      registry: reg,
      discovery: { roots: rootsFor() },
      debounceMs: 80,
      stabilityThresholdMs: 40,
    });
    await watcher.start();
    // Let chokidar settle on macOS fsevents before the first event.
    await new Promise((r) => setTimeout(r, 50));
  });

  afterEach(async () => {
    await watcher.stop();
    rmSync(root, { recursive: true, force: true });
  });

  it("emits an added diff when a new skill file appears", async () => {
    const pending = nextEvent(reg);
    writeFileSync(join(userDir, "foo.md"), fm("foo"));
    const event = await pending;
    expect(event.added).toEqual(["foo"]);
    expect(event.removed).toEqual([]);
    expect(event.modified).toEqual([]);
  });

  it("emits a modified diff when an existing skill body changes", async () => {
    writeFileSync(join(userDir, "foo.md"), fm("foo", "v1"));
    await nextEvent(reg); // consume the add

    const pending = nextEvent(reg);
    // Ensure the mtime tick is visible by writing slightly later content.
    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(join(userDir, "foo.md"), fm("foo", "v2"));
    const event = await pending;
    expect(event.modified).toEqual(["foo"]);
    expect(event.added).toEqual([]);
    expect(event.removed).toEqual([]);
  });

  it("emits a removed diff when a skill file is deleted", async () => {
    writeFileSync(join(userDir, "foo.md"), fm("foo"));
    await nextEvent(reg);

    const pending = nextEvent(reg);
    rmSync(join(userDir, "foo.md"));
    const event = await pending;
    expect(event.removed).toEqual(["foo"]);
    expect(event.added).toEqual([]);
  });

  it("debounces rapid successive writes into a single diff", async () => {
    const events: SkillsChangedEvent[] = [];
    reg.subscribe((e) => {
      events.push(e);
    });

    writeFileSync(join(userDir, "a.md"), fm("a"));
    writeFileSync(join(userDir, "b.md"), fm("b"));

    await new Promise((r) => setTimeout(r, 800));
    expect(events).toHaveLength(1);
    expect(events[0]?.added.sort()).toEqual(["a", "b"]);
  });

  it("does not fire events after stop()", async () => {
    await watcher.stop();

    const events: SkillsChangedEvent[] = [];
    reg.subscribe((e) => {
      events.push(e);
    });

    writeFileSync(join(userDir, "late.md"), fm("late"));
    await new Promise((r) => setTimeout(r, 500));
    expect(events).toHaveLength(0);
  });

  it("a throwing listener does not block other listeners or crash the watcher", async () => {
    const calls: string[] = [];
    reg.subscribe(() => {
      calls.push("first");
      throw new Error("boom");
    });
    reg.subscribe(() => {
      calls.push("second");
    });

    writeFileSync(join(userDir, "ok.md"), fm("ok"));
    await new Promise((r) => setTimeout(r, 800));
    expect(calls).toContain("first");
    expect(calls).toContain("second");

    // And a second event still flows through.
    writeFileSync(join(userDir, "ok2.md"), fm("ok2"));
    await new Promise((r) => setTimeout(r, 800));
    expect(calls.filter((c) => c === "second").length).toBeGreaterThanOrEqual(2);
  });
});
