import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import {
  type BreakpointOptions,
  defaultBreakpointOptions,
  planBreakpoints,
} from "./cache-breakpoints.js";
import type { ProviderRequest } from "./types.js";

const baseReq = (overrides: Partial<ProviderRequest> = {}): ProviderRequest => ({
  model: "claude-opus-4-6",
  maxOutputTokens: 1024,
  system: [],
  messages: [],
  ...overrides,
});

const opts = (o: Partial<BreakpointOptions> = {}): BreakpointOptions => ({
  ...defaultBreakpointOptions,
  ...o,
});

describe("planBreakpoints", () => {
  it("no system, no tools, no memory → empty plan, no 1h flag", () => {
    const p = planBreakpoints(baseReq());
    expect(p.system).toEqual([]);
    expect(p.tools).toBeUndefined();
    expect(p.hasOneHourBreakpoint).toBe(false);
    expect(p.plan.systemPlaced).toBe(false);
    expect(p.plan.toolsPlaced).toBe(false);
    expect(p.plan.claudeMdPlaced).toBe(false);
    expect(p.plan.skillsPlaced).toBe(false);
  });

  it("single system block → cache_control on that block with configured TTL", () => {
    const p = planBreakpoints(
      baseReq({ system: [{ type: "text", text: "you are jellyclaw" }] }),
      opts({ systemTTL: "1h" }),
    );
    expect(p.system[0]?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(p.hasOneHourBreakpoint).toBe(true);
    expect(p.plan.systemPlaced).toBe(true);
  });

  it("multi-block system → breakpoint ONLY on the last block", () => {
    const p = planBreakpoints(
      baseReq({
        system: [
          { type: "text", text: "A" },
          { type: "text", text: "B" },
          { type: "text", text: "C" },
        ],
      }),
      opts({ systemTTL: "5m" }),
    );
    expect(p.system[0]?.cache_control).toBeUndefined();
    expect(p.system[1]?.cache_control).toBeUndefined();
    expect(p.system[2]?.cache_control).toEqual({ type: "ephemeral", ttl: "5m" });
    expect(p.hasOneHourBreakpoint).toBe(false);
  });

  it("empty string system block → no breakpoint placed", () => {
    const p = planBreakpoints(baseReq({ system: [{ type: "text", text: "" }] }));
    expect(p.system[0]?.cache_control).toBeUndefined();
    expect(p.plan.systemPlaced).toBe(false);
  });

  it("no tools → undefined tools, no tools breakpoint", () => {
    const p = planBreakpoints(baseReq({ tools: [] }));
    expect(p.tools).toBeUndefined();
    expect(p.plan.toolsPlaced).toBe(false);
  });

  it("single tool → breakpoint on that tool with 5m TTL", () => {
    const tool: Anthropic.Messages.Tool = {
      name: "t1",
      description: "x",
      input_schema: { type: "object" },
    };
    const p = planBreakpoints(baseReq({ tools: [tool] }));
    expect(p.tools?.length).toBe(1);
    expect((p.tools?.[0] as { cache_control?: unknown }).cache_control).toEqual({
      type: "ephemeral",
      ttl: "5m",
    });
    expect(p.plan.toolsPlaced).toBe(true);
  });

  it("many tools → breakpoint ONLY on the last tool", () => {
    const mk = (n: string): Anthropic.Messages.Tool => ({
      name: n,
      description: "",
      input_schema: { type: "object" },
    });
    const p = planBreakpoints(baseReq({ tools: [mk("a"), mk("b"), mk("c")] }));
    expect((p.tools?.[0] as { cache_control?: unknown }).cache_control).toBeUndefined();
    expect((p.tools?.[1] as { cache_control?: unknown }).cache_control).toBeUndefined();
    expect((p.tools?.[2] as { cache_control?: unknown }).cache_control).toEqual({
      type: "ephemeral",
      ttl: "5m",
    });
  });

  it("memory.claudeMd with no existing messages → prepends user turn with cache_control", () => {
    const p = planBreakpoints(baseReq({ memory: { claudeMd: "# project rules" } }));
    expect(p.messages.length).toBe(1);
    const first = p.messages[0];
    expect(first?.role).toBe("user");
    expect(Array.isArray(first?.content)).toBe(true);
    const blocks = first?.content as Anthropic.Messages.ContentBlockParam[];
    expect(blocks[0]?.type).toBe("text");
    expect((blocks[0] as { cache_control?: unknown }).cache_control).toEqual({
      type: "ephemeral",
      ttl: "5m",
    });
    expect(p.plan.claudeMdPlaced).toBe(true);
  });

  it("memory with skills > top-N → truncates and caches LAST memory block only", () => {
    const skills = Array.from({ length: 20 }, (_, i) => ({
      name: `s${i}`,
      body: `body-${i}`,
    }));
    const p = planBreakpoints(
      baseReq({
        memory: { claudeMd: "claude-md", skills },
        messages: [{ role: "user", content: "hi" }],
      }),
      opts({ skillsTopN: 5 }),
    );
    expect(p.plan.skillsIncluded).toBe(5);
    const first = p.messages[0];
    const blocks = first?.content as Anthropic.Messages.ContentBlockParam[];
    // Two memory blocks (claudeMd + skills) then the original user text.
    expect(blocks.length).toBe(3);
    // Only the LAST memory block (skills) has cache_control.
    expect((blocks[0] as { cache_control?: unknown }).cache_control).toBeUndefined();
    expect((blocks[1] as { cache_control?: unknown }).cache_control).toEqual({
      type: "ephemeral",
      ttl: "5m",
    });
    expect((blocks[2] as { cache_control?: unknown }).cache_control).toBeUndefined();
  });

  it("memory with claudeMd only (no skills) → cache_control on the single memory block", () => {
    const p = planBreakpoints(
      baseReq({
        memory: { claudeMd: "# rules" },
        messages: [{ role: "user", content: "go" }],
      }),
    );
    const blocks = p.messages[0]?.content as Anthropic.Messages.ContentBlockParam[];
    expect((blocks[0] as { cache_control?: unknown }).cache_control).toEqual({
      type: "ephemeral",
      ttl: "5m",
    });
    expect(p.plan.skillsPlaced).toBe(false);
  });

  it("disabled caching → no breakpoints anywhere", () => {
    const tool: Anthropic.Messages.Tool = {
      name: "t",
      description: "",
      input_schema: { type: "object" },
    };
    const p = planBreakpoints(
      baseReq({
        system: [{ type: "text", text: "A" }],
        tools: [tool],
        memory: { claudeMd: "x" },
        messages: [{ role: "user", content: "hi" }],
      }),
      opts({ enabled: false }),
    );
    expect(p.system[0]?.cache_control).toBeUndefined();
    expect((p.tools?.[0] as { cache_control?: unknown }).cache_control).toBeUndefined();
    const blocks = p.messages[0]?.content;
    // When caching disabled, memory is NOT injected (we only inject as a caching strategy).
    expect(blocks).toBe("hi");
    expect(p.hasOneHourBreakpoint).toBe(false);
  });

  it("skillsTopN=0 → skills block is skipped even when present", () => {
    const p = planBreakpoints(
      baseReq({
        memory: { claudeMd: "rules", skills: [{ name: "s", body: "b" }] },
      }),
      opts({ skillsTopN: 0 }),
    );
    expect(p.plan.skillsPlaced).toBe(false);
    expect(p.plan.claudeMdPlaced).toBe(true);
  });

  it("does not mutate input request or arrays", () => {
    const tool: Anthropic.Messages.Tool = {
      name: "t",
      description: "",
      input_schema: { type: "object" },
    };
    const req = baseReq({
      system: [{ type: "text", text: "A" }],
      tools: [tool],
    });
    const snapshot = JSON.parse(JSON.stringify(req));
    planBreakpoints(req);
    expect(JSON.parse(JSON.stringify(req))).toEqual(snapshot);
  });
});
