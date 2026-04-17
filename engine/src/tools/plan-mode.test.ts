/**
 * Tests for EnterPlanMode / ExitPlanMode tools (T3-03).
 */

import { pino } from "pino";
import { afterEach, describe, expect, it } from "vitest";
import enterPlanModeFixture from "../../../test/fixtures/tools/claude-code-schemas/enterplanmode.json" with {
  type: "json",
};
import exitPlanModeFixture from "../../../test/fixtures/tools/claude-code-schemas/exitplanmode.json" with {
  type: "json",
};
import { makePermissionModeController } from "../permissions/types.js";
import { listTools } from "./index.js";
import {
  _resetPriorModeSnapshots,
  enterPlanModeJsonSchema,
  enterPlanModeTool,
  exitPlanModeJsonSchema,
  exitPlanModeTool,
} from "./plan-mode.js";
import type { PermissionService, ToolContext } from "./types.js";

const SILENT_LOGGER = pino({ level: "silent" });

afterEach(() => {
  _resetPriorModeSnapshots();
});

function makeTestContext(
  modeController?: ReturnType<typeof makePermissionModeController>,
): ToolContext {
  const permissions: PermissionService = {
    isAllowed: () => true,
    ...(modeController !== undefined ? { getModeController: () => modeController } : {}),
  };
  return {
    cwd: "/tmp",
    sessionId: "test-session",
    readCache: new Set(),
    abort: new AbortController().signal,
    logger: SILENT_LOGGER,
    permissions,
  };
}

// ---------------------------------------------------------------------------
// Registration tests
// ---------------------------------------------------------------------------

describe("EnterPlanMode / ExitPlanMode: registered", () => {
  it("listTools() contains EnterPlanMode", () => {
    const tools = listTools();
    const found = tools.find((t) => t.name === "EnterPlanMode");
    expect(found).toBeDefined();
  });

  it("listTools() contains ExitPlanMode", () => {
    const tools = listTools();
    const found = tools.find((t) => t.name === "ExitPlanMode");
    expect(found).toBeDefined();
  });

  it("EnterPlanMode schema matches the fixture", () => {
    const toolSchema = enterPlanModeJsonSchema;

    expect(toolSchema.type).toBe(enterPlanModeFixture.type);
    expect(toolSchema.additionalProperties).toBe(enterPlanModeFixture.additionalProperties);
    expect(toolSchema.required).toEqual(enterPlanModeFixture.required);
    expect(toolSchema.properties.plan).toEqual(enterPlanModeFixture.properties.plan);
  });

  it("ExitPlanMode schema matches the fixture", () => {
    const toolSchema = exitPlanModeJsonSchema;

    expect(toolSchema.type).toBe(exitPlanModeFixture.type);
    expect(toolSchema.additionalProperties).toBe(exitPlanModeFixture.additionalProperties);
    expect(toolSchema.required).toEqual(exitPlanModeFixture.required);
    expect(toolSchema.properties).toEqual(exitPlanModeFixture.properties);
  });
});

// ---------------------------------------------------------------------------
// EnterPlanMode tests
// ---------------------------------------------------------------------------

describe("EnterPlanMode: enter-plan-blocks-edits", () => {
  it("after EnterPlanMode, mode is set to plan", async () => {
    const controller = makePermissionModeController("default");
    const ctx = makeTestContext(controller);

    expect(controller.current()).toBe("default");

    await enterPlanModeTool.handler({ plan: "Test plan" }, ctx);

    expect(controller.current()).toBe("plan");
  });

  it("returns confirmation message with plan text", async () => {
    const controller = makePermissionModeController("default");
    const ctx = makeTestContext(controller);

    const result = await enterPlanModeTool.handler({ plan: "My test plan" }, ctx);

    expect(result).toContain("plan mode entered");
    expect(result).toContain("side-effectful tools now blocked");
    expect(result).toContain("My test plan");
  });

  it("returns confirmation without plan section when no plan provided", async () => {
    const controller = makePermissionModeController("default");
    const ctx = makeTestContext(controller);

    const result = await enterPlanModeTool.handler({}, ctx);

    expect(result).toBe("plan mode entered — all side-effectful tools now blocked");
  });

  it("returns error message when no controller is configured", async () => {
    const ctx = makeTestContext(); // No controller

    const result = await enterPlanModeTool.handler({ plan: "Test" }, ctx);

    expect(result).toContain("plan mode not available");
  });

  it("does not re-snapshot if already in plan mode", async () => {
    const controller = makePermissionModeController("acceptEdits");
    const ctx = makeTestContext(controller);

    // Enter plan mode first time
    await enterPlanModeTool.handler({ plan: "First plan" }, ctx);
    expect(controller.current()).toBe("plan");

    // Enter plan mode second time (should not overwrite prior snapshot)
    await enterPlanModeTool.handler({ plan: "Second plan" }, ctx);
    expect(controller.current()).toBe("plan");

    // Exit should restore to original mode (acceptEdits), not "plan"
    await exitPlanModeTool.handler({}, ctx);
    expect(controller.current()).toBe("acceptEdits");
  });
});

