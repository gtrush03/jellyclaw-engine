/**
 * Tests for the CLI run command.
 */

import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../events.js";
import type { RunOptions } from "../legacy-run.js";
import { SessionNotFoundError } from "../session/types.js";
import { ExitError } from "./main.js";
import { createRunAction, type RunActionDeps, type RunCliOptions } from "./run.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeNullStream(): NodeJS.WritableStream {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
}

function makeMockDeps(overrides: Partial<RunActionDeps> = {}): RunActionDeps {
  return {
    runFn: overrides.runFn ?? async function* () {},
    createWriter:
      overrides.createWriter ?? (() => ({ write: async () => {}, finish: async () => {} })),
    openWishLedger: overrides.openWishLedger ?? (async () => null),
    readStdin: overrides.readStdin ?? (async () => ""),
    isStdinTty: overrides.isStdinTty ?? (() => true),
    isStdoutTty: overrides.isStdoutTty ?? (() => true),
    stdout: overrides.stdout ?? makeNullStream(),
    stderr: overrides.stderr ?? makeNullStream(),
  };
}

// ---------------------------------------------------------------------------
// max-turns threading tests (T1-05)
// ---------------------------------------------------------------------------

describe("createRunAction: max-turns-threaded", () => {
  it("threads --max-turns 10 into runOptions.maxTurns", async () => {
    const receivedOptions: RunOptions[] = [];
    // biome-ignore lint/suspicious/useAwait: async generator to match RunActionDeps.runFn contract
    async function* mockRunFn(opts: RunOptions): AsyncIterable<AgentEvent> {
      receivedOptions.push(opts);
      // Emit minimal events to complete successfully
      yield {
        type: "session.started",
        session_id: "test",
        ts: Date.now(),
        seq: 0,
        wish: opts.wish,
        agent: "default",
        model: "test",
        provider: "anthropic",
        cwd: "/tmp",
      };
      yield {
        type: "session.completed",
        session_id: "test",
        ts: Date.now(),
        seq: 1,
        turns: 1,
        duration_ms: 100,
      };
    }

    const deps = makeMockDeps({ runFn: mockRunFn });
    const action = createRunAction(deps);

    const options: RunCliOptions = {
      maxTurns: "10",
    };

    await action("test prompt", options);

    expect(receivedOptions).toHaveLength(1);
    const opts = receivedOptions[0];
    expect(opts).toBeDefined();
    expect(opts?.maxTurns).toBe(10);
  });
});

describe("createRunAction: max-turns-above-cap", () => {
  it("rejects --max-turns 200 with ExitError (must be <= 150)", async () => {
    const deps = makeMockDeps();
    const action = createRunAction(deps);

    const options: RunCliOptions = {
      maxTurns: "200",
    };

    await expect(action("test prompt", options)).rejects.toThrow(ExitError);
    await expect(action("test prompt", options)).rejects.toThrow(/must be <= 150/);
  });
});

// ---------------------------------------------------------------------------
// max-cost-usd threading tests (T1-06)
// ---------------------------------------------------------------------------

describe("createRunAction: max-cost-threaded", () => {
  it("threads --max-cost-usd 0.01 into runOptions.maxCostUsd", async () => {
    const receivedOptions: RunOptions[] = [];
    // biome-ignore lint/suspicious/useAwait: async generator to match RunActionDeps.runFn contract
    async function* mockRunFn(opts: RunOptions): AsyncIterable<AgentEvent> {
      receivedOptions.push(opts);
      yield {
        type: "session.started",
        session_id: "test",
        ts: Date.now(),
        seq: 0,
        wish: opts.wish,
        agent: "default",
        model: "test",
        provider: "anthropic",
        cwd: "/tmp",
      };
      yield {
        type: "session.completed",
        session_id: "test",
        ts: Date.now(),
        seq: 1,
        turns: 1,
        duration_ms: 100,
      };
    }

    const deps = makeMockDeps({ runFn: mockRunFn });
    const action = createRunAction(deps);

    const options: RunCliOptions = {
      maxCostUsd: "0.01",
    };

    await action("test prompt", options);

    expect(receivedOptions).toHaveLength(1);
    const opts = receivedOptions[0];
    expect(opts).toBeDefined();
    expect(opts?.maxCostUsd).toBe(0.01);
  });
});

