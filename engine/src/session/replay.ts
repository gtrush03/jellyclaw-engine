/**
 * Phase 09.02 — streaming JSONL replay.
 *
 * Reads an `<id>.jsonl` file line-by-line (via readline over a read stream —
 * never `readFile` — because 100 MB transcripts are a design target) and
 * returns the validated `AgentEvent` sequence plus metadata about truncation.
 *
 * The EOF-truncation rule: the LAST non-empty line is parsed lazily. Any
 * parse/schema failure on a line that turns out to be mid-file is a hard
 * `JsonlCorruptError`; the same failure on the final line is quietly dropped
 * and `truncatedTail: true` is reported. This mirrors the writer's durability
 * contract: `flushTurn()` fsyncs at turn boundary, so the only legal torn
 * line is the one we were mid-write to when the process died.
 */

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

import type { Logger } from "pino";

import { AgentEvent } from "../events.js";
import { createLogger } from "../logger.js";
import { JsonlCorruptError } from "./types.js";

export interface ReplayResult {
  readonly events: readonly AgentEvent[];
  readonly truncatedTail: boolean;
  readonly linesRead: number;
  readonly bytesRead: number;
}

export interface ReplayJsonlOptions {
  readonly logger?: Logger;
}

/**
 * Parse one JSON line into a validated `AgentEvent`. Returns `null` if the
 * line is not parseable or not a valid event; the caller decides whether the
 * failure is mid-file (fatal) or EOF (tolerable).
 */
function tryParseLine(line: string): AgentEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  const result = AgentEvent.safeParse(parsed);
  if (!result.success) return null;
  return result.data;
}

export async function replayJsonl(
  path: string,
  options: ReplayJsonlOptions = {},
): Promise<ReplayResult> {
  const logger = options.logger ?? createLogger({ name: "session-replay" });

  const events: AgentEvent[] = [];
  let linesRead = 0;
  let bytesRead = 0;
  let truncatedTail = false;

  // Cursor: the most recent non-empty line we've seen, along with its line
  // number. We defer parsing it until either (a) a subsequent non-empty line
  // arrives (proving the cursor line was complete), or (b) the stream ends.
  let pending: { line: string; lineNumber: number } | null = null;

  let stream: ReturnType<typeof createReadStream>;
  try {
    stream = createReadStream(path, { encoding: "utf8" });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { events: [], truncatedTail: false, linesRead: 0, bytesRead: 0 };
    }
    throw err;
  }

  // createReadStream is lazy — ENOENT surfaces as an "error" event, not a
  // throw. Handle both paths.
  try {
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    let lineNumber = 0;
    for await (const rawLine of rl) {
      lineNumber += 1;
      // `+ 1` approximates the trailing newline (LF). We don't care about
      // bytes on the last truncated line — approximation is fine per spec.
      bytesRead += Buffer.byteLength(rawLine, "utf8") + 1;

      if (rawLine.length === 0) {
        // Skip empty lines silently. They don't flush a pending cursor either:
        // an empty line is just whitespace, not proof that the cursor was
        // terminated by a newline.
        continue;
      }

      // A new non-empty line means any pending cursor was complete (it ended
      // in a newline that readline stripped). Parse it strictly now.
      if (pending !== null) {
        const event = tryParseLine(pending.line);
        if (event === null) {
          throw new JsonlCorruptError(`JSONL at ${path}: malformed event`, pending.lineNumber);
        }
        events.push(event);
        linesRead += 1;
        pending = null;
      }

      pending = { line: rawLine, lineNumber };
    }
  } catch (err) {
    // Propagate stream ENOENT (it surfaces here if the file vanishes between
    // stat and first chunk) as an empty replay.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { events: [], truncatedTail: false, linesRead: 0, bytesRead: 0 };
    }
    throw err;
  }

  // Drain the cursor. The stream ended, so we can't tell (from readline
  // alone) whether the final line had a trailing newline. Try to parse it:
  // success → keep; failure → treat as truncated tail and warn.
  if (pending !== null) {
    const event = tryParseLine(pending.line);
    if (event === null) {
      truncatedTail = true;
      logger.warn(
        { path, lineNumber: pending.lineNumber },
        "replay: dropping truncated/invalid tail line",
      );
    } else {
      events.push(event);
      linesRead += 1;
    }
  }

  return { events, truncatedTail, linesRead, bytesRead };
}