// ---------------------------------------------------------------------------
// ExitPlanMode tests
// ---------------------------------------------------------------------------

describe("ExitPlanMode: exit-plan-restores-prior-mode", () => {
  it("restores prior mode after EnterPlanMode", async () => {
    const controller = makePermissionModeController("default");
    const ctx = makeTestContext(controller);

    // Enter plan mode
    await enterPlanModeTool.handler({ plan: "Test plan" }, ctx);
    expect(controller.current()).toBe("plan");

    // Exit plan mode
    const result = await exitPlanModeTool.handler({}, ctx);

    expect(controller.current()).toBe("default");
    expect(result).toContain("plan mode exited");
    expect(result).toContain("restored to default");
  });

  it("restores acceptEdits mode when that was the prior mode", async () => {
    const controller = makePermissionModeController("acceptEdits");
    const ctx = makeTestContext(controller);

    await enterPlanModeTool.handler({ plan: "Test" }, ctx);
    expect(controller.current()).toBe("plan");

    await exitPlanModeTool.handler({}, ctx);
    expect(controller.current()).toBe("acceptEdits");
  });

  it("restores to default if exit called without prior enter", async () => {
    const controller = makePermissionModeController("plan");
    const ctx = makeTestContext(controller);

    // Exit without enter — no snapshot exists
    const result = await exitPlanModeTool.handler({}, ctx);

    expect(controller.current()).toBe("default");
    expect(result).toContain("restored to default");
  });

  it("returns error message when no controller is configured", async () => {
    const ctx = makeTestContext(); // No controller

    const result = await exitPlanModeTool.handler({}, ctx);

    expect(result).toContain("plan mode not available");
  });

  it("clears snapshot after exit", async () => {
    const controller = makePermissionModeController("acceptEdits");
    const ctx = makeTestContext(controller);

    // Enter then exit
    await enterPlanModeTool.handler({ plan: "Test" }, ctx);
    await exitPlanModeTool.handler({}, ctx);
    expect(controller.current()).toBe("acceptEdits");

    // Set to a different mode manually
    controller.set("bypassPermissions");

    // Exit again (no snapshot) — should restore to default, not acceptEdits
    await exitPlanModeTool.handler({}, ctx);
    expect(controller.current()).toBe("default");
  });
});

// ---------------------------------------------------------------------------
// Integration test: plan mode blocks side-effectful tools
// ---------------------------------------------------------------------------

describe("Plan mode integration", () => {
  it("plan mode controller correctly manages state across enter/exit cycle", async () => {
    const controller = makePermissionModeController("default");
    const ctx = makeTestContext(controller);

    // Verify initial state
    expect(controller.current()).toBe("default");

    // Enter plan mode
    const enterResult = await enterPlanModeTool.handler({ plan: "Step 1: ...\nStep 2: ..." }, ctx);
    expect(enterResult).toContain("plan mode entered");
    expect(controller.current()).toBe("plan");

    // Exit plan mode
    const exitResult = await exitPlanModeTool.handler({}, ctx);
    expect(exitResult).toContain("plan mode exited");
    expect(exitResult).toContain("restored to default");
    expect(controller.current()).toBe("default");
  });
});
