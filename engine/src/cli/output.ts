/**
 * Phase 10.01 — CLI output writers.
 *
 * Three writers share the `OutputWriter` contract defined in
 * `output-types.ts`. Each writer is constructed via `createOutputWriter`
 * and consumes the canonical 15-variant `AgentEvent` stream.
 *
 *   stream-json — newline-delimited JSON, one event per line to stdout.
 *   text        — human-readable text: assistant deltas on stdout,
 *                 `[tool: <name>] …` on stderr when verbose.
 *   json        — buffers everything, flushes one pretty JSON object on
 *                 `finish()` with a transcript + aggregate usage.
 *
 * All writes are serialized internally: `write()` awaits `drain` on
 * backpressure before resolving, mirroring `engine/src/stream/emit.ts`.
 * Callers may `await` sequentially without an external lock.
 */

import type { AgentEvent } from "../events.js";
import { listTools } from "../tools/index.js";
import { ClaudeStreamJsonWriter } from "./output-claude-stream-json.js";
import type { CreateOutputWriterOptions, OutputWriter } from "./output-types.js";

// ---------------------------------------------------------------------------
// Backpressure-aware line writer
// ---------------------------------------------------------------------------

function writeLine(stream: NodeJS.WritableStream, line: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const ok = stream.write(line, (err) => {
      if (err) reject(err);
    });
    if (ok) {
      resolve();
      return;
    }
    stream.once("drain", () => resolve());
  });
}

// ---------------------------------------------------------------------------
// stream-json
// ---------------------------------------------------------------------------

class StreamJsonWriter implements OutputWriter {
  readonly #stdout: NodeJS.WritableStream;

  constructor(stdout: NodeJS.WritableStream) {
    this.#stdout = stdout;
  }

  async write(event: AgentEvent): Promise<void> {
    await writeLine(this.#stdout, `${JSON.stringify(event)}\n`);
  }

  // biome-ignore lint/suspicious/useAwait: OutputWriter contract is async; stream-json has nothing to flush.
  async finish(): Promise<void> {
    // Nothing to flush — every event was emitted eagerly.
    return;
  }
}

// ---------------------------------------------------------------------------
// text
// ---------------------------------------------------------------------------

class TextWriter implements OutputWriter {
  readonly #stdout: NodeJS.WritableStream;
  readonly #stderr: NodeJS.WritableStream;
  readonly #verbose: boolean;

  constructor(stdout: NodeJS.WritableStream, stderr: NodeJS.WritableStream, verbose: boolean) {
    this.#stdout = stdout;
    this.#stderr = stderr;
    this.#verbose = verbose;
  }

