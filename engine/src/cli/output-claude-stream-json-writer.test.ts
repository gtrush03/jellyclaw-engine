/**
 * Phase 99.04 — writer-level unit tests for `ClaudeStreamJsonWriter`.
 *
 * Agent B owns dispatcher-integration + live smoke in
 * `output-claude-stream-json.test.ts`. This file only exercises the writer
 * in isolation against an in-memory stream.
 */

import { describe, expect, it } from "vitest";

import type { AgentEvent } from "../events.js";
import { ClaudeStreamJsonWriter } from "./output-claude-stream-json.js";

// ---------------------------------------------------------------------------
// In-memory writable stream (captures exact chunks)
// ---------------------------------------------------------------------------

class MemStream {
  chunks: string[] = [];

  write(chunk: string, cb?: (err?: Error | null) => void): boolean {
    this.chunks.push(chunk);
    if (cb) cb();
    return true;
  }

  once(_event: "drain", _listener: () => void): this {
    return this;
  }
}

function asStream(s: MemStream): NodeJS.WritableStream {
  return s as unknown as NodeJS.WritableStream;
}

const SESSION_ID = "sess-abcdef12-3456-7890-abcd-ef1234567890";

function baseEnv(seq: number): { session_id: string; ts: number; seq: number } {
  return { session_id: SESSION_ID, ts: 1_700_000_000_000 + seq, seq };
}

function sessionStarted(): AgentEvent {
  return {
    type: "session.started",
    ...baseEnv(0),
    wish: "say pong",
    agent: "default",
    model: "claude-sonnet-4",
    provider: "anthropic",
    cwd: "/tmp",
  };
}

function sessionCompleted(seq: number, turns = 1): AgentEvent {
  return {
    type: "session.completed",
    ...baseEnv(seq),
    turns,
    duration_ms: 1234,
  };
}

function makeWriter(stdout: MemStream): ClaudeStreamJsonWriter {
  return new ClaudeStreamJsonWriter(asStream(stdout), {
    cwd: "/tmp",
    tools: ["Bash", "Read"],
    permissionMode: "default",
  });
}

type SystemInit = {
  type: "system";
  subtype: "init";
  session_id: string;
  cwd: string;
  tools: string[];
  permissionMode: string;
};

type AssistantFrame = {
  type: "assistant";
  message: {
    id: string;
    role: "assistant";
    content: Array<
      | { type: "text"; text: string }
      | { type: "tool_use"; id: string; name: string; input: unknown }
    >;
    stop_reason: string | null;
  };
};

type UserFrame = {
  type: "user";
  message: {
    role: "user";
    content: Array<{
      type: "tool_result";
      tool_use_id: string;
      content: string;
      is_error: boolean;
    }>;
  };
};

type ResultFrame = {
  type: "result";
  subtype: "success" | "error";
  is_error: boolean;
  result: string;
  session_id: string | null;
  terminal_reason: string;
  error?: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  };
  num_turns?: number;
  total_cost_usd?: number;
};

type AnyFrame = SystemInit | AssistantFrame | UserFrame | ResultFrame;

function parseFrames(stdout: MemStream): AnyFrame[] {
  return stdout.chunks.map((c) => JSON.parse(c.replace(/\n$/, "")) as AnyFrame);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ClaudeStreamJsonWriter — happy text path", () => {
  it("buffers deltas, emits one assistant text frame on final, sums usage", async () => {
    const stdout = new MemStream();
    const w = makeWriter(stdout);

    const events: AgentEvent[] = [
      sessionStarted(),
      { type: "agent.message", ...baseEnv(1), delta: "p", final: false },
      { type: "agent.message", ...baseEnv(2), delta: "ong", final: false },
      { type: "agent.message", ...baseEnv(3), delta: "", final: true },
      {
        type: "usage.updated",
        ...baseEnv(4),
        input_tokens: 10,
        output_tokens: 5,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        cost_usd: 0.0123,
      },
      sessionCompleted(5, 1),
    ];
    for (const ev of events) await w.write(ev);
    await w.finish();

    const frames = parseFrames(stdout);
    expect(frames).toHaveLength(3);
    expect(frames[0]?.type).toBe("system");
    expect(frames[1]?.type).toBe("assistant");
    const assistant = frames[1] as AssistantFrame;
    expect(assistant.message.content).toHaveLength(1);
    const first = assistant.message.content[0];
    expect(first).toBeDefined();
    if (!first || first.type !== "text") throw new Error("expected text block");
    expect(first.text).toBe("pong");
    expect(assistant.message.stop_reason).toBeNull();

    const result = frames[2] as ResultFrame;
    expect(result.type).toBe("result");
    expect(result.subtype).toBe("success");
    expect(result.result).toBe("pong");
    expect(result.usage?.output_tokens).toBe(5);
    expect(result.usage?.input_tokens).toBe(10);
    expect(result.total_cost_usd).toBe(0.0123);
  });
});

