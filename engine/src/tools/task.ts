/**
 * Task tool — subagent dispatch.
 *
 * Phase 04 ships the schema-level Task tool plus a thin handler that delegates
 * to `ctx.subagents`. The real subagent engine (child OpenCode session bound
 * to a named agent, event pumping, structured summaries) lands in Phase 06.
 *
 * Until Phase 06, callers inject `stubSubagentService` (see
 * `engine/src/subagents/stub.ts`) which always throws
 * `SubagentsNotImplementedError`. If `ctx.subagents` is entirely absent, we
 * throw `SubagentsUnavailableError` so the wiring bug is obvious.
 */

import { z } from "zod";

import taskSchema from "../../../test/fixtures/tools/claude-code-schemas/task.json" with {
  type: "json",
};

import type { SubagentResult } from "../subagents/types.js";
import { type JsonSchema, SubagentsUnavailableError, type Tool } from "./types.js";

export const taskInputSchema = z.object({
  description: z.string().min(1),
  prompt: z.string().min(1),
  subagent_type: z.string().min(1),
});

export type TaskInput = z.input<typeof taskInputSchema>;
export type TaskOutput = SubagentResult;

export const taskTool: Tool<TaskInput, TaskOutput> = {
  name: "Task",
  description:
    "Dispatch work to a subagent. Phase 04 ships only the schema + a stub dispatcher; the real subagent engine lands in Phase 06. Calling Task today returns SubagentsNotImplementedError unless a real SubagentService is wired into ctx.subagents.",
  inputSchema: taskSchema as JsonSchema,
  zodSchema: taskInputSchema as unknown as z.ZodType<TaskInput>,
  overridesOpenCode: true,
  // biome-ignore lint/suspicious/useAwait: Tool.handler contract is async; handler returns the dispatcher's Promise directly.
  async handler(input, ctx) {
    const parsed = taskInputSchema.parse(input);
    if (!ctx.subagents) {
      throw new SubagentsUnavailableError();
    }
    return ctx.subagents.dispatch({
      subagent_type: parsed.subagent_type,
      description: parsed.description,
      prompt: parsed.prompt,
    });
  },
};
