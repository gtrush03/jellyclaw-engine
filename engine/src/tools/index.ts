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

import type { SkillRegistry } from "../skills/registry.js";
import { askUserQuestionTool } from "./ask-user-question.js";
import { bashTool } from "./bash.js";
import { cronCreateTool, cronDeleteTool, cronListTool } from "./cron.js";
import { editTool } from "./edit.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { memoryTool } from "./memory.js";
import { monitorListTool, monitorStopTool, monitorTool } from "./monitor.js";
import { notebookEditTool } from "./notebook-edit.js";
import { enterPlanModeTool, exitPlanModeTool } from "./plan-mode.js";
import { readTool } from "./read.js";
import { scheduleWakeupTool } from "./schedule-wakeup.js";
import { createSkillTool } from "./skill.js";
import { taskTool } from "./task.js";
import { teamCreateTool, teamDeleteTool } from "./team.js";
import { todowriteTool } from "./todowrite.js";
import type { Tool } from "./types.js";
import { webfetchTool } from "./webfetch.js";
import { writeTool } from "./write.js";

export const builtinTools: readonly Tool<unknown, unknown>[] = [
  askUserQuestionTool as Tool<unknown, unknown>,
  bashTool as Tool<unknown, unknown>,
  cronCreateTool as Tool<unknown, unknown>,
  cronDeleteTool as Tool<unknown, unknown>,
  cronListTool as Tool<unknown, unknown>,
  editTool as Tool<unknown, unknown>,
  enterPlanModeTool as Tool<unknown, unknown>,
  exitPlanModeTool as Tool<unknown, unknown>,
  globTool as Tool<unknown, unknown>,
  grepTool as Tool<unknown, unknown>,
  memoryTool as Tool<unknown, unknown>,
  monitorTool as Tool<unknown, unknown>,
  monitorStopTool as Tool<unknown, unknown>,
  monitorListTool as Tool<unknown, unknown>,
  notebookEditTool as Tool<unknown, unknown>,
  readTool as Tool<unknown, unknown>,
  scheduleWakeupTool as Tool<unknown, unknown>,
  taskTool as Tool<unknown, unknown>,
  teamCreateTool as Tool<unknown, unknown>,
  teamDeleteTool as Tool<unknown, unknown>,
  todowriteTool as Tool<unknown, unknown>,
  webfetchTool as Tool<unknown, unknown>,
  writeTool as Tool<unknown, unknown>,
];

export function listTools(): readonly Tool<unknown, unknown>[] {
  return builtinTools;
}

/**
 * Build the complete tool list, optionally including the Skill tool.
 * The Skill tool is only registered when there are discovered skills.
 */
export function buildToolList(registry?: SkillRegistry): readonly Tool<unknown, unknown>[] {
  if (registry === undefined || registry.size() === 0) {
    return builtinTools;
  }
  return [...builtinTools, createSkillTool(registry) as Tool<unknown, unknown>];
}

export function getTool(name: string): Tool<unknown, unknown> | undefined {
  return builtinTools.find((t) => t.name === name);
}

export { askUserQuestionTool } from "./ask-user-question.js";
export { bashTool } from "./bash.js";
// Scheduling tools (T4-02)
export { cronCreateTool, cronDeleteTool, cronListTool } from "./cron.js";
export { editTool } from "./edit.js";
export { globTool } from "./glob.js";
export { grepTool } from "./grep.js";
export { memoryTool } from "./memory.js";
// Monitor tools (T4-04)
export { monitorListTool, monitorStopTool, monitorTool } from "./monitor.js";
export { notebookEditTool } from "./notebook-edit.js";
export { allowAll, denyAll, fromMap } from "./permissions.js";
export { enterPlanModeTool, exitPlanModeTool } from "./plan-mode.js";
export { readTool } from "./read.js";
export { scheduleWakeupTool } from "./schedule-wakeup.js";
export { taskTool } from "./task.js";
export { teamCreateTool, teamDeleteTool } from "./team.js";
export { todowriteTool } from "./todowrite.js";
export * from "./types.js";
export { webfetchTool } from "./webfetch.js";
// WebSearch intentionally absent from builtinTools — provided via
// the default Exa MCP instead. See docs/tools.md and T5-02.
export { writeTool } from "./write.js";
