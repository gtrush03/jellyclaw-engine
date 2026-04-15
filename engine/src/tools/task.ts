/**
 * Task tool — subagent dispatch.
 *
 * Phase 04 shipped a schema-level Task tool that delegated to `ctx.subagents`
 * and threw on misconfiguration. Phase 06 Prompt 02 moves to **graceful
 * error results**: the handler never throws. Every failure path (missing
 * `ctx.subagents`, invalid input, dispatcher errors) is mapped to a
 * `SubagentResult`-shaped payload with `status: "error"` so the parent
 * turn can continue without propagating an exception into the engine.
 */

import { z } from "zod";

import taskSchema from "../../../test/fixtures/tools/claude-code-schemas/task.json" with {
  type: "json",
};

import type { SubagentResult, SubagentUsage } from "../subagents/types.js";
import type { JsonSchema, Tool } from "./types.js";

export const taskInputSchema = z.object({
  description: z.string().min(1),
  prompt: z.string().min(1),
  subagent_type: z.string().min(1),
});

export type TaskInput = z.input<typeof taskInputSchema>;
export type TaskOutput = SubagentResult;

const ZERO_USAGE: SubagentUsage = Object.freeze({
  input_tokens: 0,
  output_tokens: 0,
});

function errorResult(summary: string): SubagentResult {
  return { summary, status: "error", usage: ZERO_USAGE };
}

export const taskTool: Tool<TaskInput, TaskOutput> = {
  name: "Task",
  description:
    "Dispatch a specialized subagent to perform a focused task with isolated context. Returns { summary, status, usage }. Errors surface as { status: 'error' } results — the handler never throws so the parent turn can continue.",
  inputSchema: taskSchema as JsonSchema,
  zodSchema: taskInputSchema as unknown as z.ZodType<TaskInput>,
  overridesOpenCode: true,
  async handler(input, ctx) {
    // 1. Parse input — on failure, return a graceful error result.
    const parsed = taskInputSchema.safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path = issue?.path.join(".") || "<root>";
      const message = issue?.message ?? "invalid input";
      ctx.logger.warn(
        { tool: "Task", issues: parsed.error.issues },
        "Task tool received invalid input",
      );
      return errorResult(`invalid_input: ${path}: ${message}`);
    }

    // 2. Missing subagent service is a wiring bug — log loudly, but do
    //    not throw. The parent turn sees a normal error tool result.
    if (!ctx.subagents) {
      ctx.logger.warn(
        { tool: "Task" },
        "Task tool invoked without ctx.subagents; returning graceful error",
      );
      return errorResult("subagents_unavailable: ctx.subagents is not wired");
    }

    // 3. Delegate. Catch any unexpected throw from the dispatcher and
    //    wrap it — real dispatchers never throw, but stubs / future
    //    adapters might.
    try {
      return await ctx.subagents.dispatch({
        subagent_type: parsed.data.subagent_type,
        description: parsed.data.description,
        prompt: parsed.data.prompt,
      });
    } catch (err) {
      const message = (err as Error)?.message ?? "unknown";
      ctx.logger.warn({ err, tool: "Task" }, "Task tool dispatcher threw; mapping to error result");
      return errorResult(`dispatch_error: ${message}`);
    }
  },
};
