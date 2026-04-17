/**
 * Tests for the AskUserQuestion tool (T3-02).
 */

import { pino } from "pino";
import { describe, expect, it, vi } from "vitest";
import fixtureSchema from "../../../test/fixtures/tools/claude-code-schemas/askuserquestion.json" with {
  type: "json",
};
import { askUserQuestionJsonSchema, askUserQuestionTool } from "./ask-user-question.js";
import { listTools } from "./index.js";
import type { AskUserResult, PermissionService, ToolContext } from "./types.js";

const SILENT_LOGGER = pino({ level: "silent" });

function makeTestContext(
  askForAnswer?: (question: string, options?: string[]) => Promise<AskUserResult>,
): ToolContext {
  const permissions: PermissionService = {
    isAllowed: () => true,
    ...(askForAnswer !== undefined ? { askForAnswer } : {}),
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

describe("AskUserQuestion: registered", () => {
  it("listTools() contains AskUserQuestion", () => {
    const tools = listTools();
    const found = tools.find((t) => t.name === "AskUserQuestion");
    expect(found).toBeDefined();
  });

  it("schema matches the Claude Code fixture", () => {
    // Compare the essential schema properties (ignoring $schema)
    const toolSchema = askUserQuestionJsonSchema;

    expect(toolSchema.type).toBe(fixtureSchema.type);
    expect(toolSchema.additionalProperties).toBe(fixtureSchema.additionalProperties);
    expect(toolSchema.required).toEqual(fixtureSchema.required);

    // Compare properties
    expect(toolSchema.properties.question).toEqual(fixtureSchema.properties.question);
    expect(toolSchema.properties.options).toEqual(fixtureSchema.properties.options);
  });
});

// ---------------------------------------------------------------------------
// Handler tests
// ---------------------------------------------------------------------------

describe("AskUserQuestion: blocks-on-ask-handler", () => {
  it("calling AskUserQuestion blocks until askHandler resolves", async () => {
    let resolveHandler: (result: AskUserResult) => void = () => {};
    const pendingPromise = new Promise<AskUserResult>((resolve) => {
      resolveHandler = resolve;
    });

    const askForAnswer = vi.fn(() => pendingPromise);
    const ctx = makeTestContext(askForAnswer);

    // Start the handler call (should block)
    const resultPromise = askUserQuestionTool.handler({ question: "Which database schema?" }, ctx);

    // Verify askForAnswer was called
    expect(askForAnswer).toHaveBeenCalledWith("Which database schema?", undefined);

    // The result should not be resolved yet
    let resolved = false;
    resultPromise.then(() => {
      resolved = true;
    });

    // Give it a tick
    await new Promise((r) => setTimeout(r, 10));
    expect(resolved).toBe(false);

    // Now resolve the handler
    resolveHandler({ kind: "answer", text: "Use v2" });
    const result = await resultPromise;
    expect(result).toBe("Use v2");
  });
});

describe("AskUserQuestion: returns-answer", () => {
  it("askHandler resolution of {answer:'yes, ship it'} surfaces as the tool_result content", async () => {
    const askForAnswer = vi.fn(async () => ({
      kind: "answer" as const,
      text: "yes, ship it",
    }));
    const ctx = makeTestContext(askForAnswer);

    const result = await askUserQuestionTool.handler({ question: "Should we deploy?" }, ctx);
    expect(result).toBe("yes, ship it");
  });

  it("askHandler resolution of 'allow' returns formatted message", async () => {
    const askForAnswer = vi.fn(async () => "allow" as const);
    const ctx = makeTestContext(askForAnswer);

    const result = await askUserQuestionTool.handler({ question: "Proceed?" }, ctx);
    expect(result).toBe("<no answer — request was allow>");
  });

  it("askHandler resolution of 'deny' returns formatted message", async () => {
    const askForAnswer = vi.fn(async () => "deny" as const);
    const ctx = makeTestContext(askForAnswer);

    const result = await askUserQuestionTool.handler({ question: "Proceed?" }, ctx);
    expect(result).toBe("<no answer — request was deny>");
  });

  it("no askForAnswer handler returns deny message", async () => {
    const ctx = makeTestContext(); // No askForAnswer

    const result = await askUserQuestionTool.handler({ question: "Proceed?" }, ctx);
    expect(result).toBe("<no answer — request was deny>");
  });

  it("passes options to askForAnswer when provided", async () => {
    const askForAnswer = vi.fn(async () => ({
      kind: "answer" as const,
      text: "Option B",
    }));
    const ctx = makeTestContext(askForAnswer);

    const result = await askUserQuestionTool.handler(
      { question: "Pick one:", options: ["Option A", "Option B", "Option C"] },
      ctx,
    );

    expect(askForAnswer).toHaveBeenCalledWith("Pick one:", ["Option A", "Option B", "Option C"]);
    expect(result).toBe("Option B");
  });
});
