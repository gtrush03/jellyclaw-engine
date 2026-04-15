import { describe, expect, it } from "vitest";
import { buildSubagentContext } from "./context.js";
import {
  type DispatchConfig,
  NoUsableToolsError,
  type ParentContext,
  SubagentDepthExceededError,
} from "./dispatch-types.js";
import type { Agent, AgentFrontmatter } from "./types.js";

function makeAgent(
  overrides: Partial<AgentFrontmatter> & { prompt?: string; name?: string } = {},
): Agent {
  const {
    prompt = "You are a helpful reviewer.",
    name = overrides.name ?? "reviewer",
    ...frontmatterOverrides
  } = overrides;

  const frontmatter: AgentFrontmatter = {
    name,
    description: "Reviews code",
    mode: "subagent",
    max_turns: 20,
    max_tokens: 100_000,
    ...frontmatterOverrides,
  };

  return {
    name,
    frontmatter,
    prompt,
    path: `/fake/${name}.md`,
    source: "project",
    mtimeMs: 0,
  };
}

function makeParent(overrides: Partial<ParentContext> = {}): ParentContext {
  return {
    sessionId: "parent-session-1",
    allowedTools: ["Read", "Bash", "Edit"],
    model: "claude-opus-4-6",
    depth: 0,
    ...overrides,
  };
}

const config: DispatchConfig = { maxConcurrency: 3, maxDepth: 2 };

