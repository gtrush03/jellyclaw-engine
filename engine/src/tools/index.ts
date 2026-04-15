/**
 * jellyclaw built-in tool registry.
 *
 * Every tool mirrors the Claude Code published schema byte-for-byte (see
 * `test/fixtures/tools/claude-code-schemas/*.json`) and is implemented on top
 * of the jellyclaw sandbox (cwd jail, read-cache, permission gate).
 *
 * Phase 04 — Prompt 01 lands Bash, Read, Write. Remaining prompts (Edit /
 * Glob / Grep / WebFetch / TodoWrite / Task / NotebookEdit) append to this
 * registry.
 */

import { bashTool } from "./bash.js";
import { editTool } from "./edit.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { readTool } from "./read.js";
import type { Tool } from "./types.js";
import { writeTool } from "./write.js";

export const builtinTools: readonly Tool<unknown, unknown>[] = [
  bashTool as Tool<unknown, unknown>,
  editTool as Tool<unknown, unknown>,
  globTool as Tool<unknown, unknown>,
  grepTool as Tool<unknown, unknown>,
  readTool as Tool<unknown, unknown>,
  writeTool as Tool<unknown, unknown>,
];

export function listTools(): readonly Tool<unknown, unknown>[] {
  return builtinTools;
}

export function getTool(name: string): Tool<unknown, unknown> | undefined {
  return builtinTools.find((t) => t.name === name);
}

export { bashTool } from "./bash.js";
export { editTool } from "./edit.js";
export { globTool } from "./glob.js";
export { grepTool } from "./grep.js";
export { allowAll, denyAll, fromMap } from "./permissions.js";
export { readTool } from "./read.js";
export * from "./types.js";
export { writeTool } from "./write.js";
