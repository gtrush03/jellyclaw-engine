import { describe, expect, it, vi } from "vitest";
import {
  createCachedResolver,
  enrichHookEnvelope,
  MAX_AGENT_CHAIN_DEPTH,
  type SessionMetadata,
  type SessionResolver,
  type ToolHookEnvelope,
} from "./agent-context";

function makeResolver(table: Record<string, SessionMetadata | undefined>): SessionResolver {
  return {
    // biome-ignore lint/suspicious/useAwait: implements Promise-returning SessionResolver interface
    async getSession(sessionID: string): Promise<SessionMetadata | undefined> {
      return table[sessionID];
    },
  };
}

const baseEnvelope = (sessionID: string): ToolHookEnvelope => ({
  tool: "bash",
  sessionID,
  callID: "call-1",
});

describe("enrichHookEnvelope", () => {
  it("root session: agent set, parent undefined, empty chain", async () => {
    const resolver = makeResolver({
      root: { agentName: "general", parentSessionID: undefined },
    });
    const out = await enrichHookEnvelope(baseEnvelope("root"), resolver);
    expect(out.agent).toBe("general");
    expect(out.parentSessionID).toBeUndefined();
    expect(out.agentChain).toEqual([]);
  });

  it("one-level subagent: chain contains root parent", async () => {
    const resolver = makeResolver({
      A: { agentName: "general", parentSessionID: undefined },
      B: { agentName: "reviewer", parentSessionID: "A" },
    });
    const out = await enrichHookEnvelope(baseEnvelope("B"), resolver);
    expect(out.agent).toBe("reviewer");
    expect(out.parentSessionID).toBe("A");
    expect(out.agentChain).toEqual(["A"]);
  });

  it("two-level subagent: chain is root-first [A, B]", async () => {
    const resolver = makeResolver({
      A: { agentName: "general", parentSessionID: undefined },
      B: { agentName: "reviewer", parentSessionID: "A" },
      C: { agentName: "fixer", parentSessionID: "B" },
    });
    const out = await enrichHookEnvelope(baseEnvelope("C"), resolver);
    expect(out.agent).toBe("fixer");
    expect(out.parentSessionID).toBe("B");
    expect(out.agentChain).toEqual(["A", "B"]);
  });

  it("unknown session: all enrichment fields are undefined/empty", async () => {
    const resolver = makeResolver({});
    const out = await enrichHookEnvelope(baseEnvelope("ghost"), resolver);
    expect(out.agent).toBeUndefined();
    expect(out.parentSessionID).toBeUndefined();
    expect(out.agentChain).toEqual([]);
  });

  it("preserves original envelope fields (spread, no overwrite)", async () => {
    const resolver = makeResolver({
      s: { agentName: "general", parentSessionID: undefined },
    });
    const envelope: ToolHookEnvelope = {
      tool: "bash",
      sessionID: "s",
      callID: "1",
      args: { cmd: "ls" },
    };
    const out = await enrichHookEnvelope(envelope, resolver);
    expect(out.tool).toBe("bash");
    expect(out.sessionID).toBe("s");
    expect(out.callID).toBe("1");
    expect(out.args).toEqual({ cmd: "ls" });
    expect(out.agent).toBe("general");
  });

  it("cycle protection: X -> X throws after cap", async () => {
    const resolver: SessionResolver = {
      // biome-ignore lint/suspicious/useAwait: implements Promise-returning SessionResolver interface
      async getSession(id: string): Promise<SessionMetadata | undefined> {
        if (id === "X") return { agentName: "loop", parentSessionID: "X" };
        return undefined;
      },
    };
    await expect(enrichHookEnvelope(baseEnvelope("X"), resolver)).rejects.toThrow(
      new RegExp(`exceeded ${MAX_AGENT_CHAIN_DEPTH} hops`),
    );
  });

  it("infinite chain protection: X <-> Y alternation throws", async () => {
    const resolver: SessionResolver = {
      // biome-ignore lint/suspicious/useAwait: implements Promise-returning SessionResolver interface
      async getSession(id: string): Promise<SessionMetadata | undefined> {
        if (id === "X") return { agentName: "x", parentSessionID: "Y" };
        if (id === "Y") return { agentName: "y", parentSessionID: "X" };
        return undefined;
      },
    };
    await expect(enrichHookEnvelope(baseEnvelope("X"), resolver)).rejects.toThrow(/exceeded/);
  });
});

describe("createCachedResolver", () => {
  it("calls underlying resolver at most once per unique sessionID", async () => {
    const table: Record<string, SessionMetadata | undefined> = {
      A: { agentName: "general", parentSessionID: undefined },
      B: { agentName: "reviewer", parentSessionID: "A" },
      C: { agentName: "fixer", parentSessionID: "B" },
    };
    const spy = vi.fn(async (id: string) => table[id]);
    const base: SessionResolver = { getSession: spy };
    const cached = createCachedResolver(base);

    // Enrich C (hits C, B, A). Then enrich B (should be fully cached).
    await enrichHookEnvelope(baseEnvelope("C"), cached);
    await enrichHookEnvelope(baseEnvelope("B"), cached);
    await enrichHookEnvelope(baseEnvelope("A"), cached);

    const calledIds = spy.mock.calls.map((c) => c[0]);
    // Each unique id should appear exactly once.
    expect(calledIds.sort()).toEqual(["A", "B", "C"]);
    expect(spy.mock.calls.length).toBe(3);
  });

  it("caches undefined (miss) results too", async () => {
    const spy = vi.fn(async (_id: string) => undefined);
    const base: SessionResolver = { getSession: spy };
    const cached = createCachedResolver(base);

    await cached.getSession("ghost");
    await cached.getSession("ghost");
    await cached.getSession("ghost");

    expect(spy.mock.calls.length).toBe(1);
  });
});