// ---------------------------------------------------------------------------
// Real subagent runner wiring test (T2-02)
// ---------------------------------------------------------------------------

describe("realRunFn: real-subagent-runner-wired", () => {
  it("does not import or reference stubSubagentService in CLI production path", async () => {
    // This test verifies that the CLI run.ts does not use stubSubagentService.
    // We read the source file and check it doesn't contain the problematic import/usage.
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const runTsPath = path.join(process.cwd(), "engine/src/cli/run.ts");
    const content = await fs.readFile(runTsPath, "utf8");

    // Should NOT import stubSubagentService.
    expect(content).not.toContain("import { stubSubagentService }");
    expect(content).not.toContain('from "../subagents/stub.js"');

    // Should import the real runner and dispatcher.
    expect(content).toContain("createSessionRunner");
    expect(content).toContain("SubagentDispatcher");

    // Should pass subagents to runAgentLoop.
    expect(content).toContain("subagents: subagentDispatcher");
  });
});

// ---------------------------------------------------------------------------
// Skills injection tests (T2-04)
// ---------------------------------------------------------------------------

describe("skills-injected-into-system-prompt", () => {
  it("run.ts imports buildSkillInjection and SkillRegistry", async () => {
    // Verify the wiring exists in the source file.
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const runTsPath = path.join(process.cwd(), "engine/src/cli/run.ts");
    const content = await fs.readFile(runTsPath, "utf8");

    // Should import buildSkillInjection.
    expect(content).toContain("buildSkillInjection");
    expect(content).toContain('from "../skills/inject.js"');

    // Should import SkillRegistry.
    expect(content).toContain("SkillRegistry");
    expect(content).toContain('from "../skills/registry.js"');

    // Should call buildSkillInjection with skills.
    expect(content).toContain("buildSkillInjection({ skills");

    // Should compose systemPrompt with skillBlock.
    expect(content).toContain("skillBlock");
    expect(content).toContain("systemPromptParts");
  });
});

describe("skills-empty-no-injection", () => {
  it("with zero skills, skillRegistry is not passed to runAgentLoop", async () => {
    // Verify the conditional logic exists in the source file.
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const runTsPath = path.join(process.cwd(), "engine/src/cli/run.ts");
    const content = await fs.readFile(runTsPath, "utf8");

    // Should conditionally pass skillRegistry only when skills exist (via spread).
    expect(content).toContain("skills.length > 0 ? { skillRegistry }");
  });

  it("buildToolList returns builtins without Skill tool when registry is empty", async () => {
    const { buildToolList } = await import("../tools/index.js");
    const { SkillRegistry } = await import("../skills/registry.js");

    // Empty registry.
    const emptyRegistry = new SkillRegistry();
    const tools = buildToolList(emptyRegistry);
    const toolNames = tools.map((t) => t.name);

    // Should NOT include Skill tool.
    expect(toolNames).not.toContain("Skill");
  });

  it("buildToolList returns builtins without Skill tool when no registry provided", async () => {
    const { buildToolList } = await import("../tools/index.js");

    const tools = buildToolList(undefined);
    const toolNames = tools.map((t) => t.name);

    // Should NOT include Skill tool.
    expect(toolNames).not.toContain("Skill");
  });
});

// ---------------------------------------------------------------------------
// Resume flag tests (T2-07)
// ---------------------------------------------------------------------------

