/**
 * Tests for the real SessionRunner (T2-02).
 */

import type { Event } from "@jellyclaw/shared";
import { pino } from "pino";
import { describe, expect, it, vi } from "vitest";
import { SubagentDispatcher } from "../agents/dispatch.js";
import type { SessionRunArgs, SubagentContext } from "../agents/dispatch-types.js";
import { AgentRegistry } from "../agents/registry.js";
import { createSubagentSemaphore } from "../agents/semaphore.js";
import type { Agent } from "../agents/types.js";
import { HookRegistry } from "../hooks/registry.js";
import { compilePermissions } from "../permissions/rules.js";
import type { Provider, ProviderChunk, ProviderRequest } from "../providers/types.js";
import { createSessionRunner } from "./runner.js";

const SILENT_LOGGER = pino({ level: "silent" });

// ---------------------------------------------------------------------------
// Stub provider helpers
// ---------------------------------------------------------------------------

type TurnScript = ProviderChunk[];

function makeStubProvider(turns: TurnScript[]): {
  provider: Provider;
  calls: ProviderRequest[];
} {
  const calls: ProviderRequest[] = [];
  let turnIdx = 0;
  const provider: Provider = {
    name: "anthropic",
    // biome-ignore lint/suspicious/useAwait: generator contract
    async *stream(req: ProviderRequest): AsyncIterable<ProviderChunk> {
      calls.push(req);
      const script = turns[turnIdx++] ?? turns[turns.length - 1] ?? [];
      for (const chunk of script) yield chunk;
    },
  };
  return { provider, calls };
}

// Text-only turn that completes immediately.
const TEXT_ONLY_TURN: ProviderChunk[] = [
  {
    type: "message_start",
    message: {
      model: "claude-haiku-4-5-20251001",
      id: "msg_text",
      type: "message",
      role: "assistant",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 1 },
    },
  },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "Hello from subagent" },
  },
  { type: "content_block_stop", index: 0 },
  {
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: { input_tokens: 10, output_tokens: 5 },
  },
  { type: "message_stop" },
];

// ---------------------------------------------------------------------------
// Test agent registry helper
// ---------------------------------------------------------------------------

function createTestAgent(name: string, overrides: Partial<Agent> = {}): Agent {
  return {
    name,
    path: `/fake/agents/${name}.md`,
    source: "user",
    mtimeMs: Date.now(),
    frontmatter: {
      max_turns: 10,
      max_tokens: 4096,
      ...overrides.frontmatter,
    },
    prompt: `You are the ${name} agent.`,
    ...overrides,
  };
}

/**
 * Create a mock AgentRegistry that returns the specified agents.
 * Can't use the real AgentRegistry since private fields can't be manipulated.
 */
function createMockRegistry(agents: Agent[]): AgentRegistry {
  const agentMap = new Map(agents.map((a) => [a.name, a]));
  return {
    get: (name: string) => agentMap.get(name),
    list: () => [...agentMap.values()],
    size: () => agentMap.size,
    loadAll: async () => {},
    reload: async () => ({ added: [], removed: [], modified: [] }),
    subscribe: () => () => {},
  } as unknown as AgentRegistry;
}

// ---------------------------------------------------------------------------
// Mock SessionRunner for dispatcher tests
// ---------------------------------------------------------------------------

