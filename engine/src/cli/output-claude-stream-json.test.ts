/**
 * Phase 99 — Prompt 04: dispatcher-integration + fixture-diff + live-smoke tests
 * for the `claude-stream-json` output format.
 *
 * Complementary to the writer-level unit test authored by Agent A
 * (`output-claude-stream-json-writer.test.ts`). This file asserts that writer
 * output is drop-in compatible with the real Jelly-Claw dispatcher's
 * `makeHandleEvent` sinks AND roughly matches real `claude -p 2.1.109`
 * NDJSON fixtures captured on 2026-04-15.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { AgentEvent } from "../events.js";
// NOTE: Agent A lands `output-claude-stream-json.ts` in parallel. If it is not
// yet on disk at test time the import below throws — Suite 1/2/3 will fail
// loudly and the main session will reconcile.
import { ClaudeStreamJsonWriter } from "./output-claude-stream-json.js";

// ---------------------------------------------------------------------------
// In-memory writable (mirrors cli-output.test.ts)
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

  text(): string {
    return this.chunks.join("");
  }

  lines(): string[] {
    const text = this.text();
    if (text.length === 0) return [];
    const parts = text.split("\n");
    if (parts[parts.length - 1] === "") parts.pop();
    return parts;
  }
}

function asStream(s: MemStream): NodeJS.WritableStream {
  return s as unknown as NodeJS.WritableStream;
}

// ---------------------------------------------------------------------------
// Env + paths
// ---------------------------------------------------------------------------

const DISPATCHER_PATH = "/Users/gtrush/Downloads/Jelly-Claw/genie-server/src/core/dispatcher.mjs";
const dispatcherAvailable = existsSync(DISPATCHER_PATH);

const HERE = fileURLToPath(new URL(".", import.meta.url));
const FIXTURE_DIR = resolvePath(HERE, "../../test/fixtures/claude-compat");

const SESSION_A = "sess-A-text";
const SESSION_B = "sess-B-tool";
const SESSION_C = "sess-C-tool-error";

// ---------------------------------------------------------------------------
// Synthetic AgentEvent builders — match events.ts field names EXACTLY.
// ---------------------------------------------------------------------------

function envelope(session_id: string, seq: number, ts: number = 1_700_000_000_000 + seq) {
  return { session_id, ts, seq };
}

function buildATextEvents(): AgentEvent[] {
  return [
    {
      type: "session.started",
      ...envelope(SESSION_A, 0),
      wish: "say pong",
      agent: "default",
      model: "claude-haiku-4-5-20251001",
      provider: "anthropic",
      cwd: "/tmp",
    },
    { type: "agent.message", ...envelope(SESSION_A, 1), delta: "p", final: false },
    { type: "agent.message", ...envelope(SESSION_A, 2), delta: "ong", final: false },
    { type: "agent.message", ...envelope(SESSION_A, 3), delta: "", final: true },
    {
      type: "usage.updated",
      ...envelope(SESSION_A, 4),
      input_tokens: 3,
      output_tokens: 1,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    },
    {
      type: "session.completed",
      ...envelope(SESSION_A, 5),
      turns: 1,
      duration_ms: 600,
    },
  ];
}

function buildBToolEvents(): AgentEvent[] {
  const tid = "toolu_B_1";
  return [
    {
      type: "session.started",
      ...envelope(SESSION_B, 0),
      wish: "list /tmp",
      agent: "default",
      model: "claude-haiku-4-5-20251001",
      provider: "anthropic",
      cwd: "/tmp",
    },
    {
      type: "tool.called",
      ...envelope(SESSION_B, 1),
      tool_id: tid,
      tool_name: "Bash",
      input: { command: "ls /tmp" },
    },
    {
      type: "tool.result",
      ...envelope(SESSION_B, 2),
      tool_id: tid,
      tool_name: "Bash",
      output: "a\nb\nc",
      duration_ms: 42,
    },
    {
      type: "agent.message",
      ...envelope(SESSION_B, 3),
      delta: "Here are the files.",
      final: false,
    },
    { type: "agent.message", ...envelope(SESSION_B, 4), delta: "", final: true },
    {
      type: "usage.updated",
      ...envelope(SESSION_B, 5),
      input_tokens: 4,
      output_tokens: 12,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    },
    {
      type: "session.completed",
      ...envelope(SESSION_B, 6),
      turns: 2,
      duration_ms: 1200,
    },
  ];
}

function buildCToolErrorEvents(): AgentEvent[] {
  const tid = "toolu_C_1";
  return [
    {
      type: "session.started",
      ...envelope(SESSION_C, 0),
      wish: "run bad command",
      agent: "default",
      model: "claude-haiku-4-5-20251001",
      provider: "anthropic",
      cwd: "/tmp",
    },
    {
      type: "tool.called",
      ...envelope(SESSION_C, 1),
      tool_id: tid,
      tool_name: "Bash",
      input: { command: "thiscommanddoesnotexist" },
    },
    {
      type: "tool.error",
      ...envelope(SESSION_C, 2),
      tool_id: tid,
      tool_name: "Bash",
      code: "exit_127",
      message: "command not found",
    },
    {
      type: "agent.message",
      ...envelope(SESSION_C, 3),
      delta: "It failed.",
      final: false,
    },
    { type: "agent.message", ...envelope(SESSION_C, 4), delta: "", final: true },
    {
      type: "usage.updated",
      ...envelope(SESSION_C, 5),
      input_tokens: 4,
      output_tokens: 5,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    },
    {
      type: "session.completed",
      ...envelope(SESSION_C, 6),
      turns: 2,
      duration_ms: 900,
    },
  ];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run an AgentEvent array through a fresh ClaudeStreamJsonWriter and return
 * the captured NDJSON lines (newline-terminated output, split).
 *
 * The writer is assumed to accept (stdout, stderr) like the other writers.
 * If Agent A lands a different signature the main session reconciles.
 */