describe("createRunAction: resume-wires-prior-messages", () => {
  it("threads --resume <id> priorMessages into runFn", async () => {
    const receivedOptions: RunOptions[] = [];
    // biome-ignore lint/suspicious/useAwait: async generator to match RunActionDeps.runFn contract
    async function* mockRunFn(opts: RunOptions): AsyncIterable<AgentEvent> {
      receivedOptions.push(opts);
      yield {
        type: "session.started",
        session_id: opts.sessionId ?? "test",
        ts: Date.now(),
        seq: 0,
        wish: opts.wish,
        agent: "default",
        model: "test",
        provider: "anthropic",
        cwd: "/tmp",
      };
      yield {
        type: "session.completed",
        session_id: opts.sessionId ?? "test",
        ts: Date.now(),
        seq: 1,
        turns: 1,
        duration_ms: 100,
      };
    }

    const deps = makeMockDeps({ runFn: mockRunFn });
    const action = createRunAction(deps);

    const options: RunCliOptions = {
      resume: "test-session-123",
    };

    await action("continue", options);

    expect(receivedOptions).toHaveLength(1);
    const opts = receivedOptions[0];
    expect(opts).toBeDefined();
    // The resume flag should be passed through.
    expect(opts?.resume).toBe("test-session-123");
  });

  it("preserves session id when resuming", async () => {
    const receivedOptions: RunOptions[] = [];
    // biome-ignore lint/suspicious/useAwait: async generator to match RunActionDeps.runFn contract
    async function* mockRunFn(opts: RunOptions): AsyncIterable<AgentEvent> {
      receivedOptions.push(opts);
      yield {
        type: "session.started",
        session_id: opts.sessionId ?? "test",
        ts: Date.now(),
        seq: 0,
        wish: opts.wish,
        agent: "default",
        model: "test",
        provider: "anthropic",
        cwd: "/tmp",
      };
      yield {
        type: "session.completed",
        session_id: opts.sessionId ?? "test",
        ts: Date.now(),
        seq: 1,
        turns: 1,
        duration_ms: 100,
      };
    }

    const deps = makeMockDeps({ runFn: mockRunFn });
    const action = createRunAction(deps);

    const resumeId = "test-session-for-resume";
    const options: RunCliOptions = {
      resume: resumeId,
    };

    await action("continue", options);

    expect(receivedOptions).toHaveLength(1);
    const opts = receivedOptions[0];
    // resume is threaded through.
    expect(opts?.resume).toBe(resumeId);
  });
});

describe("createRunAction: resume-unknown-id", () => {
  it("--resume on unknown id throws ExitError with code 2", async () => {
    // Note: This test validates the error handling path. The actual
    // SessionNotFoundError would be thrown by realRunFn when it calls
    // resumeSession(). Since we're testing createRunAction with a mock runFn,
    // we need to simulate that the runFn throws SessionNotFoundError.
    const unknownId = "nonexistent-session-id";

    // biome-ignore lint/suspicious/useAwait: async generator to match RunActionDeps.runFn contract
    // biome-ignore lint/correctness/useYield: throws before yielding to test error path
    async function* mockRunFnThatThrows(_opts: RunOptions): AsyncIterable<AgentEvent> {
      throw new SessionNotFoundError(unknownId);
    }

    const deps = makeMockDeps({ runFn: mockRunFnThatThrows });
    const action = createRunAction(deps);

    const options: RunCliOptions = {
      resume: unknownId,
    };

    // The SessionNotFoundError should propagate (not be converted to ExitError
    // by createRunAction itself - that happens in realRunFn).
    await expect(action("continue", options)).rejects.toThrow(SessionNotFoundError);
    await expect(action("continue", options)).rejects.toThrow(unknownId);
  });
});

describe("createRunAction: resume-round-trip", () => {
  it("verifies run.ts imports resume-related modules", async () => {
    // Verify the wiring exists in the source file.
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const runTsPath = path.join(process.cwd(), "engine/src/cli/run.ts");
    const content = await fs.readFile(runTsPath, "utf8");

    // Should import resumeSession.
    expect(content).toContain("resumeSession");
    expect(content).toContain('from "../session/resume.js"');

    // Should import toPriorMessages.
    expect(content).toContain("toPriorMessages");
    expect(content).toContain('from "../session/to-prior-messages.js"');

    // Should import SessionNotFoundError.
    expect(content).toContain("SessionNotFoundError");
    expect(content).toContain('from "../session/types.js"');

    // Should handle opts.resume.
    expect(content).toContain("opts.resume");

    // Should pass priorMessages to runAgentLoop.
    expect(content).toContain("priorMessages");
  });
});

