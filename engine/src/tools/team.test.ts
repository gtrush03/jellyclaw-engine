/**
 * Tests for TeamCreate/TeamDelete tools (T4-03).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TeamRegistry } from "../agents/team-registry.js";
import {
  _resetRegistry,
  type TeamCreateInput,
  type TeamDeleteInput,
  teamCreateTool,
  teamDeleteTool,
} from "./team.js";
import type { ToolContext } from "./types.js";

// Mock subagent dispatch result.
interface MockDispatchResult {
  status: "success" | "error";
  summary: string;
  delay?: number;
}

function createMockContext(
  sessionId: string,
  dispatchResults?: Map<string, MockDispatchResult>,
): ToolContext {
  const dispatchCalls: Array<{ subagent_type: string; description: string; prompt: string }> = [];

  return {
    sessionId,
    cwd: "/tmp",
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      fatal: vi.fn(),
      child: () => createMockContext(sessionId).logger,
      level: "info",
      silent: vi.fn(),
    } as unknown as ToolContext["logger"],
    signal: new AbortController().signal,
    subagents: {
      dispatch: async (opts: { subagent_type: string; description: string; prompt: string }) => {
        dispatchCalls.push(opts);
        const result = dispatchResults?.get(opts.subagent_type) ?? {
          status: "success" as const,
          summary: `Completed ${opts.subagent_type}`,
        };
        if (result.delay) {
          await new Promise((resolve) => setTimeout(resolve, result.delay));
        }
        return result;
      },
      getDispatchCalls: () => dispatchCalls,
    } as unknown as ToolContext["subagents"] & {
      getDispatchCalls: () => typeof dispatchCalls;
    },
  };
}

describe("TeamCreate", () => {
  let tempDir: string;
  let registry: TeamRegistry;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "team-test-"));
    registry = new TeamRegistry({ stateDir: tempDir });
    registry.open();
    _resetRegistry(registry);
  });

  afterEach(() => {
    _resetRegistry();
    registry.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("team-create-spawns-3", async () => {
    const ctx = createMockContext("session-123");

    const input: TeamCreateInput = {
      team_id: "test-team-3",
      members: [
        {
          agent_id: "researcher",
          system_prompt: "You are a researcher.",
          tools: ["Read", "Grep"],
          prompt: "Research the topic.",
        },
        {
          agent_id: "implementer",
          system_prompt: "You are an implementer.",
          tools: ["Read", "Write", "Edit"],
          prompt: "Implement the feature.",
        },
        {
          agent_id: "tester",
          system_prompt: "You are a tester.",
          tools: ["Read", "Bash"],
          prompt: "Run the tests.",
        },
      ],
    };

    const result = await teamCreateTool.handler(input, ctx);

    expect(result.team_id).toBe("test-team-3");
    expect(result.members).toHaveLength(3);
    expect(result.members.map((m) => m.agent_id).sort()).toEqual([
      "implementer",
      "researcher",
      "tester",
    ]);
    expect(result.members.every((m) => m.status === "running")).toBe(true);

    // Wait for subagent dispatch calls to complete.
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify dispatch was called 3 times (once per member).
    const dispatchCalls = (
      ctx.subagents as unknown as { getDispatchCalls: () => unknown[] }
    ).getDispatchCalls();
    expect(dispatchCalls).toHaveLength(3);
  });

  it("runs-in-parallel", async () => {
    // Each member has 400ms delay. If serial, would take 1200ms.
    // If parallel, should complete in <900ms.
    const dispatchResults = new Map<string, MockDispatchResult>([
      ["agent-1", { status: "success", summary: "Done 1", delay: 400 }],
      ["agent-2", { status: "success", summary: "Done 2", delay: 400 }],
      ["agent-3", { status: "success", summary: "Done 3", delay: 400 }],
    ]);

    const ctx = createMockContext("session-parallel", dispatchResults);

    const input: TeamCreateInput = {
      team_id: "parallel-team",
      members: [
        {
          agent_id: "agent-1",
          system_prompt: "Agent 1",
          tools: ["Read"],
          prompt: "Task 1",
        },
        {
          agent_id: "agent-2",
          system_prompt: "Agent 2",
          tools: ["Read"],
          prompt: "Task 2",
        },
        {
          agent_id: "agent-3",
          system_prompt: "Agent 3",
          tools: ["Read"],
          prompt: "Task 3",
        },
      ],
    };

    const startTime = Date.now();
    const result = await teamCreateTool.handler(input, ctx);
    const createTime = Date.now() - startTime;

    // TeamCreate returns immediately, so create time should be very fast.
    expect(createTime).toBeLessThan(100);
    expect(result.team_id).toBe("parallel-team");

    // Wait for all members to complete.
    await new Promise((resolve) => setTimeout(resolve, 600));
    const totalTime = Date.now() - startTime;

    // Total time should be ~400ms + overhead, not 1200ms (serial).
    expect(totalTime).toBeLessThan(900);

    // Verify all dispatch calls happened.
    const dispatchCalls = (
      ctx.subagents as unknown as { getDispatchCalls: () => unknown[] }
    ).getDispatchCalls();
    expect(dispatchCalls).toHaveLength(3);
  });

  it("per-agent-tool-subset", async () => {
    // This test verifies tool validation at TeamCreate time.
    // An unknown tool in the member's tools array should fail.
    const ctx = createMockContext("session-subset");

    const input: TeamCreateInput = {
      team_id: "subset-team",
      members: [
        {
          agent_id: "reader-only",
          system_prompt: "Read-only agent.",
          tools: ["Read"], // Valid tool.
          prompt: "Read the files.",
        },
        {
          agent_id: "bad-agent",
          system_prompt: "Agent with invalid tool.",
          tools: ["Read", "InvalidToolThatDoesNotExist"], // Invalid tool.
          prompt: "Try to use invalid tool.",
        },
      ],
    };

    // TeamCreate should throw because InvalidToolThatDoesNotExist is not a valid tool.
    await expect(teamCreateTool.handler(input, ctx)).rejects.toThrow("Unknown tool");
  });

  it("validates tool subset against known tools", async () => {
    const ctx = createMockContext("session-valid-tools");

    const input: TeamCreateInput = {
      team_id: "valid-tools-team",
      members: [
        {
          agent_id: "researcher",
          system_prompt: "Researcher",
          tools: ["Read", "Grep", "Glob"], // All valid.
          prompt: "Research",
        },
      ],
    };

    const result = await teamCreateTool.handler(input, ctx);
    expect(result.team_id).toBe("valid-tools-team");
    expect(result.members[0]?.agent_id).toBe("researcher");
  });

  it("rejects duplicate team_id", async () => {
    const ctx = createMockContext("session-dup");

    const input: TeamCreateInput = {
      team_id: "dup-team",
      members: [
        {
          agent_id: "agent-1",
          system_prompt: "Agent",
          tools: ["Read"],
          prompt: "Task",
        },
      ],
    };

    await teamCreateTool.handler(input, ctx);

    // Second create with same team_id should fail.
    await expect(teamCreateTool.handler(input, ctx)).rejects.toThrow("already exists");
  });

  it("allows MCP tools in tool subset", async () => {
    const ctx = createMockContext("session-mcp");

    const input: TeamCreateInput = {
      team_id: "mcp-team",
      members: [
        {
          agent_id: "mcp-agent",
          system_prompt: "MCP Agent",
          tools: ["Read", "mcp__github__create_issue"], // MCP tool allowed.
          prompt: "Create an issue",
        },
      ],
    };

    const result = await teamCreateTool.handler(input, ctx);
    expect(result.team_id).toBe("mcp-team");
  });
});

describe("TeamDelete", () => {
  let tempDir: string;
  let registry: TeamRegistry;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "team-delete-test-"));
    registry = new TeamRegistry({ stateDir: tempDir });
    registry.open();
    _resetRegistry(registry);
  });

  afterEach(() => {
    _resetRegistry();
    registry.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("team-delete-cleans-up", async () => {
    // Create a team with 3 long-running members.
    const dispatchResults = new Map<string, MockDispatchResult>([
      ["long-1", { status: "success", summary: "Done 1", delay: 5000 }],
      ["long-2", { status: "success", summary: "Done 2", delay: 5000 }],
      ["long-3", { status: "success", summary: "Done 3", delay: 5000 }],
    ]);

    const ctx = createMockContext("session-cleanup", dispatchResults);

    const createInput: TeamCreateInput = {
      team_id: "cleanup-team",
      members: [
        {
          agent_id: "long-1",
          system_prompt: "Long 1",
          tools: ["Read"],
          prompt: "Long task 1",
        },
        {
          agent_id: "long-2",
          system_prompt: "Long 2",
          tools: ["Read"],
          prompt: "Long task 2",
        },
        {
          agent_id: "long-3",
          system_prompt: "Long 3",
          tools: ["Read"],
          prompt: "Long task 3",
        },
      ],
    };

    await teamCreateTool.handler(createInput, ctx);

    // Verify team exists.
    expect(registry.teamExists("cleanup-team")).toBe(true);

    // Small delay to let members start.
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Delete the team.
    const deleteInput: TeamDeleteInput = {
      team_id: "cleanup-team",
    };

    const deleteResult = await teamDeleteTool.handler(deleteInput, ctx);

    expect(deleteResult.team_id).toBe("cleanup-team");
    // Should have cancelled some members (running) or already_done (if finished).
    expect(deleteResult.cancelled + deleteResult.already_done).toBeGreaterThan(0);

    // Team should be removed from registry.
    expect(registry.teamExists("cleanup-team")).toBe(false);

    // Subsequent TeamDelete should fail with unknown_team.
    await expect(teamDeleteTool.handler(deleteInput, ctx)).rejects.toThrow("not found");
  });

  it("returns unknown_team for nonexistent team", async () => {
    const ctx = createMockContext("session-unknown");

    const input: TeamDeleteInput = {
      team_id: "nonexistent-team",
    };

    await expect(teamDeleteTool.handler(input, ctx)).rejects.toThrow("not found");
  });

  it("correctly counts cancelled vs already_done", async () => {
    const ctx = createMockContext("session-counts");

    const createInput: TeamCreateInput = {
      team_id: "counts-team",
      members: [
        {
          agent_id: "agent-1",
          system_prompt: "Agent 1",
          tools: ["Read"],
          prompt: "Task 1",
        },
        {
          agent_id: "agent-2",
          system_prompt: "Agent 2",
          tools: ["Read"],
          prompt: "Task 2",
        },
      ],
    };

    await teamCreateTool.handler(createInput, ctx);

    // Wait for members to complete (stub completes quickly).
    await new Promise((resolve) => setTimeout(resolve, 100));

    const deleteInput: TeamDeleteInput = {
      team_id: "counts-team",
    };

    const deleteResult = await teamDeleteTool.handler(deleteInput, ctx);

    expect(deleteResult.team_id).toBe("counts-team");
    // Both should be already_done since the stub completes quickly.
    expect(deleteResult.already_done).toBe(2);
    expect(deleteResult.cancelled).toBe(0);
  });
});
