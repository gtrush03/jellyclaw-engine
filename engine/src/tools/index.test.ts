/**
 * Tests for tool registry (index.ts).
 */

import { describe, expect, it } from "vitest";

import { builtinTools, getTool } from "./index.js";

describe("Tool registry", () => {
  describe("scheduling-tools-registered", () => {
    it("includes ScheduleWakeup tool", () => {
      const tool = getTool("ScheduleWakeup");
      expect(tool).toBeDefined();
      expect(tool?.name).toBe("ScheduleWakeup");
    });

    it("includes CronCreate tool", () => {
      const tool = getTool("CronCreate");
      expect(tool).toBeDefined();
      expect(tool?.name).toBe("CronCreate");
    });

    it("includes CronDelete tool", () => {
      const tool = getTool("CronDelete");
      expect(tool).toBeDefined();
      expect(tool?.name).toBe("CronDelete");
    });

    it("includes CronList tool", () => {
      const tool = getTool("CronList");
      expect(tool).toBeDefined();
      expect(tool?.name).toBe("CronList");
    });

    it("all scheduling tools are in builtinTools array", () => {
      const schedulingToolNames = ["ScheduleWakeup", "CronCreate", "CronDelete", "CronList"];
      const registeredNames = builtinTools.map((t) => t.name);

      for (const name of schedulingToolNames) {
        expect(registeredNames).toContain(name);
      }
    });
  });

  describe("existing tools still registered", () => {
    const expectedTools = [
      "AskUserQuestion",
      "Bash",
      "Edit",
      "EnterPlanMode",
      "ExitPlanMode",
      "Glob",
      "Grep",
      "Memory",
      "NotebookEdit",
      "Read",
      "Task",
      "TodoWrite",
      "WebFetch",
      "WebSearch",
      "Write",
    ];

    for (const name of expectedTools) {
      it(`includes ${name} tool`, () => {
        const tool = getTool(name);
        expect(tool).toBeDefined();
      });
    }
  });
});