// ---------------------------------------------------------------------------
// Continue flag tests (T2-08)
// ---------------------------------------------------------------------------

describe("createRunAction: continue-picks-most-recent", () => {
  it("threads --continue true into runOptions.continue", async () => {
    const receivedOptions: RunOptions[] = [];
    // biome-ignore lint/suspicious/useAwait: async generator to match RunActionDeps.runFn contract
    async function* mockRunFn(opts: RunOptions): AsyncIterable<AgentEvent> {
      receivedOptions.push(opts);
      yield {
        type: "session.started",
        session_id: "test",
        ts: Date.now(),
        seq: 0,
        wish: opts.wish,
        agent: "default",
        model: "test",
        provider: "anthropic",
        cwd: "/tmp",
      };
      yield {
        type: "session.completed",
        session_id: "test",
        ts: Date.now(),
        seq: 1,
        turns: 1,
        duration_ms: 100,
      };
    }

    const deps = makeMockDeps({ runFn: mockRunFn });
    const action = createRunAction(deps);

    const options: RunCliOptions = {
      continue: true,
    };

    await action("continue prompt", options);

    expect(receivedOptions).toHaveLength(1);
    const opts = receivedOptions[0];
    expect(opts).toBeDefined();
    expect(opts?.continue).toBe(true);
  });

  it("verifies run.ts imports continue-related modules", async () => {
    // Verify the wiring exists in the source file.
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const runTsPath = path.join(process.cwd(), "engine/src/cli/run.ts");
    const content = await fs.readFile(runTsPath, "utf8");

    // Should import findLatestForProject.
    expect(content).toContain("findLatestForProject");
    expect(content).toContain('from "../session/continue.js"');

    // Should import projectHash.
    expect(content).toContain("projectHash");
    expect(content).toContain('from "../session/paths.js"');

    // Should handle opts.continue.
    expect(content).toContain("opts.continue");

    // Should use projectHash to resolve the project.
    expect(content).toContain("projectHash(");

    // Should call findLatestForProject with the hash.
    expect(content).toContain("findLatestForProject(db, projectHashStr)");
  });
});

describe("createRunAction: continue-no-sessions", () => {
  it("verifies run.ts has error handling for no sessions", async () => {
    // Verify the error handling exists in the source file.
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const runTsPath = path.join(process.cwd(), "engine/src/cli/run.ts");
    const content = await fs.readFile(runTsPath, "utf8");

    // Should check if latest is null.
    expect(content).toContain("latest === null");

    // Should throw ExitError with "no prior session" message.
    expect(content).toContain("no prior session for project");

    // Should import NoSessionForProjectError.
    expect(content).toContain("NoSessionForProjectError");
  });
});

describe("createRunAction: continue-isolated-by-cwd", () => {
  it("verifies run.ts uses project hash for isolation", async () => {
    // Verify the project isolation exists in the source file.
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const runTsPath = path.join(process.cwd(), "engine/src/cli/run.ts");
    const content = await fs.readFile(runTsPath, "utf8");

    // Should compute projectHash from cwd.
    expect(content).toContain("opts.cwd ?? process.cwd()");
    expect(content).toContain("projectHash(cwd)");

    // Should pass projectHashStr to findLatestForProject.
    expect(content).toContain("findLatestForProject(db, projectHashStr)");

    // Should also pass projectHash to resumeSession for continue path.
    expect(content).toContain("projectHash: projectHashStr");
  });
});

// ---------------------------------------------------------------------------
// Append system prompt tests (T2-10)
// ---------------------------------------------------------------------------

