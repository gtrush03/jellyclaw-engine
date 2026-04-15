/**
 * Phase 10.01 — CLI output writer tests.
 *
 * Covers the three writers (`stream-json`, `text`, `json`) plus the
 * `resolveOutputFormat` flag resolver. No process spawning — all writers
 * are fed in-memory `MemStream` instances so tests are fast and
 * deterministic.
 */

import { describe, expect, it } from "vitest";

import type { AgentEvent } from "../events.js";
import { createOutputWriter } from "./output.js";
import { resolveOutputFormat } from "./output-types.js";

// ---------------------------------------------------------------------------
// In-memory writable stream for assertions
// ---------------------------------------------------------------------------

class MemStream {
  chunks: string[] = [];

  write(chunk: string, cb?: (err?: Error | null) => void): boolean {
    this.chunks.push(chunk);
    if (cb) cb();
    return true;
  }

  once(_event: "drain", _listener: () => void): this {
    // MemStream never applies backpressure; `drain` never fires.
    return this;
  }

  text(): string {
    return this.chunks.join("");
  }

  lines(): string[] {
    const text = this.text();
    if (text.length === 0) return [];
    // Split on \n but drop the trailing empty (from the terminating \n).
    const parts = text.split("\n");
    if (parts[parts.length - 1] === "") parts.pop();
    return parts;
  }
}