describe("buildSubagentContext", () => {
  it("builds a context on the happy path", () => {
    const agent = makeAgent({ tools: ["Read", "Bash"] });
    const parent = makeParent({ claudeMd: "# Project rules\nBe kind." });

    const ctx = buildSubagentContext({
      agent,
      parent,
      description: "review the diff",
      prompt: "look at HEAD",
      config,
      subagentSessionId: "child-1",
    });

    expect(ctx.allowedTools).toEqual(["Read", "Bash"]);
    expect(ctx.model).toBe(parent.model);
    expect(ctx.systemPrompt).toBe(`${parent.claudeMd}\n\n${agent.prompt}`);
    expect(ctx.depth).toBe(1);
    expect(ctx.parentSessionId).toBe(parent.sessionId);
    expect(ctx.subagentSessionId).toBe("child-1");
    expect(ctx.agentName).toBe(agent.name);
    expect(ctx.description).toBe("review the diff");
    expect(ctx.prompt).toBe("look at HEAD");
  });

  it("inherits parent allowedTools when agent.tools is undefined", () => {
    const agent = makeAgent(); // tools undefined
    const parent = makeParent({ allowedTools: ["Read", "Bash", "Edit"] });

    const ctx = buildSubagentContext({
      agent,
      parent,
      description: "",
      prompt: "",
      config,
      subagentSessionId: "c",
    });

    expect(ctx.allowedTools).toEqual(["Read", "Bash", "Edit"]);
  });

  it("intersects agent.tools with parent.allowedTools, preserving agent order", () => {
    const agent = makeAgent({ tools: ["Read", "Write", "Glob"] });
    const parent = makeParent({ allowedTools: ["Read", "Bash"] });

    const ctx = buildSubagentContext({
      agent,
      parent,
      description: "",
      prompt: "",
      config,
      subagentSessionId: "c",
    });

    expect(ctx.allowedTools).toEqual(["Read"]);
  });

  it("de-duplicates agent.tools while preserving order", () => {
    const agent = makeAgent({ tools: ["Read", "Read", "Bash"] });
    const parent = makeParent({ allowedTools: ["Read", "Bash"] });

    const ctx = buildSubagentContext({
      agent,
      parent,
      description: "",
      prompt: "",
      config,
      subagentSessionId: "c",
    });

    expect(ctx.allowedTools).toEqual(["Read", "Bash"]);
  });

  it("throws NoUsableToolsError when intersection is empty", () => {
    const agent = makeAgent({ name: "writer", tools: ["Write"] });
    const parent = makeParent({ allowedTools: ["Read"] });

    let caught: unknown;
    try {
      buildSubagentContext({
        agent,
        parent,
        description: "",
        prompt: "",
        config,
        subagentSessionId: "c",
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(NoUsableToolsError);
    const err = caught as NoUsableToolsError;
    expect(err.agentName).toBe("writer");
    expect(err.requested).toEqual(["Write"]);
    expect(err.parentAllowed).toEqual(["Read"]);
  });

  it("throws SubagentDepthExceededError when child depth would exceed maxDepth", () => {
    const agent = makeAgent({ tools: ["Read"] });
    const parent = makeParent({ depth: 2 });

    let caught: unknown;
    try {
      buildSubagentContext({
        agent,
        parent,
        description: "",
        prompt: "",
        config: { maxConcurrency: 3, maxDepth: 2 },
        subagentSessionId: "c",
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SubagentDepthExceededError);
    const err = caught as SubagentDepthExceededError;
    expect(err.depth).toBe(3);
    expect(err.maxDepth).toBe(2);
  });

  it("builds cleanly when parent.depth + 1 equals maxDepth", () => {
    const agent = makeAgent({ tools: ["Read"] });
    const parent = makeParent({ depth: 1 });

    const ctx = buildSubagentContext({
      agent,
      parent,
      description: "",
      prompt: "",
      config: { maxConcurrency: 3, maxDepth: 2 },
      subagentSessionId: "c",
    });
    expect(ctx.depth).toBe(2);
  });

  it("uses agent.frontmatter.model when set", () => {
    const agent = makeAgent({ tools: ["Read"], model: "claude-haiku-4" });
    const parent = makeParent({ model: "claude-opus-4-6" });

    const ctx = buildSubagentContext({
      agent,
      parent,
      description: "",
      prompt: "",
      config,
      subagentSessionId: "c",
    });
    expect(ctx.model).toBe("claude-haiku-4");
  });

  it("falls back to parent.model when agent.model is undefined", () => {
    const agent = makeAgent({ tools: ["Read"] });
    const parent = makeParent({ model: "claude-opus-4-6" });

    const ctx = buildSubagentContext({
      agent,
      parent,
      description: "",
      prompt: "",
      config,
      subagentSessionId: "c",
    });
    expect(ctx.model).toBe("claude-opus-4-6");
  });

  it("systemPrompt === agent.prompt when claudeMd is absent", () => {
    const agent = makeAgent({ tools: ["Read"], prompt: "body" });
    const parent = makeParent(); // no claudeMd

    const ctx = buildSubagentContext({
      agent,
      parent,
      description: "",
      prompt: "",
      config,
      subagentSessionId: "c",
    });
    expect(ctx.systemPrompt).toBe("body");
  });

  it("systemPrompt === agent.prompt when claudeMd is empty string", () => {
    const agent = makeAgent({ tools: ["Read"], prompt: "body" });
    const parent = makeParent({ claudeMd: "" });

    const ctx = buildSubagentContext({
      agent,
      parent,
      description: "",
      prompt: "",
      config,
      subagentSessionId: "c",
    });
    expect(ctx.systemPrompt).toBe("body");
  });

  it("prefixes claudeMd + two newlines when present", () => {
    const agent = makeAgent({ tools: ["Read"], prompt: "body" });
    const parent = makeParent({ claudeMd: "RULES" });

    const ctx = buildSubagentContext({
      agent,
      parent,
      description: "",
      prompt: "",
      config,
      subagentSessionId: "c",
    });
    expect(ctx.systemPrompt).toBe("RULES\n\nbody");
  });

  it("passes maxTurns / maxTokens through from frontmatter", () => {
    const agent = makeAgent({ tools: ["Read"], max_turns: 7, max_tokens: 1234 });
    const parent = makeParent();

    const ctx = buildSubagentContext({
      agent,
      parent,
      description: "",
      prompt: "",
      config,
      subagentSessionId: "c",
    });
    expect(ctx.maxTurns).toBe(7);
    expect(ctx.maxTokens).toBe(1234);
  });

  it("returns skills array from frontmatter or [] when absent", () => {
    const withSkills = makeAgent({ tools: ["Read"], skills: ["foo", "bar"] });
    const ctxA = buildSubagentContext({
      agent: withSkills,
      parent: makeParent(),
      description: "",
      prompt: "",
      config,
      subagentSessionId: "c",
    });
    expect(ctxA.skills).toEqual(["foo", "bar"]);

    const noSkills = makeAgent({ tools: ["Read"] });
    const ctxB = buildSubagentContext({
      agent: noSkills,
      parent: makeParent(),
      description: "",
      prompt: "",
      config,
      subagentSessionId: "c",
    });
    expect(ctxB.skills).toEqual([]);
  });

  it("wires session ids and agent name through unchanged", () => {
    const agent = makeAgent({ name: "my-agent", tools: ["Read"] });
    const parent = makeParent({ sessionId: "parent-xyz" });

    const ctx = buildSubagentContext({
      agent,
      parent,
      description: "d",
      prompt: "p",
      config,
      subagentSessionId: "child-abc",
    });
    expect(ctx.parentSessionId).toBe("parent-xyz");
    expect(ctx.subagentSessionId).toBe("child-abc");
    expect(ctx.agentName).toBe("my-agent");
  });
});