const DEFAULT_WRITER_OPTS = {
  cwd: "/tmp",
  tools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep"] as const,
  permissionMode: "default",
} as const;

async function runWriter(events: AgentEvent[]): Promise<{
  lines: string[];
  parsed: Array<Record<string, unknown>>;
}> {
  const stdout = new MemStream();
  const writer = new ClaudeStreamJsonWriter(asStream(stdout), {
    cwd: DEFAULT_WRITER_OPTS.cwd,
    tools: DEFAULT_WRITER_OPTS.tools,
    permissionMode: DEFAULT_WRITER_OPTS.permissionMode,
  });
  for (const ev of events) await writer.write(ev);
  await writer.finish();
  const lines = stdout.lines();
  const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  return { lines, parsed };
}

/**
 * Dynamic import of makeHandleEvent — done inside each test so the test file
 * still *loads* even when Jelly-Claw isn't cloned alongside.
 */
async function loadHandleEventFactory(): Promise<
  (sinks: Record<string, unknown>) => (evt: unknown) => Promise<void>
> {
  const mod = (await import(/* @vite-ignore */ DISPATCHER_PATH)) as {
    makeHandleEvent: (sinks: Record<string, unknown>) => (evt: unknown) => Promise<void>;
  };
  return mod.makeHandleEvent;
}

interface DispatcherCapture {
  sessionIds: Array<string | null>;
  toolIncrements: number;
  assistantTexts: string[];
  results: Array<{ result: string | null; numTurns: number | null; cost: number | null }>;
  toolErrorFrames: Array<Record<string, unknown>>;
}

/**
 * Build a sinks object that records every call. Also captures the raw
 * `user/tool_result` frames that the dispatcher treats as errors — we read
 * those from the writer output directly since there's no dedicated sink.
 */