describe("ClaudeStreamJsonWriter — tool round-trip", () => {
  it("emits assistant tool_use, user tool_result, final assistant text, result", async () => {
    const stdout = new MemStream();
    const w = makeWriter(stdout);

    const toolId = "toolu_abc";
    const events: AgentEvent[] = [
      sessionStarted(),
      {
        type: "tool.called",
        ...baseEnv(1),
        tool_id: toolId,
        tool_name: "get_weather",
        input: { city: "Paris" },
      },
      {
        type: "tool.result",
        ...baseEnv(2),
        tool_id: toolId,
        tool_name: "get_weather",
        output: { temp: "18C" },
        duration_ms: 12,
      },
      { type: "agent.message", ...baseEnv(3), delta: "It's 18C.", final: false },
      { type: "agent.message", ...baseEnv(4), delta: "", final: true },
      sessionCompleted(5, 2),
    ];
    for (const ev of events) await w.write(ev);
    await w.finish();

    const frames = parseFrames(stdout);
    // init, assistant(tool_use), user(tool_result), assistant(text), result
    expect(frames).toHaveLength(5);
    expect(frames[0]?.type).toBe("system");

    const useFrame = frames[1] as AssistantFrame;
    expect(useFrame.type).toBe("assistant");
    const useBlock = useFrame.message.content[0];
    if (!useBlock || useBlock.type !== "tool_use") throw new Error("expected tool_use");
    expect(useBlock.id).toBe(toolId);
    expect(useBlock.name).toBe("get_weather");
    expect(useBlock.input).toEqual({ city: "Paris" });

    const resFrame = frames[2] as UserFrame;
    expect(resFrame.type).toBe("user");
    const toolResult = resFrame.message.content[0];
    expect(toolResult?.tool_use_id).toBe(toolId);
    expect(toolResult?.is_error).toBe(false);
    expect(toolResult?.content).toBe(JSON.stringify({ temp: "18C" }));

    const textFrame = frames[3] as AssistantFrame;
    const textBlock = textFrame.message.content[0];
    if (!textBlock || textBlock.type !== "text") throw new Error("expected text");
    expect(textBlock.text).toBe("It's 18C.");

    const result = frames[4] as ResultFrame;
    expect(result.subtype).toBe("success");
    expect(result.result).toBe("It's 18C.");

    // tool_use_id invariant
    const toolUseIds = new Set<string>();
    const toolResultIds = new Set<string>();
    for (const f of frames) {
      if (f.type === "assistant") {
        for (const block of f.message.content) {
          if (block.type === "tool_use") toolUseIds.add(block.id);
        }
      } else if (f.type === "user") {
        for (const block of f.message.content) toolResultIds.add(block.tool_use_id);
      }
    }
    for (const id of toolUseIds) expect(toolResultIds.has(id)).toBe(true);
  });
});

describe("ClaudeStreamJsonWriter — tool error", () => {
  it("emits a user frame with is_error:true and plain-string content", async () => {
    const stdout = new MemStream();
    const w = makeWriter(stdout);
    const toolId = "toolu_err";
    const events: AgentEvent[] = [
      sessionStarted(),
      {
        type: "tool.called",
        ...baseEnv(1),
        tool_id: toolId,
        tool_name: "bash",
        input: { cmd: "exit 1" },
      },
      {
        type: "tool.error",
        ...baseEnv(2),
        tool_id: toolId,
        tool_name: "bash",
        code: "ERR_TOOL",
        message: "boom",
      },
      { type: "agent.message", ...baseEnv(3), delta: "okay.", final: false },
      { type: "agent.message", ...baseEnv(4), delta: "", final: true },
      sessionCompleted(5, 2),
    ];
    for (const ev of events) await w.write(ev);
    await w.finish();

    const frames = parseFrames(stdout);
    const userFrame = frames.find((f) => f.type === "user") as UserFrame | undefined;
    expect(userFrame).toBeDefined();
    const block = userFrame?.message.content[0];
    expect(block?.is_error).toBe(true);
    expect(block?.content).toBe("boom");
  });
});

describe("ClaudeStreamJsonWriter — text + tool interleave", () => {
  it("flushes buffered text into the same assistant frame as tool_use", async () => {
    const stdout = new MemStream();
    const w = makeWriter(stdout);
    const events: AgentEvent[] = [
      sessionStarted(),
      { type: "agent.message", ...baseEnv(1), delta: "thinking...", final: false },
      {
        type: "tool.called",
        ...baseEnv(2),
        tool_id: "toolu_1",
        tool_name: "bash",
        input: { cmd: "ls" },
      },
      {
        type: "tool.result",
        ...baseEnv(3),
        tool_id: "toolu_1",
        tool_name: "bash",
        output: "a\nb",
        duration_ms: 5,
      },
      { type: "agent.message", ...baseEnv(4), delta: "", final: true },
      sessionCompleted(5, 1),
    ];
    for (const ev of events) await w.write(ev);
    await w.finish();

    const frames = parseFrames(stdout);
    const assistant = frames[1] as AssistantFrame;
    expect(assistant.type).toBe("assistant");
    expect(assistant.message.content).toHaveLength(2);
    const textBlock = assistant.message.content[0];
    const useBlock = assistant.message.content[1];
    if (!textBlock || textBlock.type !== "text") throw new Error("expected text");
    if (!useBlock || useBlock.type !== "tool_use") throw new Error("expected tool_use");
    expect(textBlock.text).toBe("thinking...");
    expect(useBlock.id).toBe("toolu_1");
  });
});

