/**
 * Task tool unit tests.
 *
 * Proves the fix for Error 7 at the tool-surface level: given a `ToolContext`
 * wired with a real `SubagentDispatcher`, `taskTool.handler(...)` dispatches
 * to a child session runner and returns a populated `SubagentResult` —
 * never the historical `subagents_disabled: Task tool is not available` /
 * `SubagentsNotImplementedError` paths.
 *
 * The SessionRunner is a pure test double (no provider / no network); the
 * dispatcher itself is the real `SubagentDispatcher` from `agents/dispatch.ts`.
 */

import type { Event } from "@jellyclaw/shared";
import { describe, expect, it } from "vitest";

import { SubagentDispatcher } from "../agents/dispatch.js";
import {
  DEFAULT_DISPATCH_CONFIG,
  type SessionRunArgs,
  type SessionRunner,
  type SessionRunResult,
} from "../agents/dispatch-types.js";
import type { AgentRegistry } from "../agents/registry.js";
import { createSubagentSemaphore } from "../agents/semaphore.js";
import type { Agent } from "../agents/types.js";
import { createLogger } from "../logger.js";
import { taskTool } from "./task.js";
import { makePermissionService, type ToolContext } from "./types.js";

const logger = createLogger({ level: "silent" });

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function buildAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    name: "general-purpose",
    frontmatter: {
      name: "general-purpose",
      description: "A helpful agent",
      mode: "subagent",
      tools: ["Read", "Grep"],
      max_turns: 20,
      max_tokens: 100_000,
    },
    prompt: "You are a helpful subagent.",
    path: "/tmp/agents/general-purpose.md",
    source: "project",
    mtimeMs: 0,
    ...overrides,
  };
}

function registryWith(agents: Agent[]): AgentRegistry {
  // Shim satisfying the two methods the dispatcher uses.
  const fake: AgentRegistry = {
    get: (name: string) => agents.find((a) => a.name === name),
    list: () => [...agents].sort((a, b) => a.name.localeCompare(b.name)),
  } as unknown as AgentRegistry;
  return fake;
}

function makeStubRunner(summary: string): SessionRunner {
  return {
    // biome-ignore lint/suspicious/useAwait: contract requires async signature.
    async run(_args: SessionRunArgs): Promise<SessionRunResult> {
      return {
        summary,
        usage: { input_tokens: 7, output_tokens: 11 },
        turns: 1,
        reason: "complete",
      };
    },
  };
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    cwd: "/tmp",
    sessionId: "parent-session",
    readCache: new Set<string>(),
    abort: new AbortController().signal,
    logger,
    permissions: makePermissionService(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("taskTool with real SubagentDispatcher wired", () => {
  it("dispatches to the child runner and returns a populated SubagentResult", async () => {
    const events: Event[] = [];
    const dispatcher = new SubagentDispatcher({
      registry: registryWith([buildAgent()]),
      runner: makeStubRunner("hello from child"),
      semaphore: createSubagentSemaphore({ maxConcurrency: 2, logger }),
      config: DEFAULT_DISPATCH_CONFIG,
      parent: {
        sessionId: "parent-session",
        allowedTools: ["Read", "Grep", "Task"],
        model: "claude-opus-4-7",
        depth: 0,
      },
      logger,
      emit: (e) => events.push(e),
    });

    const ctx = makeCtx({ subagents: dispatcher });
    const result = await taskTool.handler(
      {
        subagent_type: "general-purpose",
        description: "smoke test",
        prompt: "do a thing",
      },
      ctx,
    );

    // No `subagents_disabled` / SubagentsNotImplementedError paths.
    expect(result.summary).not.toMatch(/subagents_disabled/);
    expect(result.summary).not.toMatch(/subagents_unavailable/);
    expect(result.summary).not.toMatch(/not implemented/i);

    // Real result surfaces from the runner.
    expect(result.status).toBe("success");
    expect(result.summary).toBe("hello from child");
    expect(result.usage).toEqual({ input_tokens: 7, output_tokens: 11 });

    // Hooks delta: SubagentStart + SubagentStop fire through the emit sink.
    const types = events.map((e) => e.type);
    expect(types).toContain("subagent.start");
    expect(types).toContain("subagent.end");

    // Ordering: start precedes end.
    expect(types.indexOf("subagent.start")).toBeLessThan(types.indexOf("subagent.end"));
  });

  it("unknown subagent type surfaces as a graceful error, not a throw", async () => {
    const dispatcher = new SubagentDispatcher({
      registry: registryWith([]), // empty registry
      runner: makeStubRunner("never-called"),
      semaphore: createSubagentSemaphore({ maxConcurrency: 1, logger }),
      config: DEFAULT_DISPATCH_CONFIG,
      parent: {
        sessionId: "parent-session",
        allowedTools: ["Task"],
        model: "claude-opus-4-7",
        depth: 0,
      },
      logger,
    });

    const ctx = makeCtx({ subagents: dispatcher });
    const result = await taskTool.handler(
      {
        subagent_type: "nonexistent",
        description: "x",
        prompt: "y",
      },
      ctx,
    );

    expect(result.status).toBe("error");
    expect(result.summary).toMatch(/unknown_agent/);
  });

  it("without ctx.subagents, Task returns a graceful error (not a throw)", async () => {
    const ctx = makeCtx(); // no subagents wired
    const result = await taskTool.handler(
      {
        subagent_type: "general-purpose",
        description: "x",
        prompt: "y",
      },
      ctx,
    );

    expect(result.status).toBe("error");
    expect(result.summary).toMatch(/subagents_unavailable/);
  });
});
