/**
 * Unit tests for the Edit tool.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createLogger } from "../../../engine/src/logger.js";
import { editTool } from "../../../engine/src/tools/edit.js";
import { getTool } from "../../../engine/src/tools/index.js";
import { allowAll, denyAll } from "../../../engine/src/tools/permissions.js";
import {
  AmbiguousMatchError,
  CwdEscapeError,
  EditRequiresReadError,
  InvalidInputError,
  NoMatchError,
  NoOpEditError,
  type ToolContext,
} from "../../../engine/src/tools/types.js";
import editSchema from "../../fixtures/tools/claude-code-schemas/edit.json" with { type: "json" };

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

function seed(cwd: string, name: string, content: string, { binary = false } = {}): string {
  const target = resolve(join(cwd, name));
  if (binary) {
    writeFileSync(target, Buffer.from(content, "utf8"));
  } else {
    writeFileSync(target, content, "utf8");
  }
  return target;
}

describe("editTool", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "jellyclaw-edit-"));
  });

  afterEach(() => {
    try {
      rmSync(cwd, { recursive: true, force: true });
    } catch {
      // ignore
    }
    vi.restoreAllMocks();
  });

  it("replaces a unique match", async () => {
    const ctx = makeCtx(cwd);
    const target = seed(cwd, "a.txt", "hello world");
    ctx.readCache.add(target);

    const out = await editTool.handler(
      { file_path: target, old_string: "world", new_string: "there" },
      ctx,
    );

    expect(out.occurrences_replaced).toBe(1);
    expect(out.diff_preview.length).toBeGreaterThan(0);
    expect(readFileSync(target, "utf8")).toBe("hello there");
  });

  it("throws NoMatchError when old_string is absent", async () => {
    const ctx = makeCtx(cwd);
    const target = seed(cwd, "a.txt", "foo");
    ctx.readCache.add(target);

    try {
      await editTool.handler({ file_path: target, old_string: "bar", new_string: "baz" }, ctx);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(NoMatchError);
      expect((err as Error).message).toContain("not found");
    }
  });

  it("throws AmbiguousMatchError with count when multiple matches", async () => {
    const ctx = makeCtx(cwd);
    const target = seed(cwd, "a.txt", "foo foo");
    ctx.readCache.add(target);

    try {
      await editTool.handler({ file_path: target, old_string: "foo", new_string: "bar" }, ctx);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AmbiguousMatchError);
      expect((err as AmbiguousMatchError).count).toBe(2);
      expect((err as Error).message).toContain("replace_all");
    }
  });

  it("replaces all occurrences when replace_all is true", async () => {
    const ctx = makeCtx(cwd);
    const target = seed(cwd, "a.txt", "foo foo foo");
    ctx.readCache.add(target);

    const out = await editTool.handler(
      { file_path: target, old_string: "foo", new_string: "bar", replace_all: true },
      ctx,
    );

    expect(out.occurrences_replaced).toBe(3);
    expect(readFileSync(target, "utf8")).toBe("bar bar bar");
  });

  it("throws NoOpEditError when old_string === new_string", async () => {
    const ctx = makeCtx(cwd);
    const target = seed(cwd, "a.txt", "hello");
    ctx.readCache.add(target);

    await expect(
      editTool.handler({ file_path: target, old_string: "hi", new_string: "hi" }, ctx),
    ).rejects.toBeInstanceOf(NoOpEditError);
  });

  it("throws EditRequiresReadError when file is not in readCache", async () => {
    const ctx = makeCtx(cwd);
    const target = seed(cwd, "a.txt", "hello");
    // Deliberately NOT adding to readCache.

    await expect(
      editTool.handler({ file_path: target, old_string: "hello", new_string: "bye" }, ctx),
    ).rejects.toBeInstanceOf(EditRequiresReadError);
  });

  it("refuses to create a non-existent file", async () => {
    const ctx = makeCtx(cwd);
    const target = resolve(join(cwd, "does-not-exist.txt"));
    ctx.readCache.add(target);

    try {
      await editTool.handler({ file_path: target, old_string: "x", new_string: "y" }, ctx);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidInputError);
      expect((err as Error).message).toContain("cannot create");
    }
  });

  it("preserves trailing newline when original has one", async () => {
    const ctx = makeCtx(cwd);
    const target = seed(cwd, "a.txt", "line1\nline2\n");
    ctx.readCache.add(target);

    await editTool.handler({ file_path: target, old_string: "line1", new_string: "LINE1" }, ctx);

    expect(readFileSync(target, "utf8")).toBe("LINE1\nline2\n");
  });

  it("does not add a trailing newline when original had none", async () => {
    const ctx = makeCtx(cwd);
    const target = seed(cwd, "a.txt", "no-newline-here");
    ctx.readCache.add(target);

    await editTool.handler({ file_path: target, old_string: "no", new_string: "NO" }, ctx);

    expect(readFileSync(target, "utf8")).toBe("NO-newline-here");
  });

  it("rejects relative file_path", async () => {
    const ctx = makeCtx(cwd);
    await expect(
      editTool.handler({ file_path: "./a.txt", old_string: "x", new_string: "y" }, ctx),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it("throws CwdEscapeError for outside-cwd paths under denyAll", async () => {
    const ctx = makeCtx(cwd);
    const outside = mkdtempSync(join(tmpdir(), "jellyclaw-edit-outside-"));
    const target = seed(outside, "a.txt", "hello");
    ctx.readCache.add(target);

    try {
      await expect(
        editTool.handler({ file_path: target, old_string: "hello", new_string: "hi" }, ctx),
      ).rejects.toBeInstanceOf(CwdEscapeError);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("allows outside-cwd paths when permissions grant edit.outside_cwd", async () => {
    const ctx = makeCtx(cwd, { allow: true });
    const outside = mkdtempSync(join(tmpdir(), "jellyclaw-edit-outside-"));
    const target = seed(outside, "a.txt", "hello");
    ctx.readCache.add(target);

    try {
      const out = await editTool.handler(
        { file_path: target, old_string: "hello", new_string: "hi" },
        ctx,
      );
      expect(out.occurrences_replaced).toBe(1);
      expect(readFileSync(target, "utf8")).toBe("hi");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects replace_all with empty old_string", async () => {
    const ctx = makeCtx(cwd);
    const target = seed(cwd, "a.txt", "hello");
    ctx.readCache.add(target);

    try {
      await editTool.handler(
        { file_path: target, old_string: "", new_string: "x", replace_all: true },
        ctx,
      );
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidInputError);
      expect((err as Error).message).toContain("infinite match");
    }
  });

  it("produces a CRLF-aware diagnostic on mismatch", async () => {
    const ctx = makeCtx(cwd);
    const target = seed(cwd, "a.txt", "hello\r\nworld\r\n", { binary: true });
    ctx.readCache.add(target);

    try {
      await editTool.handler(
        { file_path: target, old_string: "hello\nworld", new_string: "hi\nworld" },
        ctx,
      );
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(NoMatchError);
      expect((err as Error).message).toContain("CRLF");
    }
  });

  it("produces a line-number-prefix diagnostic on mismatch", async () => {
    const ctx = makeCtx(cwd);
    const target = seed(cwd, "a.txt", "hello world");
    ctx.readCache.add(target);

    try {
      await editTool.handler({ file_path: target, old_string: "42\thello", new_string: "hi" }, ctx);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(NoMatchError);
      expect((err as Error).message).toContain("line-number prefix");
    }
  });

  it("leaves original intact when the atomic rename fails", async () => {
    const ctx = makeCtx(cwd);
    const target = seed(cwd, "a.txt", "hello world");
    ctx.readCache.add(target);

    const tmpPath = `${target}.jellyclaw.tmp`;
    mkdirSync(tmpPath);
    writeFileSync(join(tmpPath, "blocker"), "x", "utf8");

    await expect(
      editTool.handler({ file_path: target, old_string: "world", new_string: "there" }, ctx),
    ).rejects.toThrow();

    expect(readFileSync(target, "utf8")).toBe("hello world");

    rmSync(tmpPath, { recursive: true, force: true });
  });

  it("inputSchema deep-equals the Claude Code fixture", () => {
    expect(editTool.inputSchema).toEqual(editSchema);
  });

  it("is registered in the builtin tool registry under 'Edit'", () => {
    expect(getTool("Edit")).toBe(editTool);
  });
});