describe("ClaudeStreamJsonWriter — NDJSON discipline", () => {
  it("each write is exactly one line ending in \\n, parseable as JSON", async () => {
    const stdout = new MemStream();
    const w = makeWriter(stdout);
    const events: AgentEvent[] = [
      sessionStarted(),
      { type: "agent.message", ...baseEnv(1), delta: "hi", final: false },
      { type: "agent.message", ...baseEnv(2), delta: "", final: true },
      sessionCompleted(3, 1),
    ];
    for (const ev of events) await w.write(ev);
    await w.finish();

    for (const chunk of stdout.chunks) {
      expect(chunk.endsWith("\n")).toBe(true);
      const newlineCount = (chunk.match(/\n/g) ?? []).length;
      expect(newlineCount).toBe(1);
      expect(() => JSON.parse(chunk.slice(0, -1))).not.toThrow();
    }
  });

  it("first frame is system.init, last frame is result", async () => {
    const stdout = new MemStream();
    const w = makeWriter(stdout);
    await w.write(sessionStarted());
    await w.write({ type: "agent.message", ...baseEnv(1), delta: "ok", final: true });
    await w.write(sessionCompleted(2, 1));
    await w.finish();

    const frames = parseFrames(stdout);
    expect(frames[0]?.type).toBe("system");
    expect((frames[0] as SystemInit).subtype).toBe("init");
    const last = frames[frames.length - 1];
    expect(last?.type).toBe("result");
  });
});

describe("ClaudeStreamJsonWriter — edge cases", () => {
  it("session.completed before session.started yields an error result, no throw", async () => {
    const stdout = new MemStream();
    const w = makeWriter(stdout);
    await expect(w.write(sessionCompleted(0, 0))).resolves.toBeUndefined();
    await w.finish();
    const frames = parseFrames(stdout);
    expect(frames).toHaveLength(1);
    const r = frames[0] as ResultFrame;
    expect(r.type).toBe("result");
    expect(r.subtype).toBe("error");
    expect(r.is_error).toBe(true);
    expect(r.error).toBe("missing session.started");
    expect(r.session_id).toBeNull();
  });

  it("session.error emits a terminal error result frame", async () => {
    const stdout = new MemStream();
    const w = makeWriter(stdout);
    await w.write(sessionStarted());
    await w.write({
      type: "session.error",
      ...baseEnv(1),
      code: "ERR_X",
      message: "kaboom",
      recoverable: false,
    });
    await w.finish();
    const frames = parseFrames(stdout);
    const last = frames[frames.length - 1] as ResultFrame;
    expect(last.subtype).toBe("error");
    expect(last.is_error).toBe(true);
    expect(last.error).toBe("kaboom");
  });

  it("finish() without a terminal emits synthetic error result", async () => {
    const stdout = new MemStream();
    const w = makeWriter(stdout);
    await w.write(sessionStarted());
    await w.finish();
    const frames = parseFrames(stdout);
    const last = frames[frames.length - 1] as ResultFrame;
    expect(last.type).toBe("result");
    expect(last.subtype).toBe("error");
    expect(last.error).toBe("stream ended without session.completed");
  });

  it("UTF-8 multi-byte in tool.result output round-trips", async () => {
    const stdout = new MemStream();
    const w = makeWriter(stdout);
    const toolId = "toolu_utf";
    const events: AgentEvent[] = [
      sessionStarted(),
      {
        type: "tool.called",
        ...baseEnv(1),
        tool_id: toolId,
        tool_name: "echo",
        input: {},
      },
      {
        type: "tool.result",
        ...baseEnv(2),
        tool_id: toolId,
        tool_name: "echo",
        output: { msg: "日本語🔥" },
        duration_ms: 1,
      },
      { type: "agent.message", ...baseEnv(3), delta: "", final: true },
      sessionCompleted(4, 1),
    ];
    for (const ev of events) await w.write(ev);
    await w.finish();

    const frames = parseFrames(stdout);
    const userFrame = frames.find((f) => f.type === "user") as UserFrame;
    const block = userFrame.message.content[0];
    expect(block?.content).toBe(JSON.stringify({ msg: "日本語🔥" }));
    const parsed = JSON.parse(block?.content ?? "") as { msg: string };
    expect(parsed.msg).toBe("日本語🔥");
  });
});
