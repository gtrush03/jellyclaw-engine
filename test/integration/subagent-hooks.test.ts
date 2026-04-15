/**
 * Phase 06 Prompt 03 — Subagent hook-fire regression suite.
 *
 * Locks in the invariant from upstream OpenCode issue #5894: tool hooks
 * fired inside a subagent MUST carry the CHILD's session id, not the
 * parent's. The original plan patched `node_modules/opencode-ai` at the
 * source level; that approach is infeasible because opencode-ai ships as
 * a compiled Bun binary (see `patches/README.md`). The jellyclaw
 * in-process replacement for the patch lives at
 * `engine/src/plugin/agent-context.ts` and is exercised here end-to-end
 * via the Phase 06 Prompt 02 `SubagentDispatcher`.
 */

import { statSync } from "node:fs";
import { resolve } from "node:path";
import type { Event, ToolCallEndEvent, ToolCallStartEvent } from "@jellyclaw/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { SubagentDispatcher } from "../../engine/src/agents/dispatch.js";
import type {
  ParentContext,
  SessionRunArgs,
  SessionRunner,
  SessionRunResult,
} from "../../engine/src/agents/dispatch-types.js";
import { DEFAULT_DISPATCH_CONFIG } from "../../engine/src/agents/dispatch-types.js";
import { AgentRegistry } from "../../engine/src/agents/index.js";
import { createSubagentSemaphore } from "../../engine/src/agents/semaphore.js";
import { HookRecorder } from "../../engine/src/hooks/test-harness.js";
import {
  enrichHookEnvelope,
  type SessionMetadata,
  type SessionResolver,
} from "../../engine/src/plugin/agent-context.js";

const REGRESSION_MSG =
  "The jellyclaw in-process replacement for the (non-existent) 001-subagent-hook-fire " +
  "patch has regressed. See patches/README.md for context; original design-intent is in " +
  "patches/001-subagent-hook-fire.design.md.";

const INVARIANT_MSG =
  "REGRESSION: hooks fired with parent session id instead of subagent id. This is " +
  "upstream OpenCode issue #5894 resurfacing — check engine/src/plugin/agent-context.ts " +
  "and engine/src/agents/dispatch.ts.";

const FIXTURES_DIR = resolve(__dirname, "fixtures", "agents");
const PARENT_SESSION_ID = "parent-XYZ";

function buildParent(overrides: Partial<ParentContext> = {}): ParentContext {
  return {
    sessionId: PARENT_SESSION_ID,
    allowedTools: ["Bash"],
    model: "claude-sonnet-4-5",
    depth: 0,
    ...overrides,
  };
}

/** Mock runner whose events carry the CHILD's subagent session id. */
function makeProbeRunner(): SessionRunner {
  return {
    // biome-ignore lint/suspicious/useAwait: SessionRunner contract is async; this stub emits synchronously.
    async run(args: SessionRunArgs): Promise<SessionRunResult> {
      const childSession = args.context.subagentSessionId;
      const baseTs = args.clock();

      const startEvt: ToolCallStartEvent = {
        type: "tool.call.start",
        session_id: childSession,
        tool_use_id: "t1",
        name: "Bash",
        input: { command: "echo probe" },
        subagent_path: [childSession],
        ts: baseTs + 1,
      };
      args.onEvent(startEvt);

      const endEvt: ToolCallEndEvent = {
        type: "tool.call.end",
        session_id: childSession,
        tool_use_id: "t1",
        result: { stdout: "probe\n", exit_code: 0 },
        duration_ms: 3,
        ts: baseTs + 2,
      };
      args.onEvent(endEvt);

      return {
        summary: "ran probe",
        usage: { input_tokens: 5, output_tokens: 2 },
        turns: 1,
        reason: "complete",
      };
    },
  };
}

interface Harness {
  readonly dispatcher: SubagentDispatcher;
  readonly recorder: HookRecorder;
  readonly allEvents: Event[];
}

