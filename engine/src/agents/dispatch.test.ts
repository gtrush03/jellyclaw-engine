/**
 * SubagentDispatcher integration tests (Phase 06 Prompt 02).
 *
 * Exercises the dispatcher against a mock SessionRunner, a real
 * AgentRegistry, and a real semaphore. The runner seam lets us script
 * event sequences and terminal reasons without standing up OpenCode.
 */

import type { Event } from "@jellyclaw/shared";
import { describe, expect, it, vi } from "vitest";
import { createSubagentDispatcher, SubagentDispatcher } from "./dispatch.js";
import {
  DEFAULT_DISPATCH_CONFIG,
  type DispatchConfig,
  type ParentContext,
  type SessionRunArgs,
  type SessionRunner,
  type SessionRunResult,
} from "./dispatch-types.js";
import type { AgentRegistry } from "./registry.js";
import { createSubagentSemaphore } from "./semaphore.js";
import type { Agent } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e?: unknown) => void;
}
function defer<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

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
  // AgentRegistry has no public `add`; wrap a thin fake that satisfies the
  // two methods the dispatcher uses (`get`, `list`).
  const fake: AgentRegistry = {
    get: (name: string) => agents.find((a) => a.name === name),
    list: () => [...agents].sort((a, b) => a.name.localeCompare(b.name)),
  } as unknown as AgentRegistry;
  return fake;
}

function buildParent(overrides: Partial<ParentContext> = {}): ParentContext {
  return {
    sessionId: "parent-session-1",
    allowedTools: ["Read", "Grep", "Bash"],
    model: "claude-sonnet",
    depth: 0,
    ...overrides,
  };
}

interface MockRunnerHooks {
  readonly emits?: readonly Event[];
  readonly onRun?: (args: SessionRunArgs) => void | Promise<void>;
}

function makeMockRunner(result: SessionRunResult, hooks: MockRunnerHooks = {}): SessionRunner {
  return {
    async run(args) {
      if (hooks.emits) {
        for (const e of hooks.emits) args.onEvent(e);
      }
      if (hooks.onRun) await hooks.onRun(args);
      return result;
    },
  };
}

function successResult(summary = "done"): SessionRunResult {
  return {
    summary,
    usage: { input_tokens: 10, output_tokens: 20 },
    turns: 1,
    reason: "complete",
  };
}

function baseConfig(overrides: Partial<DispatchConfig> = {}): DispatchConfig {
  return { ...DEFAULT_DISPATCH_CONFIG, ...overrides };
}

