/**
 * Unit tests for the WebSearch stub tool.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createLogger } from "../../../engine/src/logger.js";
import { getTool } from "../../../engine/src/tools/index.js";
import { allowAll } from "../../../engine/src/tools/permissions.js";
import { type ToolContext, WebSearchNotConfiguredError } from "../../../engine/src/tools/types.js";
import {
  _resetWebSearchWarning,
  emitWebSearchRegistrationWarning,
  websearchTool,
} from "../../../engine/src/tools/websearch.js";
import websearchSchema from "../../fixtures/tools/claude-code-schemas/websearch.json" with {
  type: "json",
};

function makeCtx(): ToolContext {
  return {
    cwd: process.cwd(),
    sessionId: "test-session",
    readCache: new Set<string>(),
    abort: new AbortController().signal,
    logger: createLogger({ level: "silent" }),
    permissions: allowAll,
  };
}

describe("websearchTool", () => {
  it("always throws WebSearchNotConfiguredError on valid input", async () => {
    await expect(websearchTool.handler({ query: "hello world" }, makeCtx())).rejects.toBeInstanceOf(
      WebSearchNotConfiguredError,
    );
  });

  it("also throws WebSearchNotConfiguredError on invalid input (no ZodError)", async () => {
    await expect(
      websearchTool.handler({ query: "" } as unknown as { query: string }, makeCtx()),
    ).rejects.toBeInstanceOf(WebSearchNotConfiguredError);
  });

  it("error message includes MCP hint and mentions jellyclaw.json", async () => {
    try {
      await websearchTool.handler({ query: "anything" }, makeCtx());
      expect.unreachable("handler should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(WebSearchNotConfiguredError);
      const msg = (err as Error).message;
      expect(msg).toMatch(/Configure a search MCP/i);
      expect(msg).toContain("jellyclaw.json");
    }
  });

  it("inputSchema deep-equals the claude-code JSON fixture", () => {
    expect(websearchTool.inputSchema).toEqual(websearchSchema);
  });

  it("is registered in the builtin registry under 'WebSearch'", () => {
    expect(getTool("WebSearch")).toBe(websearchTool);
  });

  it("overridesOpenCode is true and name is exactly 'WebSearch'", () => {
    expect(websearchTool.name).toBe("WebSearch");
    expect(websearchTool.overridesOpenCode).toBe(true);
  });
});

describe("emitWebSearchRegistrationWarning", () => {
  const originalEnv = process.env.JELLYCLAW_WARN_WEBSEARCH;

  beforeEach(() => {
    _resetWebSearchWarning();
  });

  afterEach(() => {
    _resetWebSearchWarning();
    if (originalEnv === undefined) {
      delete process.env.JELLYCLAW_WARN_WEBSEARCH;
    } else {
      process.env.JELLYCLAW_WARN_WEBSEARCH = originalEnv;
    }
  });

  it("fires exactly once across repeated calls", () => {
    const warn = vi.fn();
    const logger = { warn };
    emitWebSearchRegistrationWarning(logger);
    emitWebSearchRegistrationWarning(logger);
    emitWebSearchRegistrationWarning(logger);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("is suppressed when JELLYCLAW_WARN_WEBSEARCH=false", () => {
    process.env.JELLYCLAW_WARN_WEBSEARCH = "false";
    const warn = vi.fn();
    emitWebSearchRegistrationWarning({ warn });
    expect(warn).not.toHaveBeenCalled();
  });

  it("emits warning payload mentioning the tool name", () => {
    const warn = vi.fn();
    emitWebSearchRegistrationWarning({ warn });
    expect(warn).toHaveBeenCalledTimes(1);
    const firstCall = warn.mock.calls[0];
    expect(firstCall).toBeDefined();
    expect(firstCall?.[0]).toMatchObject({ tool: "WebSearch" });
  });
});
