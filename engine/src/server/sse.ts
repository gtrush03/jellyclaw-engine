/**
 * Phase 10.02 — SSE stream helper.
 *
 * Route handler responsibility: open a Hono `streamSSE` and pass the live
 * {@link SSEStreamingApi} here. This helper then:
 *   1. Drains the in-memory ring buffer from `lastEventId + 1` (or from the
 *      beginning if no `Last-Event-Id`).
 *   2. If `lastEventId` predates `run.buffer`'s floor, replays from the
 *      durable JSONL via {@link replayJsonl} to fill the gap.
 *   3. Subscribes to the run's EventEmitter for live events.
 *   4. On the terminal `done` event (or stream abort) unsubscribes and
 *      returns — the caller closes the underlying stream.
 *
 * Event format: `id:` is the monotonic BufferedEvent.id; `event:` is the
 * string `"event"`; terminal frame uses `event: "done"` with an `id: "done"`.
 * Hono's `writeSSE` handles the newline framing — we never emit raw lines.
 */

import type { SSEStreamingApi } from "hono/streaming";
import type { Logger } from "pino";

import type { AgentEvent } from "../events.js";
import { replayJsonl } from "../session/index.js";
import type { BufferedEvent, RunEntry } from "./types.js";

export interface StreamRunEventsOptions {
  readonly run: RunEntry;
  /** Durable JSONL location; required for below-floor replay. */
  readonly sessionLogPath: string;
  /** Parsed `Last-Event-Id` header (numeric). `null` means "from start". */
  readonly lastEventId: number | null;
  readonly signal: AbortSignal;
  readonly stream: SSEStreamingApi;
  readonly logger: Logger;
}

/**
 * Main SSE pump. Resolves when the run terminates (done frame emitted) or
 * the abort signal fires.
 */
export async function streamRunEvents(opts: StreamRunEventsOptions): Promise<void> {
  const { run, sessionLogPath, lastEventId, signal, stream, logger } = opts;

  // -------------------------------------------------------------------------
  // Phase 1: backfill anything the subscriber missed.
  // -------------------------------------------------------------------------
  const bufferFloor = run.buffer.length > 0 ? (run.buffer[0]?.id ?? 0) : 0;
  const needsJsonlReplay = lastEventId !== null && lastEventId < bufferFloor;

  if (needsJsonlReplay) {
    try {
      const replay = await replayJsonl(sessionLogPath, { logger });
      // Our SSE ids are ring-buffer indices, but JSONL stores AgentEvent.seq
      // values. Since ring-buffer ids are assigned 1:1 with emitted events,
      // we map each replayed event index → id. The caller reconstructs
      // continuity via event `seq` if needed.
      let replayIdx = 0;
      for (const ev of replay.events) {
        if (replayIdx > lastEventId) {
          await writeEvent(stream, replayIdx, ev);
        }
        replayIdx++;
        if (signal.aborted) return;
      }
    } catch (err) {
      logger.warn({ err, sessionLogPath }, "sse: JSONL replay failed; continuing from buffer");
    }
  }

  // Flush in-memory buffer (either all of it, or the tail above lastEventId).
  for (const buffered of run.buffer) {
    if (lastEventId !== null && buffered.id <= lastEventId) continue;
    await writeEvent(stream, buffered.id, buffered.event);
    if (signal.aborted) return;
  }

  // -------------------------------------------------------------------------
  // Phase 2: live subscription.
  // -------------------------------------------------------------------------
  if (run.status !== "running") {
    // Already terminal — emit the done frame and return.
    await writeDone(stream, run.status, run.sessionId);
    return;
  }

  await new Promise<void>((resolve) => {
    let settled = false;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      run.emitter.off("event", onEvent);
      run.emitter.off("done", onDone);
      signal.removeEventListener("abort", onAbort);
      resolve();
    };

    const onEvent = (buffered: BufferedEvent): void => {
      void writeEvent(stream, buffered.id, buffered.event).catch((err) => {
        logger.warn({ err }, "sse: writeEvent failed; closing subscriber");
        finish();
      });
    };

    const onDone = (payload: { status: string; sessionId: string }): void => {
      void writeDone(stream, payload.status, payload.sessionId).finally(() => finish());
    };

    const onAbort = (): void => finish();

    run.emitter.on("event", onEvent);
    run.emitter.once("done", onDone);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function writeEvent(stream: SSEStreamingApi, id: number, event: AgentEvent): Promise<void> {
  await stream.writeSSE({
    id: String(id),
    event: "event",
    data: JSON.stringify(event),
  });
}

async function writeDone(
  stream: SSEStreamingApi,
  status: string,
  sessionId: string,
): Promise<void> {
  await stream.writeSSE({
    id: "done",
    event: "done",
    data: JSON.stringify({ status, sessionId }),
  });
}

/**
 * Parse a `Last-Event-Id` header into a numeric index. Returns `null` if
 * absent or non-numeric (e.g., the terminal `"done"` sentinel).
 */
export function parseLastEventId(header: string | undefined): number | null {
  if (header === undefined) return null;
  const n = Number.parseInt(header, 10);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}
