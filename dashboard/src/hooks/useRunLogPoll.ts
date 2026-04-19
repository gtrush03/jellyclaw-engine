import { useEffect, useRef, useState } from "react";

/**
 * 500ms polling hook for live tmux log streaming.
 *
 * Replaces the SSE-based `useRunLog` for the NowCard live terminal view.
 * SSE has too many moving parts (Vite proxy, fetch-event-source quirks,
 * visibility aborts, StrictMode double-invoke); raw polling of
 * `/api/runs/:id` is boring, reliable, and gives the user a real-time feel
 * with negligible cost.
 *
 * Behavior:
 *  - Polls every `intervalMs` ms (default 500) while `enabled && runId`.
 *  - Pulls the latest N lines from the `.log.lines` array returned by
 *    `/api/runs/:id` (backend already tails the last 500 tmux lines).
 *  - Dedupes identical snapshots so React doesn't re-render on a no-op.
 *  - Cancels in-flight fetches when runId flips or the component unmounts.
 *  - No SSE, no EventSource, no abort races.
 */
export function useRunLogPoll(
  runId: string | null,
  enabled: boolean,
  intervalMs = 500,
): { lines: string[]; connected: boolean; lineCount: number } {
  const [lines, setLines] = useState<string[]>([]);
  const [connected, setConnected] = useState(false);
  const [lineCount, setLineCount] = useState(0);
  const lastSig = useRef<string>("");

  useEffect(() => {
    lastSig.current = "";
    setLines([]);
    setConnected(false);
    setLineCount(0);
    if (!enabled || !runId) return;

    let disposed = false;
    const ctrl = new AbortController();

    const tick = async () => {
      if (disposed) return;
      try {
        const res = await fetch(`/api/runs/${encodeURIComponent(runId)}`, {
          signal: ctrl.signal,
          headers: { Accept: "application/json" },
          cache: "no-store",
        });
        if (!res.ok) {
          setConnected(false);
          return;
        }
        const body = (await res.json()) as {
          log?: { lines?: string[]; lineCount?: number };
        };
        const next = Array.isArray(body.log?.lines) ? body.log.lines : [];
        const count = typeof body.log?.lineCount === "number" ? body.log.lineCount : next.length;
        // Cheap dedupe — only re-render if the tail changed.
        const sig = `${count}:${next.length}:${next.at(-1) ?? ""}`;
        if (sig !== lastSig.current) {
          lastSig.current = sig;
          setLines(next);
          setLineCount(count);
        }
        if (!connected) setConnected(true);
      } catch (err) {
        if ((err as { name?: string }).name === "AbortError") return;
        setConnected(false);
      }
    };

    void tick();
    const timer = setInterval(() => {
      void tick();
    }, intervalMs);

    return () => {
      disposed = true;
      ctrl.abort();
      clearInterval(timer);
    };
    // `connected` intentionally excluded — it's derived state only. Re-running
    // the effect on connected-flip would reset the poll loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, enabled, intervalMs]);

  return { lines, connected, lineCount };
}