function asStream(s: MemStream): NodeJS.WritableStream {
  return s as unknown as NodeJS.WritableStream;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseEnvelope = (
  seq: number,
  ts = 1_700_000_000_000 + seq,
): {
  session_id: string;
  ts: number;
  seq: number;
} => ({ session_id: "sess-1", ts, seq });

const sampleEvents: AgentEvent[] = [
  {
    type: "session.started",
    ...baseEnvelope(0),
    wish: "hello",
    agent: "default",
    model: "claude-sonnet-4",
    provider: "anthropic",
    cwd: "/tmp",
  },
  {
    type: "agent.message",
    ...baseEnvelope(1),
    delta: "Hello",
    final: false,
  },
  {
    type: "tool.called",
    ...baseEnvelope(2),
    tool_id: "t1",
    tool_name: "bash",
    input: { cmd: "ls" },
  },
  {
    type: "usage.updated",
    ...baseEnvelope(3),
    input_tokens: 10,
    output_tokens: 5,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    cost_usd: 0.0123,
  },
  {
    type: "agent.message",
    ...baseEnvelope(4),
    delta: " world",
    final: true,
  },
];

// ---------------------------------------------------------------------------
// stream-json
// ---------------------------------------------------------------------------

describe("stream-json writer", () => {
  it("emits one JSON object per event, newline-delimited", async () => {
    const stdout = new MemStream();
    const stderr = new MemStream();
    const writer = createOutputWriter({
      format: "stream-json",
      stdout: asStream(stdout),
      stderr: asStream(stderr),
      verbose: false,
    });

    for (const ev of sampleEvents) await writer.write(ev);
    await writer.finish();

    const lines = stdout.lines();
    expect(lines).toHaveLength(sampleEvents.length);
    for (let i = 0; i < lines.length; i++) {
      const parsed = JSON.parse(lines[i] ?? "") as AgentEvent;
      expect(parsed).toEqual(sampleEvents[i]);
    }
    expect(stderr.text()).toBe("");
  });
});

// ---------------------------------------------------------------------------
// json (buffered)
// ---------------------------------------------------------------------------

describe("json writer", () => {
  it("buffers until finish(); emits one object with transcript and aggregated usage", async () => {
    const stdout = new MemStream();
    const stderr = new MemStream();
    const writer = createOutputWriter({
      format: "json",
      stdout: asStream(stdout),
      stderr: asStream(stderr),
      verbose: false,
    });

    for (const ev of sampleEvents) await writer.write(ev);
    expect(stdout.text()).toBe(""); // buffered
    await writer.finish();

    const parsed = JSON.parse(stdout.text()) as {
      session_id: string;
      transcript: AgentEvent[];
      usage: { input_tokens: number; output_tokens: number; cost_usd: number };
      cost_usd_cents: number;
      duration_ms: number;
    };
    expect(parsed.session_id).toBe("sess-1");
    expect(parsed.transcript).toHaveLength(sampleEvents.length);
    expect(parsed.usage.input_tokens).toBe(10);
    expect(parsed.usage.output_tokens).toBe(5);
    // Single 0.0123 USD event → 1.23 cents → round to 1.
    expect(parsed.cost_usd_cents).toBe(Math.round(0.0123 * 100));
    expect(parsed.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("sums usage across multiple usage.updated events", async () => {
    const stdout = new MemStream();
    const stderr = new MemStream();
    const writer = createOutputWriter({
      format: "json",
      stdout: asStream(stdout),
      stderr: asStream(stderr),
      verbose: false,
    });

    const usageEvents: AgentEvent[] = [
      {
        type: "usage.updated",
        ...baseEnvelope(0),
        input_tokens: 7,
        output_tokens: 3,
        cache_read_tokens: 1,
        cache_write_tokens: 2,
        cost_usd: 0.01,
      },
      {
        type: "usage.updated",
        ...baseEnvelope(1),
        input_tokens: 4,
        output_tokens: 6,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        cost_usd: 0.02,
      },
    ];

    for (const ev of usageEvents) await writer.write(ev);
    await writer.finish();

    const parsed = JSON.parse(stdout.text()) as {
      usage: {
        input_tokens: number;
        output_tokens: number;
        cache_read_tokens: number;
        cache_write_tokens: number;
      };
      cost_usd_cents: number;
    };
    expect(parsed.usage.input_tokens).toBe(11);
    expect(parsed.usage.output_tokens).toBe(9);
    expect(parsed.usage.cache_read_tokens).toBe(1);
    expect(parsed.usage.cache_write_tokens).toBe(2);
    expect(parsed.cost_usd_cents).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// text
// ---------------------------------------------------------------------------

describe("text writer", () => {
  it("non-verbose: emits agent.message deltas to stdout, omits tool events", async () => {
    const stdout = new MemStream();
    const stderr = new MemStream();
    const writer = createOutputWriter({
      format: "text",
      stdout: asStream(stdout),
      stderr: asStream(stderr),
      verbose: false,
    });

    for (const ev of sampleEvents) await writer.write(ev);
    await writer.finish();

    expect(stdout.text()).toContain("Hello");
    expect(stdout.text()).toContain(" world");
    expect(stderr.text()).toBe(""); // no tool/chrome in non-verbose
  });

  it("verbose: emits tool_use lines to stderr prefixed with [tool:", async () => {
    const stdout = new MemStream();
    const stderr = new MemStream();
    const writer = createOutputWriter({
      format: "text",
      stdout: asStream(stdout),
      stderr: asStream(stderr),
      verbose: true,
    });

    for (const ev of sampleEvents) await writer.write(ev);
    await writer.finish();

    expect(stderr.text()).toContain("[tool: bash]");
    expect(stdout.text()).toContain("Hello");
  });
});

// ---------------------------------------------------------------------------
// resolveOutputFormat
// ---------------------------------------------------------------------------

describe("resolveOutputFormat", () => {
  it("defaults to text on TTY and stream-json on pipe", () => {
    expect(resolveOutputFormat(undefined, true)).toBe("text");
    expect(resolveOutputFormat(undefined, false)).toBe("stream-json");
  });

  it("explicit flag always wins regardless of TTY", () => {
    expect(resolveOutputFormat("json", true)).toBe("json");
    expect(resolveOutputFormat("stream-json", true)).toBe("stream-json");
    expect(resolveOutputFormat("text", false)).toBe("text");
  });

  it("throws on invalid value", () => {
    expect(() => resolveOutputFormat("yaml", true)).toThrow(/invalid/);
  });
});
