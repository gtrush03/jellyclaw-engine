/**
 * Glob tool — parity with Claude Code's `Glob`.
 *
 * Fast file pattern matching via tinyglobby. Returns absolute paths sorted by
 * mtime (newest first). Honors `.gitignore` at the search root via a minimal
 * line-by-line filter passed through tinyglobby's `ignore` option (we do NOT
 * implement the full gitignore grammar — comments + blank lines are stripped
 * and each remaining line is treated as a glob pattern).
 *
 * Cwd jail: the resolved search path must live under `ctx.cwd` unless
 * `glob.outside_cwd` is allowed. Patterns containing `..` segments are refused
 * outright, since tinyglobby will happily traverse upward from the cwd.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { glob as tinyGlob } from "tinyglobby";
import { z } from "zod";

import globSchema from "../../../test/fixtures/tools/claude-code-schemas/glob.json" with {
  type: "json",
};

import {
  CwdEscapeError,
  InvalidInputError,
  type JsonSchema,
  type Tool,
  type ToolContext,
} from "./types.js";

const STAT_CONCURRENCY = 64;

export const globInputSchema = z.object({
  pattern: z.string().min(1, "pattern must be non-empty"),
  path: z.string().optional(),
});

export type GlobInput = z.input<typeof globInputSchema>;

export interface GlobOutput {
  files: string[];
}

function ensureInsideCwd(resolved: string, ctx: ToolContext): void {
  const cwd = ctx.cwd;
  const inside = resolved === cwd || resolved.startsWith(cwd + path.sep);
  if (inside) return;
  if (!ctx.permissions.isAllowed("glob.outside_cwd")) {
    throw new CwdEscapeError(resolved, cwd);
  }
}

function readGitignorePatterns(root: string): string[] {
  const gitignorePath = path.join(root, ".gitignore");
  if (!existsSync(gitignorePath)) return [];
  let raw: string;
  try {
    raw = readFileSync(gitignorePath, "utf8");
  } catch {
    return [];
  }
  const lines: string[] = [];
  for (const rawLine of raw.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    // Negation prefixes (`!`) are NOT supported in this minimal filter; we
    // strip the leading `!` so the pattern is at least syntactically valid for
    // tinyglobby. True gitignore semantics are out of scope for Phase 04.
    lines.push(line.startsWith("!") ? line.slice(1) : line);
  }
  return lines;
}

interface StatEntry {
  readonly file: string;
  readonly mtimeMs: number;
}

async function statAllConcurrent(files: readonly string[]): Promise<StatEntry[]> {
  const results: StatEntry[] = [];
  let cursor = 0;

  async function worker(): Promise<void> {
    while (true) {
      const idx = cursor++;
      if (idx >= files.length) return;
      const file = files[idx];
      if (file === undefined) return;
      try {
        const s = await stat(file);
        results.push({ file, mtimeMs: s.mtimeMs });
      } catch {
        // File vanished mid-glob (race) — silently skip.
      }
    }
  }

  const concurrency = Math.min(STAT_CONCURRENCY, files.length);
  const workers: Promise<void>[] = [];
  for (let i = 0; i < concurrency; i++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

export const globTool: Tool<GlobInput, GlobOutput> = {
  name: "Glob",
  description:
    "Fast file pattern matching via tinyglobby. Sorted by mtime desc. Respects .gitignore at the search root.",
  inputSchema: globSchema as JsonSchema,
  zodSchema: globInputSchema as unknown as z.ZodType<GlobInput>,
  overridesOpenCode: true,
  async handler(input, ctx) {
    const parsed = globInputSchema.parse(input);

    // Refuse `..` segments in the pattern itself — tinyglobby will resolve
    // them relative to the search cwd and escape the jail.
    if (parsed.pattern.split(/[\\/]/).some((p) => p === "..")) {
      throw new InvalidInputError("pattern must not contain .. segments", {
        pattern: parsed.pattern,
      });
    }

    const searchRoot = (() => {
      if (parsed.path === undefined) return ctx.cwd;
      return path.isAbsolute(parsed.path)
        ? path.resolve(parsed.path)
        : path.resolve(ctx.cwd, parsed.path);
    })();

    ensureInsideCwd(searchRoot, ctx);

    // Verify the search root exists + is a directory so we don't surface
    // confusing tinyglobby errors.
    if (!existsSync(searchRoot)) {
      throw new InvalidInputError("path does not exist", { path: searchRoot });
    }
    try {
      const s = statSync(searchRoot);
      if (!s.isDirectory()) {
        throw new InvalidInputError("path is not a directory", { path: searchRoot });
      }
    } catch (err) {
      if (err instanceof InvalidInputError) throw err;
      throw new InvalidInputError("path is not accessible", { path: searchRoot });
    }

    const ignorePatterns = readGitignorePatterns(searchRoot);

    const matches = await tinyGlob(parsed.pattern, {
      cwd: searchRoot,
      absolute: true,
      dot: false,
      onlyFiles: true,
      ignore: ignorePatterns,
      signal: ctx.abort,
    });

    const stats = await statAllConcurrent(matches);
    stats.sort((a, b) => b.mtimeMs - a.mtimeMs);

    ctx.logger.debug(
      { searchRoot, pattern: parsed.pattern, matched: stats.length },
      "glob.completed",
    );

    return { files: stats.map((s) => s.file) };
  },
};
