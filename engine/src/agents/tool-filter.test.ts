/**
 * Tests for tool-filter.ts (T2-09).
 */

import { describe, expect, it } from "vitest";
import { applyToolFilter, isToolEnabled, type ToolFilter } from "./tool-filter.js";

// ---------------------------------------------------------------------------
// Helper to create tool objects
// ---------------------------------------------------------------------------

function makeTool(name: string): { name: string } {
  return { name };
}

// ---------------------------------------------------------------------------
// isToolEnabled tests
// ---------------------------------------------------------------------------

describe("isToolEnabled", () => {
  it("returns true when no filter configured", () => {
    const filter: ToolFilter = {};
    expect(isToolEnabled("Bash", filter)).toBe(true);
    expect(isToolEnabled("Read", filter)).toBe(true);
    expect(isToolEnabled("mcp__github__create_issue", filter)).toBe(true);
  });

  it("returns false when tool is in deny list", () => {
    const filter: ToolFilter = { deny: ["Bash", "WebFetch"] };
    expect(isToolEnabled("Bash", filter)).toBe(false);
    expect(isToolEnabled("WebFetch", filter)).toBe(false);
    expect(isToolEnabled("Read", filter)).toBe(true);
  });

  it("returns false when tool is not in allow list", () => {
    const filter: ToolFilter = { allow: ["Read", "Grep"] };
    expect(isToolEnabled("Read", filter)).toBe(true);
    expect(isToolEnabled("Grep", filter)).toBe(true);
    expect(isToolEnabled("Bash", filter)).toBe(false);
    expect(isToolEnabled("Write", filter)).toBe(false);
  });

  it("deny takes precedence over allow", () => {
    const filter: ToolFilter = { allow: ["Bash", "Read"], deny: ["Bash"] };
    expect(isToolEnabled("Bash", filter)).toBe(false);
    expect(isToolEnabled("Read", filter)).toBe(true);
  });

  it("supports MCP wildcard patterns in deny", () => {
    const filter: ToolFilter = { deny: ["mcp__github__*"] };
    expect(isToolEnabled("mcp__github__create_issue", filter)).toBe(false);
    expect(isToolEnabled("mcp__github__list_prs", filter)).toBe(false);
    expect(isToolEnabled("mcp__slack__post_message", filter)).toBe(true);
    expect(isToolEnabled("Bash", filter)).toBe(true);
  });

  it("supports MCP wildcard patterns in allow", () => {
    const filter: ToolFilter = { allow: ["Read", "mcp__github__*"] };
    expect(isToolEnabled("Read", filter)).toBe(true);
    expect(isToolEnabled("mcp__github__create_issue", filter)).toBe(true);
    expect(isToolEnabled("mcp__github__list_prs", filter)).toBe(true);
    expect(isToolEnabled("mcp__slack__post_message", filter)).toBe(false);
    expect(isToolEnabled("Bash", filter)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// applyToolFilter tests
// ---------------------------------------------------------------------------

describe("applyToolFilter", () => {
  describe("filter-out-disallowed", () => {
    it("removes denied tools from the list", () => {
      const tools = [makeTool("Bash"), makeTool("Read"), makeTool("Write")];
      const filter: ToolFilter = { deny: ["Bash"] };
      const result = applyToolFilter(tools, filter);
      expect(result.map((t) => t.name)).toEqual(["Read", "Write"]);
    });

    it("removes multiple denied tools", () => {
      const tools = [makeTool("Bash"), makeTool("Read"), makeTool("WebFetch"), makeTool("Write")];
      const filter: ToolFilter = { deny: ["Bash", "WebFetch"] };
      const result = applyToolFilter(tools, filter);
      expect(result.map((t) => t.name)).toEqual(["Read", "Write"]);
    });

    it("removes MCP tools matching wildcard pattern", () => {
      const tools = [
        makeTool("Bash"),
        makeTool("Read"),
        makeTool("mcp__github__create_issue"),
        makeTool("mcp__github__list_prs"),
        makeTool("mcp__slack__post_message"),
      ];
      const filter: ToolFilter = { deny: ["mcp__github__*"] };
      const result = applyToolFilter(tools, filter);
      expect(result.map((t) => t.name)).toEqual(["Bash", "Read", "mcp__slack__post_message"]);
    });
  });

  describe("intersect-allowed", () => {
    it("keeps only allowed tools", () => {
      const tools = [
        makeTool("Bash"),
        makeTool("Read"),
        makeTool("Grep"),
        makeTool("Write"),
        makeTool("WebFetch"),
      ];
      const filter: ToolFilter = { allow: ["Read", "Grep"] };
      const result = applyToolFilter(tools, filter);
      expect(result.map((t) => t.name)).toEqual(["Read", "Grep"]);
    });

    it("returns empty array when no tools match allow list", () => {
      const tools = [makeTool("Bash"), makeTool("Write")];
      const filter: ToolFilter = { allow: ["Read", "Grep"] };
      const result = applyToolFilter(tools, filter);
      expect(result).toEqual([]);
    });

    it("supports MCP wildcard in allow list", () => {
      const tools = [
        makeTool("Bash"),
        makeTool("Read"),
        makeTool("mcp__github__create_issue"),
        makeTool("mcp__github__list_prs"),
        makeTool("mcp__slack__post_message"),
      ];
      const filter: ToolFilter = { allow: ["Read", "mcp__github__*"] };
      const result = applyToolFilter(tools, filter);
      expect(result.map((t) => t.name)).toEqual([
        "Read",
        "mcp__github__create_issue",
        "mcp__github__list_prs",
      ]);
    });
  });

  describe("no filter", () => {
    it("returns all tools when filter is empty", () => {
      const tools = [makeTool("Bash"), makeTool("Read"), makeTool("Write")];
      const filter: ToolFilter = {};
      const result = applyToolFilter(tools, filter);
      expect(result.map((t) => t.name)).toEqual(["Bash", "Read", "Write"]);
    });

    it("returns all tools when allow and deny are undefined", () => {
      const tools = [makeTool("Bash"), makeTool("Read")];
      const filter: ToolFilter = { allow: undefined, deny: undefined };
      const result = applyToolFilter(tools, filter);
      expect(result.map((t) => t.name)).toEqual(["Bash", "Read"]);
    });

    it("returns all tools when allow and deny are empty arrays", () => {
      const tools = [makeTool("Bash"), makeTool("Read")];
      const filter: ToolFilter = { allow: [], deny: [] };
      const result = applyToolFilter(tools, filter);
      expect(result.map((t) => t.name)).toEqual(["Bash", "Read"]);
    });
  });

  describe("combined allow and deny", () => {
    it("deny takes precedence when tool is in both lists", () => {
      const tools = [makeTool("Bash"), makeTool("Read"), makeTool("Write")];
      const filter: ToolFilter = { allow: ["Bash", "Read", "Write"], deny: ["Bash"] };
      const result = applyToolFilter(tools, filter);
      expect(result.map((t) => t.name)).toEqual(["Read", "Write"]);
    });
  });
});