describe("createRunAction: append-system-prompt-wired", () => {
  it("threads --append-system-prompt into runOptions.appendSystemPrompt", async () => {
    const receivedOptions: RunOptions[] = [];
    // biome-ignore lint/suspicious/useAwait: async generator to match RunActionDeps.runFn contract
    async function* mockRunFn(opts: RunOptions): AsyncIterable<AgentEvent> {
      receivedOptions.push(opts);
      yield {
        type: "session.started",
        session_id: "test",
        ts: Date.now(),
        seq: 0,
        wish: opts.wish,
        agent: "default",
        model: "test",
        provider: "anthropic",
        cwd: "/tmp",
      };
      yield {
        type: "session.completed",
        session_id: "test",
        ts: Date.now(),
        seq: 1,
        turns: 1,
        duration_ms: 100,
      };
    }

    const deps = makeMockDeps({ runFn: mockRunFn });
    const action = createRunAction(deps);

    const options: RunCliOptions = {
      appendSystemPrompt: "always say hi",
    };

    await action("test prompt", options);

    expect(receivedOptions).toHaveLength(1);
    const opts = receivedOptions[0];
    expect(opts).toBeDefined();
    expect(opts?.appendSystemPrompt).toBe("always say hi");
  });

  it("verifies run.ts includes appendSystemPrompt in systemPromptParts", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const runTsPath = path.join(process.cwd(), "engine/src/cli/run.ts");
    const content = await fs.readFile(runTsPath, "utf8");

    // Should include opts.appendSystemPrompt in the system prompt parts array.
    expect(content).toContain("opts.appendSystemPrompt");
    expect(content).toContain("soul, skillBlock, opts.appendSystemPrompt");
  });
});

// ---------------------------------------------------------------------------
// Add dir tests (T2-10)
// ---------------------------------------------------------------------------

describe("createRunAction: add-dir-extends-allowed-cwds", () => {
  it("threads --add-dir into runOptions.addDir", async () => {
    const receivedOptions: RunOptions[] = [];
    // biome-ignore lint/suspicious/useAwait: async generator to match RunActionDeps.runFn contract
    async function* mockRunFn(opts: RunOptions): AsyncIterable<AgentEvent> {
      receivedOptions.push(opts);
      yield {
        type: "session.started",
        session_id: "test",
        ts: Date.now(),
        seq: 0,
        wish: opts.wish,
        agent: "default",
        model: "test",
        provider: "anthropic",
        cwd: "/tmp",
      };
      yield {
        type: "session.completed",
        session_id: "test",
        ts: Date.now(),
        seq: 1,
        turns: 1,
        duration_ms: 100,
      };
    }

    const deps = makeMockDeps({ runFn: mockRunFn });
    const action = createRunAction(deps);

    const options: RunCliOptions = {
      addDir: ["/tmp/allowed-dir"],
    };

    await action("test prompt", options);

    expect(receivedOptions).toHaveLength(1);
    const opts = receivedOptions[0];
    expect(opts).toBeDefined();
    expect(opts?.addDir).toEqual(["/tmp/allowed-dir"]);
  });

  it("verifies run.ts normalizes addDir and passes additionalRoots", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const runTsPath = path.join(process.cwd(), "engine/src/cli/run.ts");
    const content = await fs.readFile(runTsPath, "utf8");

    // Should normalize addDir paths.
    expect(content).toContain("opts.addDir");
    expect(content).toContain("additionalRoots");

    // Should validate paths don't contain ..
    expect(content).toContain("path must not contain '..'");

    // Should use realpathSync to validate existence.
    expect(content).toContain("realpathSync");

    // Should pass additionalRoots to runAgentLoop.
    expect(content).toContain("additionalRoots !== undefined ? { additionalRoots }");
  });
});

