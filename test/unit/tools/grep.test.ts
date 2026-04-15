/**
 * Unit tests for the Grep tool.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";

import { createLogger } from "../../../engine/src/logger.js";
import { grepTool } from "../../../engine/src/tools/grep.js";
import { getTool } from "../../../engine/src/tools/index.js";
import { allowAll, denyAll } from "../../../engine/src/tools/permissions.js";
import { CwdEscapeError, type ToolContext } from "../../../engine/src/tools/types.js";
import grepSchema from "../../fixtures/tools/claude-code-schemas/grep.json" with { type: "json" };

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

describe("grepTool", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "jellyclaw-grep-"));
    writeFileSync(join(cwd, "foo.ts"), 'const a = "hello";\nconst b = "hello";\n', "utf8");
    writeFileSync(join(cwd, "bar.ts"), 'const c = "hello";\n', "utf8");
    writeFileSync(join(cwd, "baz.md"), "hello world\n", "utf8");
    writeFileSync(join(cwd, "HELLO.txt"), "HELLO\n", "utf8");
    writeFileSync(join(cwd, "multi.ts"), "start\nmiddle\nend\n", "utf8");
  });

  afterEach(() => {
    try {
      rmSync(cwd, { recursive: true, force: true });
    } catch {
      // ignore
    }
    vi.restoreAllMocks();
  });

  it("inputSchema deep-equals the Claude Code fixture", () => {
    expect(grepTool.inputSchema).toEqual(grepSchema);
  });

  it("registry returns grepTool by name", () => {
    expect(getTool("Grep")).toBe(grepTool);
  });

  it("content mode returns 4 lowercase 'hello' matches across foo/bar/baz", async () => {
    const ctx = makeCtx(cwd);
    const out = await grepTool.handler({ pattern: "hello", output_mode: "content" }, ctx);
    expect(out.mode).toBe("content");
    if (out.mode !== "content") throw new Error("type narrow");
    expect(out.matches.length).toBe(4);
    // Case-sensitive: HELLO.txt must NOT appear.
    for (const m of out.matches) {
      expect(m.path).not.toMatch(/HELLO\.txt/);
    }
  });

  it("files_with_matches returns 3 files (excluding HELLO.txt)", async () => {
    const ctx = makeCtx(cwd);
    const out = await grepTool.handler(
      { pattern: "hello", output_mode: "files_with_matches" },
      ctx,
    );
    expect(out.mode).toBe("files_with_matches");
    if (out.mode !== "files_with_matches") throw new Error("type narrow");
    expect(out.files.length).toBe(3);
    expect(out.files.some((f) => f.endsWith("HELLO.txt"))).toBe(false);
  });

  it("count mode returns per-file match counts", async () => {
    const ctx = makeCtx(cwd);
    const out = await grepTool.handler({ pattern: "hello", output_mode: "count" }, ctx);
    expect(out.mode).toBe("count");
    if (out.mode !== "count") throw new Error("type narrow");
    const map = new Map(out.counts.map((c) => [c.path.split("/").pop() ?? "", c.count]));
    expect(map.get("foo.ts")).toBe(2);
    expect(map.get("bar.ts")).toBe(1);
    expect(map.get("baz.md")).toBe(1);
  });

  it("-i case-insensitive includes HELLO.txt", async () => {
    const ctx = makeCtx(cwd);
    const out = await grepTool.handler(
      { pattern: "hello", output_mode: "files_with_matches", "-i": true },
      ctx,
    );
    if (out.mode !== "files_with_matches") throw new Error("type narrow");
    expect(out.files.some((f) => f.endsWith("HELLO.txt"))).toBe(true);
    expect(out.files.length).toBe(4);
  });

  it("-C 1 produces match lines with surrounding context", async () => {
    const ctx = makeCtx(cwd);
    const out = await grepTool.handler({ pattern: "middle", output_mode: "content", "-C": 1 }, ctx);
    if (out.mode !== "content") throw new Error("type narrow");
    // 1 match + 1 before + 1 after = 3 entries minimum.
    expect(out.matches.length).toBe(3);
    const matchOnly = out.matches.filter((m) => !m.is_context);
    expect(matchOnly.length).toBe(1);
    expect(matchOnly[0]?.line).toContain("middle");
    const ctxOnly = out.matches.filter((m) => m.is_context === true);
    expect(ctxOnly.length).toBe(2);
  });

  it("multiline mode matches a pattern that spans newlines", async () => {
    const ctx = makeCtx(cwd);
    const out = await grepTool.handler(
      {
        pattern: "start[\\s\\S]*?end",
        output_mode: "files_with_matches",
        multiline: true,
      },
      ctx,
    );
    if (out.mode !== "files_with_matches") throw new Error("type narrow");
    expect(out.files.some((f) => f.endsWith("multi.ts"))).toBe(true);
  });

  it("type: 'ts' restricts to .ts files", async () => {
    const ctx = makeCtx(cwd);
    const out = await grepTool.handler(
      { pattern: "hello", output_mode: "files_with_matches", type: "ts" },
      ctx,
    );
    if (out.mode !== "files_with_matches") throw new Error("type narrow");
    expect(out.files.length).toBe(2);
    for (const f of out.files) expect(f.endsWith(".ts")).toBe(true);
  });

  it("head_limit caps to N entries", async () => {
    const ctx = makeCtx(cwd);
    const out = await grepTool.handler(
      { pattern: "hello", output_mode: "files_with_matches", head_limit: 1 },
      ctx,
    );
    if (out.mode !== "files_with_matches") throw new Error("type narrow");
    expect(out.files.length).toBe(1);
  });

  it("offset skips the first N entries", async () => {
    const ctx = makeCtx(cwd);
    const full = await grepTool.handler(
      { pattern: "hello", output_mode: "files_with_matches" },
      ctx,
    );
    if (full.mode !== "files_with_matches") throw new Error("type narrow");

    const skipped = await grepTool.handler(
      { pattern: "hello", output_mode: "files_with_matches", offset: 1 },
      ctx,
    );
    if (skipped.mode !== "files_with_matches") throw new Error("type narrow");
    expect(skipped.files.length).toBe(full.files.length - 1);
  });

  it("glob restricts the file set", async () => {
    const ctx = makeCtx(cwd);
    const out = await grepTool.handler(
      { pattern: "hello", output_mode: "files_with_matches", glob: "*.md" },
      ctx,
    );
    if (out.mode !== "files_with_matches") throw new Error("type narrow");
    expect(out.files.length).toBe(1);
    expect(out.files[0]?.endsWith("baz.md")).toBe(true);
  });

  it("returns empty result when pattern matches nothing (rg exit 1)", async () => {
    const ctx = makeCtx(cwd);
    const out = await grepTool.handler(
      { pattern: "zzzzzzznotthereanywhere", output_mode: "files_with_matches" },
      ctx,
    );
    if (out.mode !== "files_with_matches") throw new Error("type narrow");
    expect(out.files).toEqual([]);
  });

  it("does NOT execute shell metacharacters in the pattern", async () => {
    const ctx = makeCtx(cwd);
    // If grep ever shelled out, `$(whoami)` would be substituted. Because we
    // use spawn(argv[]) it is treated as a literal regex and matches no files.
    const out = await grepTool.handler(
      { pattern: "$(whoami)", output_mode: "files_with_matches" },
      ctx,
    );
    if (out.mode !== "files_with_matches") throw new Error("type narrow");
    expect(out.files).toEqual([]);
  });

  it("truncates output when JSON exceeds 50k chars", async () => {
    const big = `${"hello\n".repeat(20_000)}`;
    writeFileSync(join(cwd, "big.txt"), big, "utf8");
    const ctx = makeCtx(cwd);
    const out = await grepTool.handler({ pattern: "hello", output_mode: "content" }, ctx);
    if (out.mode !== "content") throw new Error("type narrow");
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(50_000);
    expect(out.truncated).toBe(true);
  });

  it("refuses absolute outside-cwd path under denyAll", async () => {
    const ctx = makeCtx(cwd);
    const outside = mkdtempSync(join(tmpdir(), "jellyclaw-grep-outside-"));
    try {
      await expect(
        grepTool.handler(
          { pattern: "hello", output_mode: "files_with_matches", path: resolve(outside) },
          ctx,
        ),
      ).rejects.toBeInstanceOf(CwdEscapeError);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects -C 51 with a ZodError (context cap)", async () => {
    const ctx = makeCtx(cwd);
    await expect(
      grepTool.handler({ pattern: "hello", output_mode: "content", "-C": 51 }, ctx),
    ).rejects.toBeInstanceOf(ZodError);
  });
});
