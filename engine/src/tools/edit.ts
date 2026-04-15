/**
 * Edit tool — parity with Claude Code's `Edit`.
 *
 * Performs an exact-string replacement inside a file. Requires the file to
 * have been Read in this session (same invariant as Write). Refuses to create
 * files; refuses no-op edits; refuses ambiguous matches unless `replace_all`
 * is set.
 *
 * Writes are atomic via `<path>.jellyclaw.tmp` → rename. On failure the
 * temp file is cleaned up and the original is left untouched.
 */

import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, resolve, sep } from "node:path";
import { createPatch } from "diff";
import { z } from "zod";

import editSchema from "../../../test/fixtures/tools/claude-code-schemas/edit.json" with {
  type: "json",
};

import { explainMissingMatch } from "./edit-diagnostics.js";
import {
  AmbiguousMatchError,
  CwdEscapeError,
  EditRequiresReadError,
  InvalidInputError,
  type JsonSchema,
  NoMatchError,
  NoOpEditError,
  type Tool,
  type ToolContext,
} from "./types.js";

export const editInputSchema = z.object({
  file_path: z.string().min(1),
  old_string: z.string(),
  new_string: z.string(),
  replace_all: z.boolean().default(false),
});

export type EditInput = z.input<typeof editInputSchema>;

export interface EditOutput {
  file_path: string;
  occurrences_replaced: number;
  diff_preview: string;
}

function ensureInsideCwd(resolved: string, ctx: ToolContext): void {
  const cwd = ctx.cwd;
  const inside = resolved === cwd || resolved.startsWith(cwd + sep);
  if (inside) return;
  if (!ctx.permissions.isAllowed("edit.outside_cwd")) {
    throw new CwdEscapeError(resolved, cwd);
  }
}

function buildDiffPreview(path: string, before: string, after: string): string {
  const patch = createPatch(basename(path), before, after, "", "", { context: 2 });
  // Strip the 4-line header produced by createPatch:
  //   Index: <name>
  //   ===================================================================
  //   --- <name>
  //   +++ <name>
  // Then take the next 6 content lines.
  const lines = patch.split("\n");
  const body = lines.slice(4, 10);
  return body.join("\n");
}

export const editTool: Tool<EditInput, EditOutput> = {
  name: "Edit",
  description:
    "Replace an exact string in a file at an absolute path. Requires the file to have been Read in this session. Refuses to create files (use Write). Refuses no-op edits and ambiguous matches unless replace_all is set. Writes are atomic via rename.",
  inputSchema: editSchema as JsonSchema,
  zodSchema: editInputSchema as unknown as z.ZodType<EditInput>,
  overridesOpenCode: true,
  // biome-ignore lint/suspicious/useAwait: Tool.handler contract is async; body is fully synchronous fs I/O wrapped in a Promise.
  async handler(input, ctx) {
    const parsed = editInputSchema.parse(input);

    if (!isAbsolute(parsed.file_path)) {
      throw new InvalidInputError("file_path must be absolute", { file_path: parsed.file_path });
    }

    const absPath = resolve(parsed.file_path);

    ensureInsideCwd(absPath, ctx);

    if (!ctx.readCache.has(absPath)) {
      throw new EditRequiresReadError(absPath);
    }

    if (!existsSync(absPath)) {
      throw new InvalidInputError("Edit cannot create files; use Write", { path: absPath });
    }

    if (parsed.old_string === parsed.new_string) {
      throw new NoOpEditError(absPath);
    }

    if (parsed.replace_all && parsed.old_string === "") {
      throw new InvalidInputError(
        "replace_all with empty old_string is not allowed (infinite match)",
        { path: absPath },
      );
    }

    const content = readFileSync(absPath, "utf8");
    const count = content.split(parsed.old_string).length - 1;

    if (!parsed.replace_all) {
      if (count === 0) {
        throw new NoMatchError(
          absPath,
          parsed.old_string.slice(0, 120),
          explainMissingMatch(content, parsed.old_string),
        );
      }
      if (count > 1) {
        throw new AmbiguousMatchError(absPath, count);
      }
    } else if (count === 0) {
      throw new NoMatchError(
        absPath,
        parsed.old_string.slice(0, 120),
        explainMissingMatch(content, parsed.old_string),
      );
    }

    let result: string;
    let occurrences: number;
    if (parsed.replace_all) {
      result = content.split(parsed.old_string).join(parsed.new_string);
      occurrences = count;
    } else {
      const idx = content.indexOf(parsed.old_string);
      result =
        content.slice(0, idx) + parsed.new_string + content.slice(idx + parsed.old_string.length);
      occurrences = 1;
    }

    // Preserve EOF newline characteristics of the original file.
    const originalEndsNl = content.endsWith("\n");
    const resultEndsNl = result.endsWith("\n");
    if (originalEndsNl && !resultEndsNl) {
      result = `${result}\n`;
    } else if (!originalEndsNl && resultEndsNl) {
      result = result.slice(0, -1);
    }

    const tmpPath = `${absPath}.jellyclaw.tmp`;
    try {
      writeFileSync(tmpPath, result, "utf8");
      renameSync(tmpPath, absPath);
    } catch (err) {
      try {
        if (existsSync(tmpPath)) rmSync(tmpPath, { force: true });
      } catch {
        // swallow
      }
      throw err;
    }

    const diff_preview = buildDiffPreview(absPath, content, result);

    return {
      file_path: absPath,
      occurrences_replaced: occurrences,
      diff_preview,
    };
  },
};