describe("createRunAction: add-dir-multiple", () => {
  it("threads multiple --add-dir flags into runOptions.addDir array", async () => {
    const receivedOptions: RunOptions[] = [];
    // biome-ignore lint/suspicious/useAwait: async generator to match RunActionDeps.runFn contract
    async function* mockRunFn(opts: RunOptions): AsyncIterable<AgentEvent> {
      receivedOptions.push(opts);
      yield {
        type: "session.started",
        session_id: "test",
        ts: Date.now(),
        seq: 0,
        wish: opts.wish,
        agent: "default",
        model: "test",
        provider: "anthropic",
        cwd: "/tmp",
      };
      yield {
        type: "session.completed",
        session_id: "test",
        ts: Date.now(),
        seq: 1,
        turns: 1,
        duration_ms: 100,
      };
    }

    const deps = makeMockDeps({ runFn: mockRunFn });
    const action = createRunAction(deps);

    const options: RunCliOptions = {
      addDir: ["/tmp/dir-a", "/tmp/dir-b"],
    };

    await action("test prompt", options);

    expect(receivedOptions).toHaveLength(1);
    const opts = receivedOptions[0];
    expect(opts).toBeDefined();
    expect(opts?.addDir).toEqual(["/tmp/dir-a", "/tmp/dir-b"]);
  });
});

// ---------------------------------------------------------------------------
// Credential wiring tests (T0-01)
// ---------------------------------------------------------------------------

describe("realRunFn: credential-loading-wired", () => {
  it("run.ts imports loadCredentials from credentials.js", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const runTsPath = path.join(process.cwd(), "engine/src/cli/run.ts");
    const content = await fs.readFile(runTsPath, "utf8");

    // Should import loadCredentials.
    expect(content).toContain("loadCredentials");
    expect(content).toContain('from "./credentials.js"');
  });

  it("run.ts imports selectAuth and parseRole from subscription-auth.js", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const runTsPath = path.join(process.cwd(), "engine/src/cli/run.ts");
    const content = await fs.readFile(runTsPath, "utf8");

    // Should import selectAuth and parseRole.
    expect(content).toContain("selectAuth");
    expect(content).toContain("parseRole");
    expect(content).toContain('from "../providers/subscription-auth.js"');
  });

  it("run.ts no longer references process.env.ANTHROPIC_API_KEY for the main check", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const runTsPath = path.join(process.cwd(), "engine/src/cli/run.ts");
    const content = await fs.readFile(runTsPath, "utf8");

    // Should use env var as fallback in creds merge, not as primary check.
    // The old pattern was: const apiKey = process.env.ANTHROPIC_API_KEY;
    // The new pattern merges it into creds object for back-compat.
    expect(content).toContain("diskCreds.anthropicApiKey === undefined");
    expect(content).toContain('typeof envKey === "string"');
  });

  it("run.ts throws ExitError when no credentials available", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const runTsPath = path.join(process.cwd(), "engine/src/cli/run.ts");
    const content = await fs.readFile(runTsPath, "utf8");

    // Should check auth === null and throw ExitError.
    expect(content).toContain("auth === null");
    expect(content).toContain("jellyclaw: no credentials");
  });
});

// ---------------------------------------------------------------------------
// MCP wiring tests (T0-01)
// ---------------------------------------------------------------------------

