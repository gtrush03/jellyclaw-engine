/**
 * Unit tests for the Write tool.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createLogger } from "../../../engine/src/logger.js";
import { allowAll, denyAll } from "../../../engine/src/tools/permissions.js";
import {
  CwdEscapeError,
  InvalidInputError,
  type ToolContext,
  WriteRequiresReadError,
} from "../../../engine/src/tools/types.js";
import { writeTool } from "../../../engine/src/tools/write.js";
import writeSchema from "../../fixtures/tools/claude-code-schemas/write.json" with { type: "json" };

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

describe("writeTool", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "jellyclaw-write-"));
  });

  afterEach(() => {
    try {
      rmSync(cwd, { recursive: true, force: true });
    } catch {
      // ignore
    }
    vi.restoreAllMocks();
  });

  it("creates a new file and adds path to readCache", async () => {
    const ctx = makeCtx(cwd);
    const target = resolve(join(cwd, "new.txt"));

    const out = await writeTool.handler({ file_path: target, content: "hello" }, ctx);

    expect(out.created).toBe(true);
    expect(out.bytes_written).toBe(Buffer.byteLength("hello", "utf8"));
    expect(readFileSync(target, "utf8")).toBe("hello");
    expect(ctx.readCache.has(target)).toBe(true);
  });

  it("refuses to overwrite a file that was not previously Read", async () => {
    const ctx = makeCtx(cwd);
    const target = resolve(join(cwd, "existing.txt"));
    writeFileSync(target, "old", "utf8");

    await expect(
      writeTool.handler({ file_path: target, content: "new" }, ctx),
    ).rejects.toBeInstanceOf(WriteRequiresReadError);

    expect(readFileSync(target, "utf8")).toBe("old");
  });

  it("overwrites when the file was Read first", async () => {
    const ctx = makeCtx(cwd);
    const target = resolve(join(cwd, "existing.txt"));
    writeFileSync(target, "old", "utf8");
    ctx.readCache.add(target);

    const out = await writeTool.handler({ file_path: target, content: "new" }, ctx);

    expect(out.created).toBe(false);
    expect(readFileSync(target, "utf8")).toBe("new");
  });

  it("leaves the original file intact when the atomic rename fails", async () => {
    const ctx = makeCtx(cwd);
    const target = resolve(join(cwd, "existing.txt"));
    writeFileSync(target, "old", "utf8");
    ctx.readCache.add(target);

    // Force rename to fail by pre-creating the tmp path as a non-empty
    // directory — renameSync(file, dir) fails with ENOTDIR/ENOTEMPTY/EISDIR.
    const tmpPath = `${target}.jellyclaw.tmp`;
    mkdirSync(tmpPath);
    writeFileSync(join(tmpPath, "blocker"), "x", "utf8");

    await expect(writeTool.handler({ file_path: target, content: "new" }, ctx)).rejects.toThrow();

    // Original untouched — this is the load-bearing invariant.
    expect(readFileSync(target, "utf8")).toBe("old");

    // Cleanup our synthetic blocker so afterEach can rm -rf cleanly.
    rmSync(tmpPath, { recursive: true, force: true });
  });

  it("preserves trailing newline from the existing file", async () => {
    const ctx = makeCtx(cwd);
    const target = resolve(join(cwd, "trailing.txt"));
    writeFileSync(target, "old\n", "utf8");
    ctx.readCache.add(target);

    const out = await writeTool.handler({ file_path: target, content: "new" }, ctx);

    expect(readFileSync(target, "utf8")).toBe("new\n");
    expect(out.bytes_written).toBe(Buffer.byteLength("new\n", "utf8"));
  });

  it("refuses paths outside cwd under denyAll permissions", async () => {
    const ctx = makeCtx(cwd);
    const outside = mkdtempSync(join(tmpdir(), "jellyclaw-write-outside-"));
    const target = resolve(join(outside, "x.txt"));

    try {
      await expect(
        writeTool.handler({ file_path: target, content: "x" }, ctx),
      ).rejects.toBeInstanceOf(CwdEscapeError);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("allows paths outside cwd under write.outside_cwd allow", async () => {
    const ctx = makeCtx(cwd, { allow: true });
    const outside = mkdtempSync(join(tmpdir(), "jellyclaw-write-outside-"));
    const target = resolve(join(outside, "x.txt"));

    try {
      const out = await writeTool.handler({ file_path: target, content: "x" }, ctx);
      expect(out.created).toBe(true);
      expect(readFileSync(target, "utf8")).toBe("x");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects relative file_path with InvalidInputError", async () => {
    const ctx = makeCtx(cwd);
    await expect(
      writeTool.handler({ file_path: "./foo.txt", content: "x" }, ctx),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it("inputSchema deep-equals the Claude Code fixture", () => {
    expect(writeTool.inputSchema).toEqual(writeSchema);
  });
});
