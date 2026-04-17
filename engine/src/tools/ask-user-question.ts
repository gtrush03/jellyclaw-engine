/**
 * AskUserQuestion tool — parity with Claude Code's `AskUserQuestion`.
 *
 * Allows the model to pause and ask the user a clarifying question. The user's
 * response is returned as the tool result, enabling back-and-forth dialogue
 * within the agent loop.
 *
 * This tool always goes through the ask permission path (via INTERACTIVE_TOOLS
 * in permissions/types.ts) and never auto-allows or auto-denies based on rules.
 */

import { z } from "zod";
import type { AskUserResult, JsonSchema, Tool } from "./types.js";

export const askUserQuestionInputSchema = z.object({
  question: z.string().min(1, "question must be non-empty"),
  options: z.array(z.string()).optional(),
});

export type AskUserQuestionInput = z.input<typeof askUserQuestionInputSchema>;

export const askUserQuestionJsonSchema: JsonSchema = {
  type: "object",
  properties: {
    question: {
      type: "string",
      description: "The question to ask the user.",
    },
    options: {
      type: "array",
      items: { type: "string" },
      description: "Optional multiple-choice options.",
    },
  },
  required: ["question"],
  additionalProperties: false,
};

export const askUserQuestionTool: Tool<AskUserQuestionInput, string> = {
  name: "AskUserQuestion",
  description:
    "Ask the user a clarifying question. Use this when you need more information to proceed.",
  inputSchema: askUserQuestionJsonSchema,
  zodSchema: askUserQuestionInputSchema as unknown as z.ZodType<AskUserQuestionInput>,
  overridesOpenCode: false,
  async handler(input, ctx) {
    const parsed = askUserQuestionInputSchema.parse(input);

    // Use the permission service's askForAnswer method if available.
    if (ctx.permissions.askForAnswer) {
      const result = await ctx.permissions.askForAnswer(parsed.question, parsed.options);
      return formatResult(result);
    }

    // Fallback: no ask handler configured.
    return "<no answer — request was deny>";
  },
};

function formatResult(result: AskUserResult): string {
  if (typeof result === "object" && result.kind === "answer") {
    return result.text;
  }
  return `<no answer — request was ${result}>`;
}