function makeCaptureSinks(writerLines: Array<Record<string, unknown>>): {
  sinks: Record<string, unknown>;
  capture: DispatcherCapture;
} {
  const capture: DispatcherCapture = {
    sessionIds: [],
    toolIncrements: 0,
    assistantTexts: [],
    results: [],
    toolErrorFrames: [],
  };

  for (const frame of writerLines) {
    if (frame.type !== "user") continue;
    const msg = frame.message as { content?: Array<Record<string, unknown>> } | undefined;
    if (!msg?.content) continue;
    for (const block of msg.content) {
      if (block.type === "tool_result" && block.is_error === true) {
        capture.toolErrorFrames.push(block);
      }
    }
  }

  const sinks = {
    clipId: undefined,
    onSessionInit: (sid: string | null) => {
      capture.sessionIds.push(sid);
    },
    onToolUseIncrement: (): number => {
      capture.toolIncrements += 1;
      return capture.toolIncrements;
    },
    onToolHeartbeat: (): { stuck: boolean } => ({ stuck: false }),
    onPlanTodos: () => {},
    onAssistantText: (text: string) => {
      capture.assistantTexts.push(text);
    },
    onResult: (r: { result: string | null; numTurns: number | null; cost: number | null }) => {
      capture.results.push(r);
    },
    onStreamChat: async () => {},
  };

  return { sinks, capture };
}

// ---------------------------------------------------------------------------
// Suite 1 — Dispatcher sink parity
// ---------------------------------------------------------------------------

describe.skipIf(!dispatcherAvailable)("dispatcher parity", () => {
  it("A-text: drives onSessionInit / onAssistantText / onResult", async () => {
    const events = buildATextEvents();
    const { parsed } = await runWriter(events);

    const makeHandleEvent = await loadHandleEventFactory();
    const { sinks, capture } = makeCaptureSinks(parsed);
    const handleEvent = makeHandleEvent(sinks);

    for (const frame of parsed) await handleEvent(frame);

    expect(capture.sessionIds.length).toBeGreaterThanOrEqual(1);
    expect(capture.sessionIds[0]).toBeTruthy();
    expect(capture.assistantTexts).toContain("pong");
    expect(capture.results.length).toBe(1);
    const first = capture.results[0];
    if (!first) throw new Error("onResult not fired");
    expect(first.result).toBe("pong");
    expect(first.numTurns).toBe(1);
    expect(typeof first.cost === "number" || first.cost === null).toBe(true);
  });

  it("B-tool: increments tool counter + fires assistant text + result", async () => {
    const events = buildBToolEvents();
    const { parsed } = await runWriter(events);

    const makeHandleEvent = await loadHandleEventFactory();
    const { sinks, capture } = makeCaptureSinks(parsed);
    const handleEvent = makeHandleEvent(sinks);

    for (const frame of parsed) await handleEvent(frame);

    expect(capture.sessionIds[0]).toBeTruthy();
    expect(capture.toolIncrements).toBeGreaterThanOrEqual(1);
    expect(capture.assistantTexts).toContain("Here are the files.");
    expect(capture.results.length).toBe(1);
    const first = capture.results[0];
    if (!first) throw new Error("onResult not fired");
    expect(first.result).toBe("Here are the files.");
  });

  it("C-tool-error: surfaces is_error tool_result and still fires onResult", async () => {
    const events = buildCToolErrorEvents();
    const { parsed } = await runWriter(events);

    const makeHandleEvent = await loadHandleEventFactory();
    const { sinks, capture } = makeCaptureSinks(parsed);
    const handleEvent = makeHandleEvent(sinks);

    for (const frame of parsed) await handleEvent(frame);

    expect(capture.sessionIds[0]).toBeTruthy();
    expect(capture.toolErrorFrames.length).toBeGreaterThanOrEqual(1);
    const errFrame = capture.toolErrorFrames[0];
    expect(errFrame).toBeDefined();
    expect(errFrame?.is_error).toBe(true);
    expect(capture.results.length).toBe(1);
    const first = capture.results[0];
    if (!first) throw new Error("onResult not fired");
    expect(first.result).toBe("It failed.");
  });
});

// ---------------------------------------------------------------------------
// Suite 2 — Fixture-normalized diff
// ---------------------------------------------------------------------------

function normalizeFrame(frame: Record<string, unknown>): Record<string, unknown> {
  const stripKeys = new Set([
    "uuid",
    "session_id",
    "ts",
    "duration_ms",
    "duration_api_ms",
    "total_cost_usd",
    "cost_usd",
    "parent_tool_use_id",
    "timestamp",
    "seq",
  ]);
  const elideKeys = new Set(["modelUsage", "iterations", "rate_limit_info", "memory_paths"]);
  const tokenKeys = new Set([
    "input_tokens",
    "output_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
  ]);

  const walk = (value: unknown): unknown => {
    if (value === null || value === undefined) return value;
    if (Array.isArray(value)) return value.map(walk);
    if (typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (stripKeys.has(k)) continue;
        if (elideKeys.has(k)) {
          out[k] = "<elided>";
          continue;
        }
        if (tokenKeys.has(k)) {
          out[k] = "<n>";
          continue;
        }
        out[k] = walk(v);
      }
      return out;
    }
    return value;
  };

  return walk(frame) as Record<string, unknown>;
}

