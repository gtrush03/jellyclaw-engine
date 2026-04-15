/**
 * Unit tests for the Glob tool.
 */

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createLogger } from "../../../engine/src/logger.js";
import { getTool, globTool } from "../../../engine/src/tools/index.js";
import { allowAll, denyAll } from "../../../engine/src/tools/permissions.js";
import type { ToolContext } from "../../../engine/src/tools/types.js";
import { CwdEscapeError, InvalidInputError } from "../../../engine/src/tools/types.js";
import globSchema from "../../fixtures/tools/claude-code-schemas/glob.json" with { type: "json" };

function makeCtx(cwd: string, opts: { allow?: boolean } = {}): ToolContext {
  return {
    cwd,
    sessionId: "test-session",
    readCache: new Set<string>(),
    abort: new AbortController().signal,
    logger: createLogger({ level: "silent" }),
    permissions: opts.allow ? allowAll : denyAll,
  };
}

describe("globTool", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "jellyclaw-glob-"));
  });

  afterEach(() => {
    try {
      rmSync(cwd, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("matches files across nested subdirs and returns absolute paths", async () => {
    const ctx = makeCtx(cwd);
    mkdirSync(join(cwd, "a"));
    mkdirSync(join(cwd, "b"));
    mkdirSync(join(cwd, "c"));
    writeFileSync(join(cwd, "a", "1.md"), "x");
    writeFileSync(join(cwd, "a", "2.ts"), "x");
    writeFileSync(join(cwd, "b", "3.md"), "x");
    writeFileSync(join(cwd, "b", "4.ts"), "x");
    writeFileSync(join(cwd, "c", "5.md"), "x");
    writeFileSync(join(cwd, "c", "6.json"), "x");

    const out = await globTool.handler({ pattern: "**/*.md" }, ctx);

    expect(out.files).toHaveLength(3);
    for (const f of out.files) {
      expect(f.startsWith(cwd)).toBe(true);
      expect(f.endsWith(".md")).toBe(true);
    }
  });

  it("sorts results by mtime descending", async () => {
    const ctx = makeCtx(cwd);
    const a = resolve(join(cwd, "a.md"));
    const b = resolve(join(cwd, "b.md"));
    const c = resolve(join(cwd, "c.md"));
    writeFileSync(a, "x");
    writeFileSync(b, "x");
    writeFileSync(c, "x");
    utimesSync(a, 1000, 1000);
    utimesSync(b, 2000, 2000);
    utimesSync(c, 3000, 3000);

    const out = await globTool.handler({ pattern: "*.md" }, ctx);

    expect(out.files).toEqual([c, b, a]);
  });

  it("respects .gitignore at the search root", async () => {
    const ctx = makeCtx(cwd);
    writeFileSync(join(cwd, ".gitignore"), "ignore-me.md\n");
    writeFileSync(join(cwd, "ignore-me.md"), "x");
    writeFileSync(join(cwd, "keep.md"), "x");

    const out = await globTool.handler({ pattern: "*.md" }, ctx);
    const names = out.files.map((f) => f.split("/").pop());
    expect(names).toContain("keep.md");
    expect(names).not.toContain("ignore-me.md");
  });

  it("returns gitignored files when no .gitignore is present", async () => {
    const ctx = makeCtx(cwd);
    writeFileSync(join(cwd, "ignore-me.md"), "x");
    writeFileSync(join(cwd, "keep.md"), "x");

    const out = await globTool.handler({ pattern: "*.md" }, ctx);
    const names = out.files.map((f) => f.split("/").pop());
    expect(names).toContain("keep.md");
    expect(names).toContain("ignore-me.md");
  });

  it("rejects patterns containing .. segments", async () => {
    const ctx = makeCtx(cwd);
    await expect(globTool.handler({ pattern: "../../../etc/passwd" }, ctx)).rejects.toBeInstanceOf(
      InvalidInputError,
    );
  });

  it("refuses path outside cwd under denyAll", async () => {
    const ctx = makeCtx(cwd);
    const outside = mkdtempSync(join(tmpdir(), "jellyclaw-glob-outside-"));
    try {
      await expect(globTool.handler({ pattern: "*", path: outside }, ctx)).rejects.toBeInstanceOf(
        CwdEscapeError,
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("allows path outside cwd when glob.outside_cwd is granted", async () => {
    const ctx = makeCtx(cwd, { allow: true });
    const outside = mkdtempSync(join(tmpdir(), "jellyclaw-glob-outside-"));
    try {
      writeFileSync(join(outside, "x.md"), "x");
      const out = await globTool.handler({ pattern: "*.md", path: outside }, ctx);
      expect(out.files).toHaveLength(1);
      expect(out.files[0]?.endsWith("x.md")).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("defaults to ctx.cwd when path is omitted", async () => {
    const ctx = makeCtx(cwd);
    writeFileSync(join(cwd, "root.md"), "x");
    const out = await globTool.handler({ pattern: "*.md" }, ctx);
    expect(out.files).toHaveLength(1);
    expect(out.files[0]?.endsWith("root.md")).toBe(true);
  });

  it("resolves a relative path against ctx.cwd and accepts an absolute path under cwd", async () => {
    const ctx = makeCtx(cwd);
    mkdirSync(join(cwd, "a"));
    writeFileSync(join(cwd, "a", "x.md"), "x");

    const rel = await globTool.handler({ pattern: "*.md", path: "a" }, ctx);
    expect(rel.files).toHaveLength(1);
    expect(rel.files[0]?.endsWith("x.md")).toBe(true);

    const abs = await globTool.handler({ pattern: "*.md", path: resolve(cwd, "a") }, ctx);
    expect(abs.files).toHaveLength(1);
    expect(abs.files[0]?.endsWith("x.md")).toBe(true);
  });

  it("does not return directories, even when the pattern matches a dir name", async () => {
    const ctx = makeCtx(cwd);
    mkdirSync(join(cwd, "matchme"));
    writeFileSync(join(cwd, "matchme", "inside.txt"), "x");
    writeFileSync(join(cwd, "matchme.txt"), "x");

    const out = await globTool.handler({ pattern: "matchme*" }, ctx);
    // Only the file should appear, not the directory of the same name.
    for (const f of out.files) {
      expect(f.endsWith("matchme")).toBe(false);
    }
    expect(out.files.some((f) => f.endsWith("matchme.txt"))).toBe(true);
  });

  it("inputSchema deep-equals the Claude Code fixture", () => {
    expect(globTool.inputSchema).toEqual(globSchema);
  });

  it("is registered under the name 'Glob'", () => {
    expect(getTool("Glob")).toBe(globTool);
  });
});