async function makeHarness(): Promise<Harness> {
  const registry = new AgentRegistry();
  await registry.loadAll({
    roots: [{ path: FIXTURES_DIR, source: "project" }],
  });

  const recorder = new HookRecorder({ parentSessionId: PARENT_SESSION_ID });
  const allEvents: Event[] = [];

  let tsCounter = 1_000;
  const clock = (): number => {
    tsCounter += 1;
    return tsCounter;
  };

  let idCounter = 0;
  const idGen = (): string => {
    idCounter += 1;
    return `child-${idCounter}`;
  };

  const dispatcher = new SubagentDispatcher({
    registry,
    runner: makeProbeRunner(),
    semaphore: createSubagentSemaphore({ maxConcurrency: 1 }),
    config: DEFAULT_DISPATCH_CONFIG,
    parent: buildParent(),
    clock,
    idGen,
    emit: (event) => {
      allEvents.push(event);
      recorder.onEvent(event);
    },
  });

  return { dispatcher, recorder, allEvents };
}

// ---------------------------------------------------------------------------
// Static surface — replaces the "static sentinel" part of the original patch
// regression check. Asserts the jellyclaw replacement module still exists
// and still exports the functions the rest of the engine relies on.
// ---------------------------------------------------------------------------

describe("Phase 06 Prompt 03 — static surface", () => {
  it("jellyclaw replacement plugin engine/src/plugin/agent-context.ts exists on disk", () => {
    const path = resolve(__dirname, "..", "..", "engine", "src", "plugin", "agent-context.ts");
    let isFile = false;
    try {
      isFile = statSync(path).isFile();
    } catch {
      isFile = false;
    }
    expect(isFile, REGRESSION_MSG).toBe(true);
  });

  it("agent-context.ts exports enrichHookEnvelope + createCachedResolver + MAX_AGENT_CHAIN_DEPTH", async () => {
    const mod = await import("../../engine/src/plugin/agent-context.js");
    expect(mod.enrichHookEnvelope, REGRESSION_MSG).toBeDefined();
    expect(typeof mod.enrichHookEnvelope, REGRESSION_MSG).toBe("function");
    expect(mod.createCachedResolver, REGRESSION_MSG).toBeDefined();
    expect(typeof mod.createCachedResolver, REGRESSION_MSG).toBe("function");
    expect(mod.MAX_AGENT_CHAIN_DEPTH, REGRESSION_MSG).toBeDefined();
    expect(typeof mod.MAX_AGENT_CHAIN_DEPTH, REGRESSION_MSG).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// Dynamic regression — the actual #5894 invariant.
// ---------------------------------------------------------------------------

describe("Phase 06 Prompt 03 — subagent hook fire (#5894)", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await makeHarness();
    await harness.dispatcher.dispatch({
      subagent_type: "hook-probe",
      description: "probe",
      prompt: "run echo probe",
    });
  });

  it("recorder received at least one PreToolUse", () => {
    expect(harness.recorder.preToolUses().length).toBeGreaterThanOrEqual(1);
  });

  it("PreToolUse session_id !== parent (THE #5894 INVARIANT)", () => {
    const pre = harness.recorder.preToolUses()[0];
    expect(pre, "expected at least one PreToolUse record").toBeDefined();
    if (!pre) return;
    expect(pre.sessionId, INVARIANT_MSG).not.toBe(PARENT_SESSION_ID);
  });

  it("PostToolUse fired for Bash with matching toolUseId", () => {
    const pre = harness.recorder.preToolUses()[0];
    const post = harness.recorder.postToolUses()[0];
    expect(pre).toBeDefined();
    expect(post).toBeDefined();
    if (!pre || !post) return;
    expect(post.toolName).toBe("Bash");
    expect(post.toolUseId).toBe(pre.toolUseId);
    expect(post.sessionId).toBe(pre.sessionId);
    expect(post.sessionId).not.toBe(PARENT_SESSION_ID);
  });

  it("parentSessionId on records matches engine top-level session id", () => {
    const pre = harness.recorder.preToolUses()[0];
    expect(pre).toBeDefined();
    if (!pre) return;
    expect(pre.parentSessionId).toBe(PARENT_SESSION_ID);
  });

  it("PreToolUse precedes PostToolUse for the same tool_use_id", () => {
    const records = harness.recorder.records;
    const preIdx = records.findIndex((r) => r.event === "PreToolUse" && r.toolUseId === "t1");
    const postIdx = records.findIndex((r) => r.event === "PostToolUse" && r.toolUseId === "t1");
    expect(preIdx).toBeGreaterThanOrEqual(0);
    expect(postIdx).toBeGreaterThan(preIdx);
    const pre = records[preIdx];
    const post = records[postIdx];
    expect(pre).toBeDefined();
    expect(post).toBeDefined();
    if (!pre || !post) return;
    expect(post.ts).toBeGreaterThanOrEqual(pre.ts);
  });

  it("tool input contains 'echo probe'", () => {
    const pre = harness.recorder.preToolUses()[0];
    expect(pre).toBeDefined();
    if (!pre) return;
    expect(JSON.stringify(pre.input)).toContain("echo probe");
  });

  it("subagent.start precedes tool events; subagent.end follows", () => {
    const types = harness.allEvents.map((e) => e.type);
    const sStart = types.indexOf("subagent.start");
    const tStart = types.indexOf("tool.call.start");
    const tEnd = types.indexOf("tool.call.end");
    const sEnd = types.indexOf("subagent.end");
    expect(sStart, "subagent.start not emitted").toBeGreaterThanOrEqual(0);
    expect(tStart, "tool.call.start not emitted").toBeGreaterThan(sStart);
    expect(tEnd, "tool.call.end not emitted").toBeGreaterThan(tStart);
    expect(sEnd, "subagent.end not emitted").toBeGreaterThan(tEnd);
  });

  it("subagent_path on tool events includes only the subagent session id", () => {
    const pre = harness.recorder.preToolUses()[0];
    expect(pre).toBeDefined();
    if (!pre) return;
    expect(pre.subagentPath.length).toBe(1);
    expect(pre.subagentPath[0]).toBe(pre.sessionId);
    expect(pre.subagentPath).not.toContain(PARENT_SESSION_ID);
  });

  // Negative control — manual-only. See comment.
  it.skip("NEGATIVE CONTROL: if mock emits parent session id, test MUST fail", () => {
    // TODO(manual-only): to prove this test suite is sharp, temporarily
    // edit the mock SessionRunner above to emit tool.call.start with
    // `session_id: parentCtx.sessionId` instead of childSession. Unskip
    // this test and re-run. It MUST fail with the #5894 regression
    // message. Restore the mock + re-skip before committing.
    const pre = harness.recorder.preToolUses()[0];
    expect(pre).toBeDefined();
    if (!pre) return;
    expect(pre.sessionId, INVARIANT_MSG).not.toBe(PARENT_SESSION_ID);
  });
});

// ---------------------------------------------------------------------------
// Integration sanity — wire the recorded events through the live
// `enrichHookEnvelope` from agent-context.ts. If someone rewrites that
// module in a way that breaks subagent enrichment, this test catches it.
// ---------------------------------------------------------------------------

describe("Phase 06 Prompt 03 — agent-context enrichment integration", () => {
  it("enrichHookEnvelope tags the child's Bash call with agent='hook-probe' and agentChain=[parent]", async () => {
    const harness = await makeHarness();
    await harness.dispatcher.dispatch({
      subagent_type: "hook-probe",
      description: "probe",
      prompt: "run echo probe",
    });

    const pre = harness.recorder.preToolUses()[0];
    expect(pre, "expected a recorded Bash PreToolUse").toBeDefined();
    if (!pre) return;

    const childSession = pre.sessionId;
    const resolver: SessionResolver = {
      getSession(sessionID: string): Promise<SessionMetadata | undefined> {
        if (sessionID === childSession) {
          return Promise.resolve({
            agentName: "hook-probe",
            parentSessionID: PARENT_SESSION_ID,
          });
        }
        if (sessionID === PARENT_SESSION_ID) {
          return Promise.resolve({ agentName: undefined, parentSessionID: undefined });
        }
        return Promise.resolve(undefined);
      },
    };

    const enriched = await enrichHookEnvelope(
      {
        tool: pre.toolName,
        sessionID: childSession,
        callID: pre.toolUseId,
      },
      resolver,
    );

    expect(enriched.agent, REGRESSION_MSG).toBe("hook-probe");
    expect(enriched.parentSessionID).toBe(PARENT_SESSION_ID);
    expect(enriched.agentChain).toEqual([PARENT_SESSION_ID]);
  });
});
