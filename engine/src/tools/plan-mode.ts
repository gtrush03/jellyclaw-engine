/**
 * EnterPlanMode / ExitPlanMode tools (T3-03).
 *
 * These tools allow the model to toggle plan mode mid-session. When active,
 * plan mode blocks every side-effectful tool so the assistant drafts a plan
 * before touching anything.
 *
 * Implementation:
 * - `EnterPlanMode` snapshots the current mode, sets mode to "plan", returns
 *   confirmation with the plan text.
 * - `ExitPlanMode` restores the snapshotted prior mode (or "default" if none),
 *   returns confirmation.
 *
 * The prior-mode snapshots are stored in a module-level Map keyed by sessionId.
 * Snapshots do NOT nest beyond depth 1 — calling enter-enter-exit restores
 * the original prior mode once; the second enter snapshots fresh.
 */

import { z } from "zod";
import type { JsonSchema, Tool } from "./types.js";

// ---------------------------------------------------------------------------
// Module-level prior-mode snapshots (per sessionId, non-nesting)
// ---------------------------------------------------------------------------

const priorModeSnapshots = new Map<string, "default" | "acceptEdits" | "bypassPermissions">();

/**
 * Exported for tests: clear all snapshots.
 */
export function _resetPriorModeSnapshots(): void {
  priorModeSnapshots.clear();
}

// ---------------------------------------------------------------------------
// EnterPlanMode
// ---------------------------------------------------------------------------

export const enterPlanModeInputSchema = z.object({
  plan: z.string().optional(),
});

export type EnterPlanModeInput = z.input<typeof enterPlanModeInputSchema>;

export const enterPlanModeJsonSchema: JsonSchema = {
  type: "object",
  properties: {
    plan: {
      type: "string",
      description: "The plan to present to the user.",
    },
  },
  required: [],
  additionalProperties: false,
};

export const enterPlanModeTool: Tool<EnterPlanModeInput, string> = {
  name: "EnterPlanMode",
  description:
    "Enter plan mode. When active, all side-effectful tools (Write, Edit, Bash, etc.) are blocked so you can draft a plan before making changes.",
  inputSchema: enterPlanModeJsonSchema,
  zodSchema: enterPlanModeInputSchema as unknown as z.ZodType<EnterPlanModeInput>,
  overridesOpenCode: false,
  // biome-ignore lint/suspicious/useAwait: async contract required by Tool interface
  async handler(input, ctx) {
    const parsed = enterPlanModeInputSchema.parse(input);

    const controller = ctx.permissions.getModeController?.();
    if (!controller) {
      return "plan mode not available — no mode controller configured";
    }

    const current = controller.current();

    // Only snapshot if not already in plan mode (no nesting beyond depth 1).
    if (current !== "plan") {
      priorModeSnapshots.set(ctx.sessionId, current);
    }

    controller.set("plan");

    const planText = parsed.plan ?? "";
    const planSection = planText.length > 0 ? `\n\nPlan:\n${planText}` : "";

    return `plan mode entered — all side-effectful tools now blocked${planSection}`;
  },
};

// ---------------------------------------------------------------------------
// ExitPlanMode
// ---------------------------------------------------------------------------

export const exitPlanModeInputSchema = z.object({});

export type ExitPlanModeInput = z.input<typeof exitPlanModeInputSchema>;

export const exitPlanModeJsonSchema: JsonSchema = {
  type: "object",
  properties: {},
  required: [],
  additionalProperties: false,
};

export const exitPlanModeTool: Tool<ExitPlanModeInput, string> = {
  name: "ExitPlanMode",
  description:
    "Exit plan mode and restore the previous permission mode. Side-effectful tools will be allowed again according to the restored mode.",
  inputSchema: exitPlanModeJsonSchema,
  zodSchema: exitPlanModeInputSchema as unknown as z.ZodType<ExitPlanModeInput>,
  overridesOpenCode: false,
  // biome-ignore lint/suspicious/useAwait: async contract required by Tool interface
  async handler(_input, ctx) {
    const controller = ctx.permissions.getModeController?.();
    if (!controller) {
      return "plan mode not available — no mode controller configured";
    }

    const prior = priorModeSnapshots.get(ctx.sessionId) ?? "default";
    priorModeSnapshots.delete(ctx.sessionId);

    controller.set(prior);

    return `plan mode exited; restored to ${prior}`;
  },
};