  async write(event: AgentEvent): Promise<void> {
    switch (event.type) {
      case "agent.message": {
        // Always stream deltas to stdout; append a newline on the final
        // delta so successive turns don't smear together.
        const suffix = event.final ? "\n" : "";
        await writeLine(this.#stdout, `${event.delta}${suffix}`);
        return;
      }
      case "agent.thinking": {
        if (this.#verbose) {
          await writeLine(this.#stderr, `[thinking] ${event.delta}`);
        }
        return;
      }
      case "tool.called": {
        if (this.#verbose) {
          await writeLine(
            this.#stderr,
            `[tool: ${event.tool_name}] ${JSON.stringify(event.input)}\n`,
          );
        }
        return;
      }
      case "tool.result": {
        if (this.#verbose) {
          await writeLine(this.#stderr, `[tool: ${event.tool_name}] ok (${event.duration_ms}ms)\n`);
        }
        return;
      }
      case "tool.error": {
        // Errors surface even without verbose — users deserve to know a
        // tool failed.
        await writeLine(
          this.#stderr,
          `[tool: ${event.tool_name}] error ${event.code}: ${event.message}\n`,
        );
        return;
      }
      case "session.error": {
        await writeLine(this.#stderr, `[error ${event.code}] ${event.message}\n`);
        return;
      }
      case "permission.requested": {
        if (this.#verbose) {
          await writeLine(this.#stderr, `[permission] ${event.tool_name}: ${event.reason}\n`);
        }
        return;
      }
      case "permission.granted":
      case "permission.denied":
      case "subagent.spawned":
      case "subagent.returned":
      case "session.started":
      case "session.completed":
      case "usage.updated":
      case "stream.ping":
      case "user.prompt":
        // Not user-facing chrome; suppressed in text mode. (user.prompt is
        // persisted to the JSONL transcript; echoing it back to stdout would
        // duplicate what the TUI already rendered.)
        return;
      default: {
        const _exhaustive: never = event;
        // Unreachable; keeps exhaustiveness honest at compile time.
        void _exhaustive;
        return;
      }
    }
  }

  // biome-ignore lint/suspicious/useAwait: OutputWriter contract is async; text writer flushes nothing.
  async finish(): Promise<void> {
    return;
  }
}

// ---------------------------------------------------------------------------
// json (buffered)
// ---------------------------------------------------------------------------

interface AggregatedUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
}

class JsonBufferWriter implements OutputWriter {
  readonly #stdout: NodeJS.WritableStream;
  readonly #transcript: AgentEvent[] = [];
  readonly #usage: AggregatedUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    cost_usd: 0,
  };
  #sessionId: string | undefined;
  #startTs: number | undefined;
  #endTs: number | undefined;

  constructor(stdout: NodeJS.WritableStream) {
    this.#stdout = stdout;
  }

  // biome-ignore lint/suspicious/useAwait: OutputWriter contract is async; json buffers and emits in finish().
  async write(event: AgentEvent): Promise<void> {
    this.#transcript.push(event);

    if (this.#sessionId === undefined) {
      this.#sessionId = event.session_id;
    }
    if (this.#startTs === undefined || event.ts < this.#startTs) {
      this.#startTs = event.ts;
    }
    if (this.#endTs === undefined || event.ts > this.#endTs) {
      this.#endTs = event.ts;
    }

    if (event.type === "usage.updated") {
      this.#usage.input_tokens += event.input_tokens;
      this.#usage.output_tokens += event.output_tokens;
      this.#usage.cache_read_tokens += event.cache_read_tokens;
      this.#usage.cache_write_tokens += event.cache_write_tokens;
      if (typeof event.cost_usd === "number") {
        this.#usage.cost_usd += event.cost_usd;
      }
    }
    return;
  }

  async finish(): Promise<void> {
    const durationMs =
      this.#startTs !== undefined && this.#endTs !== undefined ? this.#endTs - this.#startTs : 0;
    // Whole-cent integer per the public contract. `Math.round` not
    // `Math.floor` to preserve sign and avoid negative-zero artifacts.
    const costUsdCents = Math.round(this.#usage.cost_usd * 100);
    const payload = {
      session_id: this.#sessionId ?? "",
      transcript: this.#transcript,
      usage: {
        input_tokens: this.#usage.input_tokens,
        output_tokens: this.#usage.output_tokens,
        cache_read_tokens: this.#usage.cache_read_tokens,
        cache_write_tokens: this.#usage.cache_write_tokens,
        cost_usd: this.#usage.cost_usd,
      },
      cost_usd_cents: costUsdCents,
      duration_ms: durationMs,
    };
    await writeLine(this.#stdout, `${JSON.stringify(payload, null, 2)}\n`);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createOutputWriter(opts: CreateOutputWriterOptions): OutputWriter {
  switch (opts.format) {
    case "stream-json":
      return new StreamJsonWriter(opts.stdout);
    case "text":
      return new TextWriter(opts.stdout, opts.stderr, opts.verbose);
    case "json":
      return new JsonBufferWriter(opts.stdout);
    case "claude-stream-json":
      return new ClaudeStreamJsonWriter(opts.stdout, {
        cwd: process.cwd(),
        tools: listTools().map((t) => t.name),
        permissionMode: "default",
      });
    default: {
      const _exhaustive: never = opts.format;
      throw new Error(`unsupported output format: ${String(_exhaustive)}`);
    }
  }
}