function readClaudeFixture(name: string): Array<Record<string, unknown>> {
  const raw = readFileSync(resolvePath(FIXTURE_DIR, name), "utf8");
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function firstMeaningful(
  frames: Array<Record<string, unknown>>,
): Record<string, unknown> | undefined {
  return frames.find((f) => {
    if (f.type === "system") {
      const sub = f.subtype;
      return sub !== "hook_started" && sub !== "hook_response";
    }
    return true;
  });
}

describe("fixture-normalized diff", () => {
  const cases: Array<{ name: string; build: () => AgentEvent[] }> = [
    { name: "A-text.claude.ndjson", build: buildATextEvents },
    { name: "B-tool.claude.ndjson", build: buildBToolEvents },
    { name: "C-tool-error.claude.ndjson", build: buildCToolErrorEvents },
  ];

  for (const { name, build } of cases) {
    it(`${name}: writer output is subsetable into claude fixture`, async () => {
      const { parsed: writerFrames } = await runWriter(build());
      const claudeFrames = readClaudeFixture(name);

      const writerNorm = writerFrames.map(normalizeFrame);
      const claudeNorm = claudeFrames.map(normalizeFrame);

      // (a) first meaningful frame aligns on type/subtype
      const writerFirst = firstMeaningful(writerNorm);
      const claudeFirst = firstMeaningful(claudeNorm);
      expect(writerFirst).toBeDefined();
      expect(claudeFirst).toBeDefined();
      expect(writerFirst?.type).toBe("system");
      expect(writerFirst?.subtype).toBe("init");
      expect(claudeFirst?.type).toBe("system");
      expect(claudeFirst?.subtype).toBe("init");

      // (b) at least one assistant frame exists in both.
      expect(writerNorm.some((f) => f.type === "assistant")).toBe(true);
      expect(claudeNorm.some((f) => f.type === "assistant")).toBe(true);

      // (c) final result frame matches on core fields.
      const writerResult = [...writerNorm].reverse().find((f) => f.type === "result");
      const claudeResult = [...claudeNorm].reverse().find((f) => f.type === "result");
      expect(writerResult).toBeDefined();
      expect(claudeResult).toBeDefined();
      // subtype + is_error must match exactly
      expect(writerResult?.subtype).toBe(claudeResult?.subtype);
      expect(writerResult?.is_error).toBe(claudeResult?.is_error);
      // stop_reason / terminal_reason / permission_denials should match if the
      // writer emits them — skip the assert when absent (writer is a subset).
      if (writerResult?.stop_reason !== undefined) {
        expect(writerResult.stop_reason).toBe(claudeResult?.stop_reason);
      }
      if (writerResult?.terminal_reason !== undefined) {
        expect(writerResult.terminal_reason).toBe(claudeResult?.terminal_reason);
      }
      if (writerResult?.permission_denials !== undefined) {
        expect(writerResult.permission_denials).toEqual(claudeResult?.permission_denials);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Suite 3 — Invariants
// ---------------------------------------------------------------------------

describe("writer invariants", () => {
  const cases: Array<{ label: string; build: () => AgentEvent[] }> = [
    { label: "A-text", build: buildATextEvents },
    { label: "B-tool", build: buildBToolEvents },
    { label: "C-tool-error", build: buildCToolErrorEvents },
  ];

  for (const { label, build } of cases) {
    it(`${label}: every tool_use.id has a matching tool_result.tool_use_id`, async () => {
      const { parsed } = await runWriter(build());
      const toolUseIds = new Set<string>();
      const toolResultIds = new Set<string>();
      for (const frame of parsed) {
        if (frame.type === "assistant") {
          const msg = frame.message as { content?: Array<Record<string, unknown>> } | undefined;
          for (const block of msg?.content ?? []) {
            if (block.type === "tool_use" && typeof block.id === "string") {
              toolUseIds.add(block.id);
            }
          }
        }
        if (frame.type === "user") {
          const msg = frame.message as { content?: Array<Record<string, unknown>> } | undefined;
          for (const block of msg?.content ?? []) {
            if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
              toolResultIds.add(block.tool_use_id);
            }
          }
        }
      }
      for (const id of toolUseIds) {
        expect(toolResultIds.has(id)).toBe(true);
      }
    });

    it(`${label}: first line is system/init and last line is type:"result"`, async () => {
      const { parsed } = await runWriter(build());
      expect(parsed.length).toBeGreaterThan(0);
      const first = parsed[0];
      const last = parsed[parsed.length - 1];
      if (!first || !last) throw new Error("no frames");
      const firstOk =
        (first.type === "system" && first.subtype === "init") ||
        (first.type === "result" && first.is_error === true);
      expect(firstOk).toBe(true);
      expect(last.type).toBe("result");
    });

    it(`${label}: every line ends with \\n and parses as JSON`, async () => {
      const stdout = new MemStream();
      const writer = new ClaudeStreamJsonWriter(asStream(stdout), {
        cwd: DEFAULT_WRITER_OPTS.cwd,
        tools: DEFAULT_WRITER_OPTS.tools,
        permissionMode: DEFAULT_WRITER_OPTS.permissionMode,
      });
      for (const ev of build()) await writer.write(ev);
      await writer.finish();
      const raw = stdout.text();
      expect(raw.length).toBeGreaterThan(0);
      expect(raw.endsWith("\n")).toBe(true);
      const lines = stdout.lines();
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    });
  }

  it("session.completed-before-session.started is still safely serializable", async () => {
    const reordered: AgentEvent[] = [
      {
        type: "session.completed",
        ...envelope("sess-edge", 0),
        turns: 0,
        duration_ms: 0,
      },
    ];
    // Writer should either emit an error-result frame as the first line OR
    // still emit *some* terminating result line. Either way, last line must
    // be a result frame.
    const { parsed } = await runWriter(reordered);
    expect(parsed.length).toBeGreaterThan(0);
    const last = parsed[parsed.length - 1];
    if (!last) throw new Error("no frames");
    expect(last.type).toBe("result");
  });
});

// ---------------------------------------------------------------------------
// Suite 4 — Live smoke (gated via RUN_LIVE=1)
// ---------------------------------------------------------------------------

const runLive = process.env.RUN_LIVE === "1";
const cliBuilt = existsSync(resolvePath(HERE, "../../dist/cli/main.js"));

describe.skipIf(!runLive || !cliBuilt)("live smoke: claude-stream-json end-to-end", () => {
  it("spawns main.js run 'say pong' --output-format claude-stream-json and replays into dispatcher", async () => {
    const cliPath = resolvePath(HERE, "../../dist/cli/main.js");
    const res = spawnSync(
      "node",
      [cliPath, "run", "say pong", "--output-format", "claude-stream-json"],
      {
        env: { ...process.env },
        encoding: "utf8",
        timeout: 120_000,
      },
    );
    expect(res.status).toBe(0);
    const stdout = res.stdout ?? "";
    const lines = stdout.split("\n").filter((l) => l.trim().length > 0);
    expect(lines.length).toBeGreaterThan(0);

    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    const first = parsed[0];
    const last = parsed[parsed.length - 1];
    if (!first || !last) throw new Error("no frames");
    expect(first.type).toBe("system");
    expect(first.subtype).toBe("init");
    expect(last.type).toBe("result");
    expect(last.is_error).toBe(false);

    if (!dispatcherAvailable) return;
    const makeHandleEvent = await loadHandleEventFactory();
    const { sinks, capture } = makeCaptureSinks(parsed);
    const handleEvent = makeHandleEvent(sinks);
    for (const frame of parsed) await handleEvent(frame);
    expect(capture.results.length).toBeGreaterThanOrEqual(1);
    const firstResult = capture.results[0];
    if (!firstResult) throw new Error("onResult not fired");
    expect(typeof firstResult.result === "string" && firstResult.result.length > 0).toBe(true);
  });
});
