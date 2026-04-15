/**
 * stream-json emitter — Phase 03 Prompt 03.
 *
 * Projects the canonical 15-variant `Event` stream onto one of three
 * wire formats (`jellyclaw-full`, `claude-code-compat`, `claurst-min`)
 * and writes NDJSON lines to a `WritableLike` sink while honouring
 * Node-stream backpressure.
 *
 * Notes:
 *   - We trust inbound `Event`s — no zod re-parse. Garbage in = adapter
 *     bug, not emitter bug.
 *   - `claurst-min` is the only format that emits non-jellyclaw shapes
 *     on the wire (`{type:"text",value}` and `{type:"result",status,
 *     duration_ms}`), to match Claurst v0's minimum surface.
 *   - Never reads wall-clock time. `ts` for any synthesised event is
 *     taken from the last seen event or from an injected clock.
 */

import type { AssistantMessageEvent, Event, OutputFormat, Usage } from "@jellyclaw/shared";
import { OUTPUT_FORMAT_EVENTS } from "@jellyclaw/shared";

/**
 * Minimal subset of `NodeJS.WritableStream` we actually need. Accepting
 * the narrow shape lets tests pass a `MockStream` without type
 * gymnastics, and keeps the surface area we depend on small.
 */
export interface WritableLike {
  write(chunk: string, cb?: (err?: Error | null) => void): boolean;
  once(event: "drain", listener: () => void): this;
}

const ZERO_USAGE: Usage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  cost_usd: 0,
};

/** Writes one NDJSON line, awaiting `drain` if the stream applied backpressure. */
export function writeEvent(stream: WritableLike, event: Event): Promise<void> {
  return writeLine(stream, `${JSON.stringify(event)}\n`);
}

function writeLine(stream: WritableLike, line: string): Promise<void> {
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

/**
 * Stateless downgrade of a single event for a given format.
 *
 * Returns the translated event(s) to emit, or `null` to drop. For
 * `claude-code-compat`, `assistant.delta` always returns `null` because
 * deltas are coalesced across events — use {@link StreamEmitter} for
 * stream-aware behaviour, this helper for one-shot translation where
 * the caller handles coalescing externally.
 *
 * For `claurst-min`, this returns the jellyclaw `assistant.delta` /
 * `result` event unchanged; the caller (StreamEmitter) is responsible
 * for writing the Claurst-shaped flat JSON line.
 */
export function downgrade(event: Event, format: OutputFormat): Event | null {
  if (format === "jellyclaw-full") return event;

  if (format === "claude-code-compat") {
    if (event.type === "assistant.delta") return null;
    return OUTPUT_FORMAT_EVENTS["claude-code-compat"].has(event.type) ? event : null;
  }

  // claurst-min
  return OUTPUT_FORMAT_EVENTS["claurst-min"].has(event.type) ? event : null;
}

interface DeltaBuffer {
  text: string;
  ts: number;
}

/**
 * A stateful emitter that applies format downgrades and coalescing
 * across a stream. One instance per session-stream; callers may share
 * a single underlying writable (e.g. process.stdout) across instances.
 */
export class StreamEmitter {
  private readonly stream: WritableLike;
  private readonly format: OutputFormat;
  /** Per-session buffer for `assistant.delta` coalescing in claude-code-compat. */
  private readonly deltaBuffers = new Map<string, DeltaBuffer>();
  /** Last-seen `ts` from any inbound event; used as the synthetic clock. */
  private lastTs = 0;

  constructor(stream: WritableLike, format: OutputFormat) {
    this.stream = stream;
    this.format = format;
  }

  async emit(event: Event): Promise<void> {
    if (event.ts > this.lastTs) this.lastTs = event.ts;

    if (this.format === "jellyclaw-full") {
      await writeEvent(this.stream, event);
      return;
    }

    if (this.format === "claude-code-compat") {
      await this.emitClaudeCodeCompat(event);
      return;
    }

    await this.emitClaurstMin(event);
  }

  /**
   * Flush any buffered coalesced state and close the logical stream.
   * Does not close the underlying writable — that's the caller's job.
   */
  async finish(): Promise<void> {
    if (this.format !== "claude-code-compat") {
      this.deltaBuffers.clear();
      return;
    }
    // Flush any sessions with deltas that never saw an assistant.message.
    for (const [sessionId, buf] of this.deltaBuffers) {
      const synthetic: AssistantMessageEvent = {
        type: "assistant.message",
        session_id: sessionId,
        message: { role: "assistant", content: [{ type: "text", text: buf.text }] },
        usage: ZERO_USAGE,
        ts: buf.ts || this.lastTs,
      };
      await writeEvent(this.stream, synthetic);
    }
    this.deltaBuffers.clear();
  }

  private async emitClaudeCodeCompat(event: Event): Promise<void> {
    if (event.type === "assistant.delta") {
      const existing = this.deltaBuffers.get(event.session_id);
      if (existing) {
        existing.text += event.text;
        existing.ts = event.ts;
      } else {
        this.deltaBuffers.set(event.session_id, { text: event.text, ts: event.ts });
      }
      return;
    }

    if (event.type === "assistant.message") {
      const buffered = this.deltaBuffers.get(event.session_id);
      this.deltaBuffers.delete(event.session_id);
      const accumulated = buffered?.text ?? "";
      const content =
        accumulated.length > 0
          ? [{ type: "text" as const, text: accumulated }]
          : normaliseToTextBlocks(event.message.content);
      const rewritten: AssistantMessageEvent = {
        type: "assistant.message",
        session_id: event.session_id,
        message: { role: event.message.role, content },
        usage: event.usage,
        ts: event.ts,
      };
      await writeEvent(this.stream, rewritten);
      return;
    }

    if (OUTPUT_FORMAT_EVENTS["claude-code-compat"].has(event.type)) {
      await writeEvent(this.stream, event);
    }
    // Everything else is dropped.
  }

  private async emitClaurstMin(event: Event): Promise<void> {
    if (event.type === "assistant.delta") {
      // claurst-min writes the one-and-only non-jellyclaw shape on the wire.
      const line = `${JSON.stringify({ type: "text", value: event.text })}\n`;
      await writeLine(this.stream, line);
      return;
    }
    if (event.type === "result") {
      const line = `${JSON.stringify({
        type: "result",
        status: event.status,
        duration_ms: event.stats.duration_ms,
      })}\n`;
      await writeLine(this.stream, line);
      return;
    }
    // Everything else is dropped.
  }
}

/**
 * Coerce a Message.content (string | Block[]) into the text-block array
 * shape claude-code-compat expects. Non-text blocks are stringified to
 * keep the contract simple — claude-code-compat is text-only by design.
 */
function normaliseToTextBlocks(
  content: string | ReadonlyArray<{ type: string; text?: string }>,
): { type: "text"; text: string }[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  const out: { type: "text"; text: string }[] = [];
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") {
      out.push({ type: "text", text: block.text });
    }
  }
  if (out.length === 0) out.push({ type: "text", text: "" });
  return out;
}
