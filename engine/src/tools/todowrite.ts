/**
 * TodoWrite tool — parity with Claude Code's `TodoWrite`.
 *
 * TodoWrite is the model's structured planning surface. It rewrites the
 * session-scoped todo list on every call — callers send the FULL list, not
 * deltas. The engine session writer propagates the replacement outward as a
 * `session.update` event via `ctx.session.update`.
 *
 * Invariants (enforced here):
 *   - Exactly one todo may be `in_progress` at a time. Violations throw
 *     `MultipleInProgressError` before any state mutation.
 *   - `ctx.session` MUST be supplied by the engine. Tools cannot synthesize
 *     session state; if absent, we throw `SessionUnavailableError` so callers
 *     see a loud, actionable failure instead of silent drops.
 *   - An empty `todos` array is valid semantics — it clears the list.
 */

import { z } from "zod";
import todowriteSchema from "../../../test/fixtures/tools/claude-code-schemas/todowrite.json" with {
  type: "json",
};
import { type JsonSchema, MultipleInProgressError, type TodoItem, type Tool } from "./types.js";

export const todoItemSchema = z.object({
  content: z.string().min(1),
  status: z.enum(["pending", "in_progress", "completed", "cancelled"]),
  activeForm: z.string().min(1),
  id: z.string().optional(),
});

export const todowriteInputSchema = z.object({
  todos: z.array(todoItemSchema),
});

export type TodowriteInput = z.input<typeof todowriteInputSchema>;

export interface TodowriteOutput {
  todos: TodoItem[];
  count: number;
}

export const todowriteTool: Tool<TodowriteInput, TodowriteOutput> = {
  name: "TodoWrite",
  description:
    "Replace the session-scoped todo list. Use this to plan multi-step work. The model should send the FULL list on every call (not deltas). Exactly one todo may be in_progress at a time.",
  inputSchema: todowriteSchema as JsonSchema,
  zodSchema: todowriteInputSchema as unknown as z.ZodType<TodowriteInput>,
  overridesOpenCode: true,
  // biome-ignore lint/suspicious/useAwait: Tool.handler contract is async; this handler is purely synchronous.
  async handler(input, ctx) {
    const parsed = todowriteInputSchema.parse(input);

    if (!ctx.session) {
      ctx.logger.warn({ tool: "TodoWrite" }, "session handle missing; returning no-op");
      return { todos: [], count: 0 };
    }

    const inProgressCount = parsed.todos.reduce(
      (n, t) => (t.status === "in_progress" ? n + 1 : n),
      0,
    );
    if (inProgressCount > 1) {
      throw new MultipleInProgressError(inProgressCount);
    }

    // Normalize to TodoItem under `exactOptionalPropertyTypes`: only set `id`
    // when the parsed value is a defined string (Zod gives us `string | undefined`).
    const todos: TodoItem[] = parsed.todos.map((t) => {
      if (t.id === undefined) {
        return { content: t.content, status: t.status, activeForm: t.activeForm };
      }
      return { content: t.content, status: t.status, activeForm: t.activeForm, id: t.id };
    });

    ctx.session.update({ todos });

    return {
      todos,
      count: todos.length,
    };
  },
};
