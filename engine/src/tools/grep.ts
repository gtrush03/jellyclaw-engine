/**
 * Grep tool — parity with Claude Code's `Grep`.
 *
 * Wraps the bundled ripgrep binary (`@vscode/ripgrep`) with a typed contract:
 *   - argv is always an array (never a shell string), so model-supplied
 *     patterns containing shell metacharacters cannot escape into the shell.
 *   - The search root is jailed to `ctx.cwd` unless `grep.outside_cwd` is
 *     allowed.
 *   - Output is bounded at 50,000 JSON-serialized characters; entries are
 *     trimmed from the tail until the cap is satisfied, with `truncated: true`
 *     surfaced to the caller.
 *
 * Output mode shapes are a discriminated union (`mode: "content" | …`) so
 * downstream consumers do not have to inspect optional fields to decide which
 * shape they got.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { rgPath } from "@vscode/ripgrep";
import { z } from "zod";

import grepSchema from "../../../test/fixtures/tools/claude-code-schemas/grep.json" with {
  type: "json",
};

import { ensureWithinAllowedRoots } from "./permissions.js";
import { type JsonSchema, type Tool, type ToolContext, ToolError } from "./types.js";

const MAX_OUTPUT_CHARS = 50_000;
const MAX_CONTEXT = 50;

export const grepInputSchema = z.object({
  pattern: z.string().min(1, "pattern must be non-empty"),
  path: z.string().optional(),
  glob: z.string().optional(),
  type: z.string().optional(),
  output_mode: z.enum(["content", "files_with_matches", "count"]).default("files_with_matches"),
  "-i": z.boolean().optional(),
  "-n": z.boolean().optional(),
  "-A": z.number().int().min(0).max(MAX_CONTEXT).optional(),
  "-B": z.number().int().min(0).max(MAX_CONTEXT).optional(),
  "-C": z.number().int().min(0).max(MAX_CONTEXT).optional(),
  context: z.number().int().min(0).max(MAX_CONTEXT).optional(),
  multiline: z.boolean().optional(),
  head_limit: z.number().int().min(1).optional(),
  offset: z.number().int().min(0).optional(),
});

export type GrepInput = z.input<typeof grepInputSchema>;

export type GrepOutput =
  | {
      mode: "content";
      matches: Array<{
        path: string;
        line_number: number;
        line: string;
        is_context?: boolean;
      }>;
      truncated?: boolean;
    }
  | { mode: "files_with_matches"; files: string[]; truncated?: boolean }
  | { mode: "count"; counts: Array<{ path: string; count: number }>; truncated?: boolean };

interface RgRun {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

function ensureInsideCwd(resolved: string, ctx: ToolContext): void {
  ensureWithinAllowedRoots(resolved, ctx, "grep.outside_cwd");
}

function ensureRgBinary(): void {
  if (!existsSync(rgPath)) {
    throw new ToolError(
      "RipgrepMissing",
      `ripgrep binary not found at ${rgPath}. run \`bun install\` with network access to download the @vscode/ripgrep binary.`,
      { rgPath },
    );
  }
}

function buildArgv(parsed: z.infer<typeof grepInputSchema>, searchRoot: string): string[] {
  const argv: string[] = [];

  switch (parsed.output_mode) {
    case "content":
      argv.push("--json");
      break;
    case "files_with_matches":
      argv.push("--files-with-matches");
      break;
    case "count":
      argv.push("--count-matches");
      break;
  }

  if (parsed["-i"]) argv.push("--ignore-case");

  if (parsed.output_mode === "content") {
    // Default `-n` to true in content mode unless the caller explicitly
    // passes `false`.
    if (parsed["-n"] !== false) argv.push("--line-number");
  }

  if (parsed["-A"] !== undefined) argv.push("--after-context", String(parsed["-A"]));
  if (parsed["-B"] !== undefined) argv.push("--before-context", String(parsed["-B"]));
  // -C and `context` are aliases. Prefer -C if both are present.
  const ctxN = parsed["-C"] ?? parsed.context;
  if (ctxN !== undefined) argv.push("--context", String(ctxN));

  if (parsed.multiline) argv.push("--multiline", "--multiline-dotall");
  if (parsed.glob !== undefined) argv.push("--glob", parsed.glob);
  if (parsed.type !== undefined) argv.push("--type", parsed.type);

  // `--` terminates rg flags so a pattern starting with `-` is not parsed
  // as a flag.
  argv.push("--", parsed.pattern, searchRoot);
  return argv;
}

function runRg(argv: string[], cwd: string, abort: AbortSignal): Promise<RgRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(rgPath, argv, { cwd, signal: abort });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      const e = err as NodeJS.ErrnoException;
      if (e.name === "AbortError") {
        reject(new ToolError("Aborted", "Grep aborted", {}));
        return;
      }
      reject(new ToolError("SpawnFailed", e.message, {}));
    });

    child.on("close", (code) => {
      resolve({ stdout, stderr, code: code ?? 0 });
    });
  });
}

interface ContentMatch {
  path: string;
  line_number: number;
  line: string;
  is_context?: boolean;
}

interface RgJsonFrame {
  type: string;
  data?: {
    path?: { text?: string };
    line_number?: number;
    lines?: { text?: string };
  };
}

function parseContentJson(stdout: string): ContentMatch[] {
  const out: ContentMatch[] = [];
  // Buffer trailing partial lines defensively — even though we have full
  // stdout buffered, individual frames are still newline-delimited and we
  // should ignore a final empty trailing line.
  for (const raw of stdout.split("\n")) {
    if (raw === "") continue;
    let frame: RgJsonFrame;
    try {
      frame = JSON.parse(raw) as RgJsonFrame;
    } catch {
      continue;
    }
    if (frame.type !== "match" && frame.type !== "context") continue;
    const data = frame.data;
    if (!data) continue;
    const p = data.path?.text;
    const ln = data.line_number;
    const text = data.lines?.text;
    if (typeof p !== "string" || typeof ln !== "number" || typeof text !== "string") continue;
    const entry: ContentMatch = {
      path: p,
      line_number: ln,
      line: text.replace(/\r?\n$/, ""),
    };
    if (frame.type === "context") entry.is_context = true;
    out.push(entry);
  }
  return out;
}

function parseFilesWithMatches(stdout: string): string[] {
  const out: string[] = [];
  for (const raw of stdout.split("\n")) {
    if (raw === "") continue;
    out.push(raw);
  }
  return out;
}

function parseCounts(stdout: string): Array<{ path: string; count: number }> {
  const out: Array<{ path: string; count: number }> = [];
  for (const raw of stdout.split("\n")) {
    if (raw === "") continue;
    // rg --count-matches emits `path:N`. Path may itself contain `:` on
    // unusual filesystems; split on the LAST colon.
    const idx = raw.lastIndexOf(":");
    if (idx <= 0) continue;
    const p = raw.slice(0, idx);
    const n = Number.parseInt(raw.slice(idx + 1), 10);
    if (!Number.isFinite(n)) continue;
    out.push({ path: p, count: n });
  }
  return out;
}

function applyWindow<T>(items: T[], offset: number | undefined, head: number | undefined): T[] {
  let out = items;
  if (typeof offset === "number" && offset > 0) out = out.slice(offset);
  if (typeof head === "number") out = out.slice(0, head);
  return out;
}

function shrinkUntilFits<T>(
  build: (entries: T[], truncated: boolean) => GrepOutput,
  entries: T[],
): GrepOutput {
  // Fast path: full set fits.
  const full = build(entries, false);
  if (JSON.stringify(full).length <= MAX_OUTPUT_CHARS) return full;

  // Binary search the largest prefix length that still serializes within
  // the cap. O(log n) JSON.stringify calls instead of O(n).
  let lo = 0;
  let hi = entries.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    const candidate = build(entries.slice(0, mid), true);
    if (JSON.stringify(candidate).length <= MAX_OUTPUT_CHARS) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return build(entries.slice(0, lo), true);
}

export const grepTool: Tool<GrepInput, GrepOutput> = {
  name: "Grep",
  description:
    "Powerful content search via the bundled ripgrep binary. Supports regex, globs, file types, context lines, and three output modes (content / files_with_matches / count).",
  inputSchema: grepSchema as JsonSchema,
  zodSchema: grepInputSchema as unknown as z.ZodType<GrepInput>,
  overridesOpenCode: true,
  async handler(input, ctx) {
    const parsed = grepInputSchema.parse(input);

    ensureRgBinary();

    const searchRoot = (() => {
      if (parsed.path === undefined) return ctx.cwd;
      return path.isAbsolute(parsed.path)
        ? path.resolve(parsed.path)
        : path.resolve(ctx.cwd, parsed.path);
    })();

    ensureInsideCwd(searchRoot, ctx);

    const argv = buildArgv(parsed, searchRoot);
    const run = await runRg(argv, ctx.cwd, ctx.abort);

    if (run.code >= 2) {
      throw new ToolError("GrepFailed", run.stderr.trim() || `ripgrep exited ${run.code}`, {
        code: run.code,
      });
    }

    // exit 1 = no matches → return an empty result for the chosen mode.
    switch (parsed.output_mode) {
      case "content": {
        const all = parseContentJson(run.stdout);
        const windowed = applyWindow(all, parsed.offset, parsed.head_limit);
        return shrinkUntilFits<ContentMatch>(
          (entries, truncated) =>
            truncated
              ? { mode: "content", matches: entries, truncated: true }
              : { mode: "content", matches: entries },
          windowed,
        );
      }
      case "files_with_matches": {
        const all = parseFilesWithMatches(run.stdout);
        const windowed = applyWindow(all, parsed.offset, parsed.head_limit);
        return shrinkUntilFits<string>(
          (entries, truncated) =>
            truncated
              ? { mode: "files_with_matches", files: entries, truncated: true }
              : { mode: "files_with_matches", files: entries },
          windowed,
        );
      }
      case "count": {
        const all = parseCounts(run.stdout);
        const windowed = applyWindow(all, parsed.offset, parsed.head_limit);
        return shrinkUntilFits<{ path: string; count: number }>(
          (entries, truncated) =>
            truncated
              ? { mode: "count", counts: entries, truncated: true }
              : { mode: "count", counts: entries },
          windowed,
        );
      }
    }
  },
};
