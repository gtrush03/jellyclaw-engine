/**
 * Unit tests for the Task subagent-dispatch tool.
 */

import { describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";

import { createLogger } from "../../../engine/src/logger.js";
import { stubSubagentService } from "../../../engine/src/subagents/stub.js";
import type { SubagentResult, SubagentService } from "../../../engine/src/subagents/types.js";
import { getTool } from "../../../engine/src/tools/index.js";
import { allowAll } from "../../../engine/src/tools/permissions.js";
import { taskTool } from "../../../engine/src/tools/task.js";
import {
  SubagentsNotImplementedError,
  SubagentsUnavailableError,
  type ToolContext,
} from "../../../engine/src/tools/types.js";
import taskSchema from "../../fixtures/tools/claude-code-schemas/task.json" with { type: "json" };

function makeCtx(subagents?: SubagentService): ToolContext {
  const base: ToolContext = {
    cwd: process.cwd(),
    sessionId: "test-session",
    readCache: new Set<string>(),
    abort: new AbortController().signal,
    logger: createLogger({ level: "silent" }),
    permissions: allowAll,
  };
  if (subagents) {
    return { ...base, subagents };
  }
  return base;
}

const validInput = {
  description: "do thing",
  prompt: "please do the thing in detail",
  subagent_type: "general-purpose",
};

describe("taskTool — dispatcher behavior", () => {
  it("with stubSubagentService throws SubagentsNotImplementedError mentioning Phase 06 and subagent dispatch", async () => {
    try {
      await taskTool.handler(validInput, makeCtx(stubSubagentService));
      expect.unreachable("handler should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SubagentsNotImplementedError);
      const msg = (err as Error).message;
      expect(msg).toContain("Phase 06");
      expect(msg).toMatch(/subagent dispatch/i);
    }
  });

  it("delegates to ctx.subagents.dispatch and returns its result verbatim", async () => {
    const result: SubagentResult = {
      summary: "done",
      status: "success",
      usage: { input_tokens: 10, output_tokens: 20 },
    };
    const dispatch = vi.fn().mockResolvedValue(result);
    const out = await taskTool.handler(validInput, makeCtx({ dispatch }));
    expect(out).toBe(result);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({
      subagent_type: validInput.subagent_type,
      description: validInput.description,
      prompt: validInput.prompt,
    });
  });

  it("propagates rejected-promise errors from the dispatcher", async () => {
    const boom = new Error("dispatch blew up");
    const dispatch = vi.fn().mockRejectedValue(boom);
    await expect(taskTool.handler(validInput, makeCtx({ dispatch }))).rejects.toBe(boom);
  });

  it("throws SubagentsUnavailableError when ctx.subagents is missing", async () => {
    await expect(taskTool.handler(validInput, makeCtx())).rejects.toBeInstanceOf(
      SubagentsUnavailableError,
    );
  });
});

describe("taskTool — schema validation", () => {
  it("rejects input missing subagent_type", async () => {
    await expect(
      taskTool.handler(
        { description: "x", prompt: "y" } as unknown as typeof validInput,
        makeCtx(stubSubagentService),
      ),
    ).rejects.toBeInstanceOf(ZodError);
  });

  it("rejects input missing prompt", async () => {
    await expect(
      taskTool.handler(
        { description: "x", subagent_type: "general-purpose" } as unknown as typeof validInput,
        makeCtx(stubSubagentService),
      ),
    ).rejects.toBeInstanceOf(ZodError);
  });

  it("rejects empty strings", async () => {
    await expect(
      taskTool.handler(
        { description: "", prompt: "", subagent_type: "" },
        makeCtx(stubSubagentService),
      ),
    ).rejects.toBeInstanceOf(ZodError);
  });
});

describe("taskTool — schema parity + registry", () => {
  it("inputSchema deep-equals the claude-code JSON fixture", () => {
    expect(taskTool.inputSchema).toEqual(taskSchema);
  });

  it("is registered in the builtin registry under 'Task'", () => {
    expect(getTool("Task")).toBe(taskTool);
  });

  it("overridesOpenCode is true and name is exactly 'Task'", () => {
    expect(taskTool.name).toBe("Task");
    expect(taskTool.overridesOpenCode).toBe(true);
  });
});
