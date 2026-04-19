import { useEffect, useRef, useState } from "react";
import { runEventsUrl } from "@/lib/api";

const MAX_LINES = 500;

/**
 * Decide what to do with a single SSE frame from `/api/runs/:id/events`.
 *
 * The server pushes event-name `log` with a JSON payload `{runId, line, at,
 * replay?}`. We accept a few shapes defensively:
 *   - `event: log` + JSON data containing `line` → emit the line.
 *   - `event: log` + raw string data (legacy)    → emit verbatim.
 *   - `event: message` (default)                 → treat as above.
 *   - any other event name                       → ignore (heartbeats etc.)
 *
 * Exported for unit testing — this is the exact piece that was dropping
 * server-emitted `log-line` frames silently in the broken build. Keeping
 * the decision logic in one pure function means the hook body stays tiny
 * and the regression is covered without mounting React.
 */
export type RunLogDecision = { kind: "ignore" } | { kind: "append"; line: string };

export function decideRunLogFrame(msg: { event?: string; data?: string }): RunLogDecision {
  // Only the `log` event carries a line; other events (status/heartbeat)
  // are ignored here — the global `useSSE` owns rig-wide invalidations.
  if (msg.event && msg.event !== "log" && msg.event !== "message") {
    return { kind: "ignore" };
  }
  if (!msg.data) return { kind: "ignore" };
  let text = msg.data;
  // Accept JSON `{line: "..."}` for forward-compat with the server's
  // current envelope (also emits `runId`, `at`, `replay?`).
  if (text.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === "object" && "line" in parsed) {
        const v = (parsed as { line: unknown }).line;
        if (typeof v === "string") text = v;
      }
    } catch {
      // Fall through — treat as raw.
    }
  }
  return { kind: "append", line: text };
}

/**
 * Tail live log output for a single run via SSE. Buffers the last 500 lines
 * in local state. The connection is only opened when `enabled` is true — so
 * the caller can gate on visibility to avoid eagerly streaming every run.
 *
 * Uses the browser's native `EventSource` which handles reconnection,
 * visibility, and back-pressure natively. The previous implementation using
 * `@microsoft/fetch-event-source` closed after the initial 300-byte preamble
 * on page load (race between StrictMode double-invoke and its onclose
 * throw-to-retry pattern).
 *
 * Backend event shape (matches `events.ts` sibling-agent spec):
 *   event: log
 *   data:  JSON `{runId, line, at, replay?}`
 */
export function useRunLog(runId: string | null, enabled: boolean) {
  const [lines, setLines] = useState<string[]>([]);
  const [connected, setConnected] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    // Reset when the target run changes.
    setLines([]);
    setConnected(false);

    if (!enabled || !runId) return;

    let url: string;
    try {
      url = runEventsUrl(runId);
    } catch {
      return;
    }

    const es = new EventSource(url);
    esRef.current = es;

    const append = (line: string) => {
      setLines((prev) => {
        const next = prev.length >= MAX_LINES ? prev.slice(prev.length - MAX_LINES + 1) : prev;
        return [...next, line];
      });
    };

    es.onopen = () => {
      setConnected(true);
    };
    es.onerror = () => {
      // EventSource auto-reconnects on error. Just reflect disconnected
      // state; the browser will retry after the server's `retry:` value.
      setConnected(false);
    };

    // The server emits named `log` frames; also accept the unnamed default
    // `message` channel for defensive forward-compat.
    const handleFrame = (e: MessageEvent) => {
      const decision = decideRunLogFrame({
        event: (e.type === "message" ? "message" : e.type) as string,
        data: typeof e.data === "string" ? e.data : undefined,
      });
      if (decision.kind === "append") append(decision.line);
    };
    es.addEventListener("log", handleFrame as EventListener);
    es.onmessage = handleFrame;

    return () => {
      es.removeEventListener("log", handleFrame as EventListener);
      es.close();
      setConnected(false);
    };
  }, [runId, enabled]);

  return { lines, connected };
}
