/**
 * Unit tests for the Task subagent-dispatch tool.
 *
 * Phase 06 Prompt 02 changed the Task handler from "throw on misconfig"
 * to "always return a graceful SubagentResult-shaped error." The suite
 * below locks in that contract: every failure path returns a payload,
 * never throws out of the handler.
 */

import { describe, expect, it, vi } from "vitest";

import { createLogger } from "../../../engine/src/logger.js";
import { stubSubagentService } from "../../../engine/src/subagents/stub.js";
import type { SubagentResult, SubagentService } from "../../../engine/src/subagents/types.js";
import { getTool } from "../../../engine/src/tools/index.js";
import { allowAll } from "../../../engine/src/tools/permissions.js";
import { taskTool } from "../../../engine/src/tools/task.js";
import type { ToolContext } from "../../../engine/src/tools/types.js";
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
  it("with stubSubagentService returns { status: 'error' } mentioning Phase 06 stub", async () => {
    const out = await taskTool.handler(validInput, makeCtx(stubSubagentService));
    expect(out.status).toBe("error");
    expect(out.summary).toMatch(/dispatch_error/);
    expect(out.summary).toMatch(/Phase 06/i);
    expect(out.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
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

  it("maps rejected-promise errors from the dispatcher to { status: 'error' }", async () => {
    const dispatch = vi.fn().mockRejectedValue(new Error("dispatch blew up"));
    const out = await taskTool.handler(validInput, makeCtx({ dispatch }));
    expect(out.status).toBe("error");
    expect(out.summary).toMatch(/dispatch_error: dispatch blew up/);
  });

  it("returns { status: 'error', summary: /subagents_unavailable/ } when ctx.subagents is missing", async () => {
    const out = await taskTool.handler(validInput, makeCtx());
    expect(out.status).toBe("error");
    expect(out.summary).toMatch(/subagents_unavailable/);
  });
});

describe("taskTool — schema validation", () => {
  it("maps missing subagent_type to invalid_input error result", async () => {
    const out = await taskTool.handler(
      { description: "x", prompt: "y" } as unknown as typeof validInput,
      makeCtx(stubSubagentService),
    );
    expect(out.status).toBe("error");
    expect(out.summary).toMatch(/invalid_input/);
    expect(out.summary).toMatch(/subagent_type/);
  });

  it("maps missing prompt to invalid_input error result", async () => {
    const out = await taskTool.handler(
      { description: "x", subagent_type: "general-purpose" } as unknown as typeof validInput,
      makeCtx(stubSubagentService),
    );
    expect(out.status).toBe("error");
    expect(out.summary).toMatch(/invalid_input/);
    expect(out.summary).toMatch(/prompt/);
  });

  it("maps empty strings to invalid_input error result", async () => {
    const out = await taskTool.handler(
      { description: "", prompt: "", subagent_type: "" },
      makeCtx(stubSubagentService),
    );
    expect(out.status).toBe("error");
    expect(out.summary).toMatch(/invalid_input/);
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
