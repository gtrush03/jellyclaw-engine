import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AgentEvent } from "../events.js";
import { SessionPaths } from "./paths.js";
import { resumeSession } from "./resume.js";
import { DEFAULT_DROPPED_TOOL_RESULT, SessionNotFoundError } from "./types.js";

const SESSION_ID = "sess-resume-1";
const PROJECT_HASH = "abcdef012345";

function writeJsonl(path: string, events: readonly AgentEvent[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const body = `${events.map((e) => JSON.stringify(e)).join("\n")}\n`;
  writeFileSync(path, body, "utf8");
}

describe("resumeSession", () => {
  let home: string;
  let paths: SessionPaths;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "jellyclaw-resume-"));
    paths = new SessionPaths({ home });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("reads JSONL, reduces, returns EngineState", async () => {
    const path = paths.sessionLog(PROJECT_HASH, SESSION_ID);
    const events: AgentEvent[] = [
      {
        type: "session.started",
        session_id: SESSION_ID,
        seq: 0,
        ts: 1,
        wish: "hi",
        agent: "default",
        model: "claude",
        provider: "anthropic",
        cwd: "/tmp/p",
      },
      { type: "agent.message", session_id: SESSION_ID, seq: 1, ts: 2, delta: "hello", final: true },
      {
        type: "usage.updated",
        session_id: SESSION_ID,
        seq: 2,
        ts: 3,
        input_tokens: 10,
        output_tokens: 5,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
      },
      {
        type: "session.completed",
        session_id: SESSION_ID,
        seq: 3,
        ts: 4,
        turns: 1,
        duration_ms: 50,
      },
    ];
    writeJsonl(path, events);

    const state = await resumeSession({ sessionId: SESSION_ID, paths, projectHash: PROJECT_HASH });
    expect(state.sessionId).toBe(SESSION_ID);
    expect(state.ended).toBe(true);
    expect(state.messages).toHaveLength(2);
    expect(state.usage.inputTokens).toBe(10);
  });

  it("missing session file → SessionNotFoundError", async () => {
    await expect(
      resumeSession({ sessionId: "nope", paths, projectHash: PROJECT_HASH }),
    ).rejects.toBeInstanceOf(SessionNotFoundError);
  });

  it("applies maxContextTokens trimming: oldest tool_result dropped, newest untouched", async () => {
    const path = paths.sessionLog(PROJECT_HASH, SESSION_ID);
    const bigResult = "X".repeat(4000); // ~1000 tokens
    const events: AgentEvent[] = [
      {
        type: "session.started",
        session_id: SESSION_ID,
        seq: 0,
        ts: 1,
        wish: "w",
        agent: "default",
        model: "m",
        provider: "anthropic",
        cwd: "/tmp/p",
      },
      {
        type: "tool.called",
        session_id: SESSION_ID,
        seq: 1,
        ts: 2,
        tool_id: "t1",
        tool_name: "Read",
        input: { path: "/a" },
      },
      {
        type: "tool.result",
        session_id: SESSION_ID,
        seq: 2,
        ts: 3,
        tool_id: "t1",
        tool_name: "Read",
        output: bigResult,
        duration_ms: 1,
      },
      {
        type: "tool.called",
        session_id: SESSION_ID,
        seq: 3,
        ts: 4,
        tool_id: "t2",
        tool_name: "Read",
        input: { path: "/b" },
      },
      {
        type: "tool.result",
        session_id: SESSION_ID,
        seq: 4,
        ts: 5,
        tool_id: "t2",
        tool_name: "Read",
        output: bigResult,
        duration_ms: 1,
      },
    ];
    writeJsonl(path, events);

    const state = await resumeSession({
      sessionId: SESSION_ID,
      paths,
      projectHash: PROJECT_HASH,
      resumeOptions: { maxContextTokens: 1100 },
    });

    expect(state.toolCalls).toHaveLength(2);
    // oldest (t1) dropped
    expect(state.toolCalls[0]?.result).toBe(DEFAULT_DROPPED_TOOL_RESULT);
    // newest (t2) untouched
    expect(state.toolCalls[1]?.result).toBe(bigResult);
  });

  it("trimming keeps active (unresolved) tool_call chain intact", async () => {
    const path = paths.sessionLog(PROJECT_HASH, SESSION_ID);
    const bigResult = "Y".repeat(8000);
    const events: AgentEvent[] = [
      {
        type: "session.started",
        session_id: SESSION_ID,
        seq: 0,
        ts: 1,
        wish: "w",
        agent: "default",
        model: "m",
        provider: "anthropic",
        cwd: "/tmp/p",
      },
      {
        type: "tool.called",
        session_id: SESSION_ID,
        seq: 1,
        ts: 2,
        tool_id: "t1",
        tool_name: "Read",
        input: { path: "/a" },
      },
      {
        type: "tool.result",
        session_id: SESSION_ID,
        seq: 2,
        ts: 3,
        tool_id: "t1",
        tool_name: "Read",
        output: bigResult,
        duration_ms: 1,
      },
      // unresolved — most recent by seq
      {
        type: "tool.called",
        session_id: SESSION_ID,
        seq: 3,
        ts: 4,
        tool_id: "t-live",
        tool_name: "Write",
        input: { path: "/live" },
      },
    ];
    writeJsonl(path, events);

    const state = await resumeSession({
      sessionId: SESSION_ID,
      paths,
      projectHash: PROJECT_HASH,
      resumeOptions: { maxContextTokens: 10 },
    });

    const live = state.toolCalls.find((tc) => tc.toolId === "t-live");
    expect(live).toBeDefined();
    expect(live?.result).toBeNull();
    expect(live?.error).toBeNull();
    // t1 was dropped
    const t1 = state.toolCalls.find((tc) => tc.toolId === "t1");
    expect(t1?.result).toBe(DEFAULT_DROPPED_TOOL_RESULT);
  });
});