function createMockSessionRunner(
  events: Event[],
  result: Awaited<
    ReturnType<typeof import("../agents/dispatch-types.js").SessionRunner.prototype.run>
  >,
) {
  return {
    // biome-ignore lint/suspicious/useAwait: async contract required by SessionRunner interface
    run: vi.fn(async (args: SessionRunArgs) => {
      for (const event of events) {
        args.onEvent(event);
      }
      return result;
    }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createSessionRunner: task-spawn-and-return", () => {
  it("drives runAgentLoop and returns SessionRunResult with complete reason", async () => {
    const { provider } = makeStubProvider([TEXT_ONLY_TURN]);
    const hooks = new HookRegistry([]);
    const permissions = compilePermissions({ mode: "bypassPermissions" });

    const runner = createSessionRunner({
      provider,
      permissions,
      hooks,
      logger: SILENT_LOGGER,
    });

    const context: SubagentContext = {
      subagentSessionId: "sub-1",
      parentSessionId: "parent-1",
      agentName: "test-agent",
      description: "Test task",
      prompt: "Hello",
      systemPrompt: "You are a test agent.",
      model: "claude-haiku-4-5-20251001",
      allowedTools: ["Read", "Write"],
      skills: [],
      maxTurns: 5,
      maxTokens: 4096,
      depth: 1,
    };

    const events: Event[] = [];
    const result = await runner.run({
      context,
      signal: new AbortController().signal,
      onEvent: (e) => events.push(e),
      clock: Date.now,
    });

    // Should have forwarded events.
    expect(events.length).toBeGreaterThan(0);

    // Should complete successfully.
    expect(result.reason).toBe("complete");
    expect(result.turns).toBeGreaterThan(0);
  });
});

describe("SubagentDispatcher: task-spawn-and-return", () => {
  it("emits subagent.start and subagent.end events via mock runner", async () => {
    const testAgent = createTestAgent("test-agent", {
      frontmatter: { max_turns: 5, max_tokens: 4096 },
    });
    const registry = createMockRegistry([testAgent]);
    const semaphore = createSubagentSemaphore({ maxConcurrency: 2 });

    // Mock events the runner would emit.
    const mockEvents: Event[] = [
      {
        type: "session.started",
        session_id: "sub-1",
        ts: Date.now(),
        seq: 0,
        wish: "test",
        agent: "test-agent",
        model: "claude-haiku-4-5-20251001",
        provider: "anthropic",
        cwd: "/tmp",
      },
      {
        type: "session.completed",
        session_id: "sub-1",
        ts: Date.now(),
        seq: 1,
        summary: "Task completed",
        turns: 1,
        duration_ms: 100,
      },
    ];

    const mockRunner = createMockSessionRunner(mockEvents, {
      summary: "Task completed",
      usage: { input_tokens: 100, output_tokens: 50 },
      turns: 1,
      reason: "complete",
    });

    const emittedEvents: Event[] = [];

    const dispatcher = new SubagentDispatcher({
      registry,
      runner: mockRunner,
      semaphore,
      config: { maxConcurrency: 2, maxDepth: 2 },
      parent: {
        sessionId: "parent-1",
        allowedTools: ["Read", "Write", "Bash"],
        model: "claude-haiku-4-5-20251001",
        depth: 0,
      },
      emit: (e) => emittedEvents.push(e),
      logger: SILENT_LOGGER,
    });

    const result = await dispatcher.dispatch({
      subagent_type: "test-agent",
      description: "Test task",
      prompt: "Do something",
    });

    // Check result.
    expect(result.status).toBe("success");
    expect(result.summary).toBe("Task completed");

    // Check emitted events.
    const startEvent = emittedEvents.find((e) => e.type === "subagent.start");
    const endEvent = emittedEvents.find((e) => e.type === "subagent.end");

    expect(startEvent).toBeDefined();
    expect(endEvent).toBeDefined();

    if (startEvent?.type === "subagent.start") {
      expect(startEvent.agent_name).toBe("test-agent");
    }

    if (endEvent?.type === "subagent.end") {
      expect(endEvent.summary).toBe("Task completed");
    }

    // Runner should have been called.
    expect(mockRunner.run).toHaveBeenCalledTimes(1);
  });
});

describe("SubagentDispatcher: depth-guard", () => {
  it("rejects dispatch when depth exceeds maxDepth without throwing", async () => {
    const testAgent = createTestAgent("deep-agent");
    const registry = createMockRegistry([testAgent]);
    const semaphore = createSubagentSemaphore({ maxConcurrency: 2 });

    const mockRunner = createMockSessionRunner([], {
      summary: "Should not be called",
      usage: { input_tokens: 0, output_tokens: 0 },
      turns: 0,
      reason: "complete",
    });

    const emittedEvents: Event[] = [];

    const dispatcher = new SubagentDispatcher({
      registry,
      runner: mockRunner,
      semaphore,
      config: { maxConcurrency: 2, maxDepth: 1 }, // maxDepth = 1
      parent: {
        sessionId: "parent-1",
        allowedTools: ["Read", "Write"],
        model: "claude-haiku-4-5-20251001",
        depth: 1, // Already at depth 1, so child would be depth 2 > maxDepth
      },
      emit: (e) => emittedEvents.push(e),
      logger: SILENT_LOGGER,
    });

    const result = await dispatcher.dispatch({
      subagent_type: "deep-agent",
      description: "Should fail",
      prompt: "Too deep",
    });

    // Should return error status, not throw.
    expect(result.status).toBe("error");
    expect(result.summary).toContain("subagent_depth_exceeded");

    // Runner should NOT have been called.
    expect(mockRunner.run).not.toHaveBeenCalled();

    // Should emit subagent.end with error info.
    const endEvent = emittedEvents.find((e) => e.type === "subagent.end");
    expect(endEvent).toBeDefined();
    if (endEvent?.type === "subagent.end") {
      expect(endEvent.summary).toContain("subagent_depth_exceeded");
    }
  });
});