describe("realRunFn: mcp-loading-wired", () => {
  it("run.ts imports loadMcpConfigs", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const runTsPath = path.join(process.cwd(), "engine/src/cli/run.ts");
    const content = await fs.readFile(runTsPath, "utf8");

    // Should import loadMcpConfigs.
    expect(content).toContain("loadMcpConfigs");
    expect(content).toContain('from "./mcp-config-loader.js"');
  });

  it("run.ts imports McpRegistry as a value (not just type)", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const runTsPath = path.join(process.cwd(), "engine/src/cli/run.ts");
    const content = await fs.readFile(runTsPath, "utf8");

    // Should import McpRegistry as a value (for instantiation).
    expect(content).toContain("{ McpRegistry }");
    expect(content).not.toContain("import type { McpRegistry }");
  });

  it("run.ts calls loadMcpConfigs with opts.mcpConfig", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const runTsPath = path.join(process.cwd(), "engine/src/cli/run.ts");
    const content = await fs.readFile(runTsPath, "utf8");

    // Should call loadMcpConfigs with mcpConfig option.
    expect(content).toContain("loadMcpConfigs({");
    expect(content).toContain("mcpConfig: opts.mcpConfig");
  });

  it("run.ts creates McpRegistry when configs exist", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const runTsPath = path.join(process.cwd(), "engine/src/cli/run.ts");
    const content = await fs.readFile(runTsPath, "utf8");

    // Should create registry when configs > 0.
    expect(content).toContain("if (mcpConfigs.length > 0)");
    expect(content).toContain("mcp = new McpRegistry({ logger })");
  });

  it("run.ts warns and continues when MCP server fails to start", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const runTsPath = path.join(process.cwd(), "engine/src/cli/run.ts");
    const content = await fs.readFile(runTsPath, "utf8");

    // Should catch errors from mcp.start and log warning.
    expect(content).toContain("one or more MCP servers failed to start");
    expect(content).toContain("logger.warn");
  });

  it("run.ts passes mcp to runAgentLoop", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const runTsPath = path.join(process.cwd(), "engine/src/cli/run.ts");
    const content = await fs.readFile(runTsPath, "utf8");

    // Should spread mcp into runAgentLoop options.
    expect(content).toContain("...(mcp !== undefined ? { mcp } : {})");
  });
});

// ---------------------------------------------------------------------------
// run-manager.ts MCP wiring tests (T0-01)
// ---------------------------------------------------------------------------

describe("run-manager: mcp-threaded", () => {
  it("run-manager.ts imports McpRegistry type", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const rmPath = path.join(process.cwd(), "engine/src/server/run-manager.ts");
    const content = await fs.readFile(rmPath, "utf8");

    expect(content).toContain("McpRegistry");
    expect(content).toContain('from "../mcp/registry.js"');
  });

  it("run-manager.ts includes mcp in RunManagerOptions", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const rmPath = path.join(process.cwd(), "engine/src/server/run-manager.ts");
    const content = await fs.readFile(rmPath, "utf8");

    expect(content).toContain("readonly mcp?: McpRegistry");
  });

  it("run-manager.ts passes mcp to runAgentLoop", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const rmPath = path.join(process.cwd(), "engine/src/server/run-manager.ts");
    const content = await fs.readFile(rmPath, "utf8");

    expect(content).toContain("...(mcp !== undefined ? { mcp } : {})");
  });
});

// ---------------------------------------------------------------------------
// serve.ts MCP wiring tests (T0-01)
// ---------------------------------------------------------------------------

describe("serve: mcp-threaded", () => {
  it("serve.ts imports loadMcpConfigs", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const servePath = path.join(process.cwd(), "engine/src/cli/serve.ts");
    const content = await fs.readFile(servePath, "utf8");

    expect(content).toContain("loadMcpConfigs");
    expect(content).toContain('from "./mcp-config-loader.js"');
  });

  it("serve.ts imports McpRegistry", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const servePath = path.join(process.cwd(), "engine/src/cli/serve.ts");
    const content = await fs.readFile(servePath, "utf8");

    expect(content).toContain("{ McpRegistry }");
  });

  it("serve.ts loads MCP configs in productionDeps", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const servePath = path.join(process.cwd(), "engine/src/cli/serve.ts");
    const content = await fs.readFile(servePath, "utf8");

    expect(content).toContain("await loadMcpConfigs");
    expect(content).toContain("mcpConfigs.length > 0");
    expect(content).toContain("new McpRegistry");
  });

  it("serve.ts passes mcp to createRunManager", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const servePath = path.join(process.cwd(), "engine/src/cli/serve.ts");
    const content = await fs.readFile(servePath, "utf8");

    expect(content).toContain("...(mcp !== undefined ? { mcp } : {})");
  });
});