let idCounter = 0;
function seqId(): string {
  idCounter += 1;
  return `child-${idCounter}`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SubagentDispatcher", () => {
  it("unknown subagent returns error + emits synthetic end, does not throw", async () => {
    idCounter = 0;
    const events: Event[] = [];
    const dispatcher = new SubagentDispatcher({
      registry: registryWith([]),
      runner: makeMockRunner(successResult()),
      semaphore: createSubagentSemaphore({ maxConcurrency: 2 }),
      config: baseConfig(),
      parent: buildParent(),
      clock: () => 1000,
      idGen: seqId,
      emit: (e) => events.push(e),
    });

    const result = await dispatcher.dispatch({
      subagent_type: "nope",
      description: "d",
      prompt: "p",
    });

    expect(result.status).toBe("error");
    expect(result.summary).toMatch(/unknown_agent/);
    expect(result.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
    // Only the synthetic end; no start.
    expect(events.map((e) => e.type)).toEqual(["subagent.end"]);
  });

  it("successful dispatch emits start then end in order with matching ids", async () => {
    idCounter = 0;
    const events: Event[] = [];
    const agent = buildAgent();
    const parent = buildParent();
    const dispatcher = new SubagentDispatcher({
      registry: registryWith([agent]),
      runner: makeMockRunner(successResult("summary-text")),
      semaphore: createSubagentSemaphore({ maxConcurrency: 2 }),
      config: baseConfig(),
      parent,
      clock: () => 5000,
      idGen: seqId,
      emit: (e) => events.push(e),
    });

    const result = await dispatcher.dispatch({
      subagent_type: "general-purpose",
      description: "d",
      prompt: "p",
    });

    expect(result.status).toBe("success");
    expect(result.summary).toBe("summary-text");
    expect(result.usage.input_tokens).toBe(10);
    expect(result.usage.output_tokens).toBe(20);

    expect(events.map((e) => e.type)).toEqual(["subagent.start", "subagent.end"]);
    const start = events[0] as Extract<Event, { type: "subagent.start" }>;
    const end = events[1] as Extract<Event, { type: "subagent.end" }>;
    expect(start.session_id).toBe("child-1");
    expect(end.session_id).toBe("child-1");
    expect(start.parent_id).toBe(parent.sessionId);
    // Context intersects agent tools with parent allowedTools.
    expect(start.allowed_tools).toEqual(["Read", "Grep"]);
    expect(start.agent_name).toBe("general-purpose");
  });

  it("forwards runner-emitted events between start and end", async () => {
    idCounter = 0;
    const events: Event[] = [];
    const agent = buildAgent();
    const innerToolStart: Event = {
      type: "tool.call.start",
      session_id: "child-1",
      tool_use_id: "t1",
      name: "Read",
      input: {},
      subagent_path: ["general-purpose"],
      ts: 5001,
    };
    const dispatcher = new SubagentDispatcher({
      registry: registryWith([agent]),
      runner: makeMockRunner(successResult(), { emits: [innerToolStart] }),
      semaphore: createSubagentSemaphore({ maxConcurrency: 2 }),
      config: baseConfig(),
      parent: buildParent(),
      clock: () => 5000,
      idGen: seqId,
      emit: (e) => events.push(e),
    });

    await dispatcher.dispatch({ subagent_type: "general-purpose", description: "d", prompt: "p" });
    expect(events.map((e) => e.type)).toEqual([
      "subagent.start",
      "tool.call.start",
      "subagent.end",
    ]);
  });

  it("runner reason 'max_turns' maps to status 'max_turns' with end event", async () => {
    idCounter = 0;
    const events: Event[] = [];
    const dispatcher = new SubagentDispatcher({
      registry: registryWith([buildAgent()]),
      runner: makeMockRunner({
        summary: "out of turns",
        usage: { input_tokens: 1, output_tokens: 2 },
        turns: 20,
        reason: "max_turns",
      }),
      semaphore: createSubagentSemaphore({ maxConcurrency: 1 }),
      config: baseConfig(),
      parent: buildParent(),
      clock: () => 1,
      idGen: seqId,
      emit: (e) => events.push(e),
    });

    const result = await dispatcher.dispatch({
      subagent_type: "general-purpose",
      description: "d",
      prompt: "p",
    });
    expect(result.status).toBe("max_turns");
    expect(events.map((e) => e.type)).toEqual(["subagent.start", "subagent.end"]);
  });

  it("runner reason 'max_tokens' also maps to status 'max_turns'", async () => {
    idCounter = 0;
    const dispatcher = new SubagentDispatcher({
      registry: registryWith([buildAgent()]),
      runner: makeMockRunner({
        summary: "out of tokens",
        usage: { input_tokens: 1, output_tokens: 2 },
        turns: 5,
        reason: "max_tokens",
      }),
      semaphore: createSubagentSemaphore({ maxConcurrency: 1 }),
      config: baseConfig(),
      parent: buildParent(),
      idGen: seqId,
    });
    const result = await dispatcher.dispatch({
      subagent_type: "general-purpose",
      description: "d",
      prompt: "p",
    });
    expect(result.status).toBe("max_turns");
  });

  it("runner reason 'error' maps to status 'error'", async () => {
    idCounter = 0;
    const dispatcher = new SubagentDispatcher({
      registry: registryWith([buildAgent()]),
      runner: makeMockRunner({
        summary: "bad",
        usage: { input_tokens: 0, output_tokens: 0 },
        turns: 0,
        reason: "error",
        errorMessage: "boom",
      }),
      semaphore: createSubagentSemaphore({ maxConcurrency: 1 }),
      config: baseConfig(),
      parent: buildParent(),
      idGen: seqId,
    });
    const result = await dispatcher.dispatch({
      subagent_type: "general-purpose",
      description: "d",
      prompt: "p",
    });
    expect(result.status).toBe("error");
  });

  it("runner reason 'cancelled' maps to status 'cancelled'", async () => {
    idCounter = 0;
    const dispatcher = new SubagentDispatcher({
      registry: registryWith([buildAgent()]),
      runner: makeMockRunner({
        summary: "aborted",
        usage: { input_tokens: 0, output_tokens: 0 },
        turns: 0,
        reason: "cancelled",
      }),
      semaphore: createSubagentSemaphore({ maxConcurrency: 1 }),
      config: baseConfig(),
      parent: buildParent(),
      idGen: seqId,
    });
    const result = await dispatcher.dispatch({
      subagent_type: "general-purpose",
      description: "d",
      prompt: "p",
    });
    expect(result.status).toBe("cancelled");
  });

  it("NoUsableToolsError from context builder → error with end event, no start", async () => {
    idCounter = 0;
    const events: Event[] = [];
    // Agent requests only `Bash`, parent only allows `Read` → empty
    // intersection → NoUsableToolsError.
    const agent = buildAgent({
      frontmatter: {
        name: "general-purpose",
        description: "x",
        mode: "subagent",
        tools: ["Bash"],
        max_turns: 20,
        max_tokens: 100_000,
      },
    });
    const dispatcher = new SubagentDispatcher({
      registry: registryWith([agent]),
      runner: makeMockRunner(successResult()),
      semaphore: createSubagentSemaphore({ maxConcurrency: 1 }),
      config: baseConfig(),
      parent: buildParent({ allowedTools: ["Read"] }),
      idGen: seqId,
      emit: (e) => events.push(e),
    });

    const result = await dispatcher.dispatch({
      subagent_type: "general-purpose",
      description: "d",
      prompt: "p",
    });
    expect(result.status).toBe("error");
    expect(result.summary).toMatch(/no_usable_tools/);
    expect(events.map((e) => e.type)).toEqual(["subagent.end"]);
  });

  it("depth exceeded → error, summary 'subagent_depth_exceeded'", async () => {
    idCounter = 0;
    const events: Event[] = [];
    const dispatcher = new SubagentDispatcher({
      registry: registryWith([buildAgent()]),
      runner: makeMockRunner(successResult()),
      semaphore: createSubagentSemaphore({ maxConcurrency: 1 }),
      config: baseConfig({ maxDepth: 1 }),
      parent: buildParent({ depth: 1 }), // would be depth 2 > 1
      idGen: seqId,
      emit: (e) => events.push(e),
    });
    const result = await dispatcher.dispatch({
      subagent_type: "general-purpose",
      description: "d",
      prompt: "p",
    });
    expect(result.status).toBe("error");
    expect(result.summary).toMatch(/subagent_depth_exceeded/);
    expect(events.map((e) => e.type)).toEqual(["subagent.end"]);
  });

  it("caps concurrency: 5 dispatches, cap=3, peak activeCount === 3", async () => {
    idCounter = 0;
    const agent = buildAgent();
    const semaphore = createSubagentSemaphore({ maxConcurrency: 3 });
    const gates: Deferred<void>[] = [];

    const runner: SessionRunner = {
      async run() {
        const d = defer<void>();
        gates.push(d);
        await d.promise;
        return successResult();
      },
    };

    const dispatcher = new SubagentDispatcher({
      registry: registryWith([agent]),
      runner,
      semaphore,
      config: baseConfig(),
      parent: buildParent(),
      idGen: seqId,
    });

    const dispatches = Array.from({ length: 5 }, () =>
      dispatcher.dispatch({
        subagent_type: "general-purpose",
        description: "d",
        prompt: "p",
      }),
    );

    await flush();
    expect(gates.length).toBe(3);
    expect(semaphore.activeCount()).toBe(3);
    expect(semaphore.pendingCount()).toBe(2);

    const g0 = gates[0];
    const g1 = gates[1];
    if (!g0 || !g1) throw new Error("expected gates[0..1]");
    g0.resolve();
    g1.resolve();
    await flush();
    // After two release, the two queued dispatches start.
    expect(gates.length).toBe(5);

    for (const g of gates) g.resolve();
    const results = await Promise.all(dispatches);
    expect(results.every((r) => r.status === "success")).toBe(true);
    expect(semaphore.activeCount()).toBe(0);
  });

  it("parent abort propagates: pre-aborted signal → runner sees aborted signal", async () => {
    idCounter = 0;
    const parentController = new AbortController();
    parentController.abort(new Error("parent stopped"));
    const seen = vi.fn<(args: SessionRunArgs) => void>();
    const runner: SessionRunner = {
      // biome-ignore lint/suspicious/useAwait: SessionRunner contract is async; test stub does not await.
      async run(args) {
        seen(args);
        return {
          summary: "cancelled",
          usage: { input_tokens: 0, output_tokens: 0 },
          turns: 0,
          reason: "cancelled",
        };
      },
    };

    const dispatcher = new SubagentDispatcher({
      registry: registryWith([buildAgent()]),
      runner,
      semaphore: createSubagentSemaphore({ maxConcurrency: 1 }),
      config: baseConfig(),
      parent: buildParent(),
      idGen: seqId,
      signal: parentController.signal,
    });

    const result = await dispatcher.dispatch({
      subagent_type: "general-purpose",
      description: "d",
      prompt: "p",
    });
    expect(result.status).toBe("cancelled");
    expect(seen).toHaveBeenCalledOnce();
    const firstCall = seen.mock.calls[0];
    if (!firstCall) throw new Error("expected runner to be called");
    const args = firstCall[0];
    expect(args.signal.aborted).toBe(true);
  });

  it("a throwing emit listener does not break dispatch", async () => {
    idCounter = 0;
    const events: Event[] = [];
    let callCount = 0;
    const dispatcher = new SubagentDispatcher({
      registry: registryWith([buildAgent()]),
      runner: makeMockRunner(successResult()),
      semaphore: createSubagentSemaphore({ maxConcurrency: 1 }),
      config: baseConfig(),
      parent: buildParent(),
      idGen: seqId,
      emit: (e) => {
        callCount += 1;
        if (callCount === 1) throw new Error("listener boom");
        events.push(e);
      },
    });

    const result = await dispatcher.dispatch({
      subagent_type: "general-purpose",
      description: "d",
      prompt: "p",
    });
    expect(result.status).toBe("success");
    // First emit (start) threw; second emit (end) was captured.
    expect(events.map((e) => e.type)).toEqual(["subagent.end"]);
  });

  it("returned SubagentResult is JSON round-trippable", async () => {
    idCounter = 0;
    const dispatcher = new SubagentDispatcher({
      registry: registryWith([buildAgent()]),
      runner: makeMockRunner(successResult("hello")),
      semaphore: createSubagentSemaphore({ maxConcurrency: 1 }),
      config: baseConfig(),
      parent: buildParent(),
      idGen: seqId,
    });
    const result = await dispatcher.dispatch({
      subagent_type: "general-purpose",
      description: "d",
      prompt: "p",
    });
    const roundTripped = JSON.parse(JSON.stringify(result));
    expect(roundTripped).toEqual(result);
  });

  it("createSubagentDispatcher convenience factory returns a SubagentService", async () => {
    idCounter = 0;
    const svc = createSubagentDispatcher({
      registry: registryWith([buildAgent()]),
      runner: makeMockRunner(successResult("ok")),
      semaphore: createSubagentSemaphore({ maxConcurrency: 1 }),
      config: baseConfig(),
      parent: buildParent(),
      idGen: seqId,
    });
    const result = await svc.dispatch({
      subagent_type: "general-purpose",
      description: "d",
      prompt: "p",
    });
    expect(result.status).toBe("success");
    expect(result.summary).toBe("ok");
  });
});
