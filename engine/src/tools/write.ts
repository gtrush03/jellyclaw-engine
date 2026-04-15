/**
 * Write tool — parity with Claude Code's `Write`.
 *
 * Creates or overwrites a file with the given content. Enforces the
 * "read-before-overwrite" invariant: overwriting an existing file requires
 * the model to have Read it in this session (tracked via `ctx.readCache`).
 *
 * Writes are atomic: content lands in `<path>.jellyclaw.tmp` and is renamed
 * into place. Trailing newline of the prior file is preserved automatically
 * (matching Claude Code behaviour).
 */

import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";

import writeSchema from "../../../test/fixtures/tools/claude-code-schemas/write.json" with {
  type: "json",
};

import {
  CwdEscapeError,
  InvalidInputError,
  type JsonSchema,
  type Tool,
  WriteRequiresReadError,
} from "./types.js";

export const writeInputSchema = z.object({
  file_path: z.string().min(1, "file_path must be non-empty"),
  content: z.string(),
});

export interface WriteInput {
  file_path: string;
  content: string;
}

export interface WriteOutput {
  bytes_written: number;
  created: boolean;
}

function isInsideCwd(absPath: string, cwd: string): boolean {
  const normalizedCwd = resolve(cwd);
  const rel = resolve(absPath);
  return rel === normalizedCwd || rel.startsWith(`${normalizedCwd}/`);
}

export const writeTool: Tool<WriteInput, WriteOutput> = {
  name: "Write",
  description:
    "Write content to a file at an absolute path. Creates a new file or overwrites an existing one. Existing files must be Read in this session before they can be overwritten. Writes are atomic via rename.",
  inputSchema: writeSchema as JsonSchema,
  zodSchema: writeInputSchema as unknown as z.ZodType<WriteInput>,
  overridesOpenCode: true,
  // biome-ignore lint/suspicious/useAwait: Tool.handler contract is async; body is fully synchronous fs I/O wrapped in a Promise.
  async handler(input, ctx) {
    const parsed = writeInputSchema.parse(input);

    if (!isAbsolute(parsed.file_path)) {
      throw new InvalidInputError("file_path must be absolute", { file_path: parsed.file_path });
    }

    const absPath = resolve(parsed.file_path);

    if (!isInsideCwd(absPath, ctx.cwd) && !ctx.permissions.isAllowed("write.outside_cwd")) {
      throw new CwdEscapeError(absPath, ctx.cwd);
    }

    const parentDir = dirname(absPath);
    if (!existsSync(parentDir)) {
      throw new InvalidInputError("Parent directory does not exist", { dir: parentDir });
    }

    const fileExists = existsSync(absPath);

    if (fileExists && !ctx.readCache.has(absPath)) {
      throw new WriteRequiresReadError(absPath);
    }

    // Preserve trailing newline of existing file if content is missing one.
    let finalContent = parsed.content;
    if (fileExists) {
      try {
        const existing = readFileSync(absPath, "utf8");
        if (existing.endsWith("\n") && !finalContent.endsWith("\n") && finalContent.length > 0) {
          finalContent = `${finalContent}\n`;
          ctx.logger.debug({ path: absPath }, "write.trailing_newline_preserved");
        }
      } catch (err) {
        ctx.logger.debug({ path: absPath, err }, "write.read_existing_failed");
      }
    }

    // TODO: StaleReadError detection requires readCache to track mtime
    // (Map<string, mtimeMs>). Skipped in Phase 04; current readCache is
    // Set<string>. Revisit when readCache gains mtime support.

    const tmpPath = `${absPath}.jellyclaw.tmp`;
    try {
      writeFileSync(tmpPath, finalContent, "utf8");
      renameSync(tmpPath, absPath);
    } catch (err) {
      // Best-effort cleanup of the temp file; never mask the original error.
      try {
        if (existsSync(tmpPath)) rmSync(tmpPath, { force: true });
      } catch {
        // swallow
      }
      throw err;
    }

    ctx.readCache.add(absPath);

    return {
      bytes_written: Buffer.byteLength(finalContent, "utf8"),
      created: !fileExists,
    };
  },
};
