/**
 * Schema parity suite.
 *
 * Asserts that every registered jellyclaw tool's `inputSchema` deep-equals
 * the corresponding Claude Code reference schema in
 * `test/fixtures/tools/claude-code-schemas/<name>.json`.
 *
 * Also asserts the overall registry shape (11 tools, names match the
 * Claude Code canon).
 *
 * Allowed deviations are documented in
 * `test/fixtures/tools/parity-allowed-drift.json` — currently empty.
 * Adding a deviation requires a justification entry in that file.
 */

import { describe, expect, it } from "vitest";

import { listTools } from "../../../engine/src/tools/index.js";
import bashSchema from "../../fixtures/tools/claude-code-schemas/bash.json" with { type: "json" };
import editSchema from "../../fixtures/tools/claude-code-schemas/edit.json" with { type: "json" };
import globSchema from "../../fixtures/tools/claude-code-schemas/glob.json" with { type: "json" };
import grepSchema from "../../fixtures/tools/claude-code-schemas/grep.json" with { type: "json" };
import notebookEditSchema from "../../fixtures/tools/claude-code-schemas/notebookedit.json" with {
  type: "json",
};
import readSchema from "../../fixtures/tools/claude-code-schemas/read.json" with { type: "json" };
import taskSchema from "../../fixtures/tools/claude-code-schemas/task.json" with { type: "json" };
import todowriteSchema from "../../fixtures/tools/claude-code-schemas/todowrite.json" with {
  type: "json",
};
import webfetchSchema from "../../fixtures/tools/claude-code-schemas/webfetch.json" with {
  type: "json",
};
import writeSchema from "../../fixtures/tools/claude-code-schemas/write.json" with { type: "json" };
import allowedDrift from "../../fixtures/tools/parity-allowed-drift.json" with { type: "json" };

// WebSearch intentionally absent from builtinTools — provided via
// the default Exa MCP instead. See docs/tools.md and T5-02.
const REFERENCE_SCHEMAS: Record<string, unknown> = {
  Bash: bashSchema,
  Edit: editSchema,
  Glob: globSchema,
  Grep: grepSchema,
  NotebookEdit: notebookEditSchema,
  Read: readSchema,
  Task: taskSchema,
  TodoWrite: todowriteSchema,
  WebFetch: webfetchSchema,
  Write: writeSchema,
};

const EXPECTED_TOOL_NAMES = Object.keys(REFERENCE_SCHEMAS).sort();

describe("tool registry parity", () => {
  const allTools = listTools();
  // Filter to Claude Code canonical tools only for parity checks
  const tools = allTools.filter((t) => EXPECTED_TOOL_NAMES.includes(t.name));

  it("includes all 10 Claude Code canonical tools (WebSearch removed — now via Exa MCP)", () => {
    expect(tools.length).toBe(10);
  });

  it("includes exactly the Claude Code canonical tool names", () => {
    const got = tools.map((t) => t.name).sort();
    expect(got).toEqual(EXPECTED_TOOL_NAMES);
  });

  it("every Claude Code canonical tool overrides the OpenCode builtin", () => {
    for (const tool of tools) {
      expect(tool.overridesOpenCode).toBe(true);
    }
  });

  it("every registered tool has a non-empty description", () => {
    for (const tool of allTools) {
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });

  it("the allowed-drift list is empty (Phase 04 ships zero deviations)", () => {
    const drift = allowedDrift as { tools: Record<string, unknown> };
    expect(Object.keys(drift.tools)).toEqual([]);
  });

  for (const name of EXPECTED_TOOL_NAMES) {
    it(`${name}.inputSchema deep-equals the Claude Code reference schema`, () => {
      const tool = tools.find((t) => t.name === name);
      expect(tool, `tool ${name} not registered`).toBeDefined();
      const reference = REFERENCE_SCHEMAS[name];
      expect(tool?.inputSchema).toEqual(reference);
    });
  }
});
