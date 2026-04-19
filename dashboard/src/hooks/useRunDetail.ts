import { useQuery } from "@tanstack/react-query";
import type { RunRecord } from "@/types";

/**
 * Raw envelope for `GET /api/runs/:id`. The backend returns a `RunRecord`
 * spread into the top-level object plus a `log: {path, lines, lineCount}`
 * block with the last ~500 lines of tmux.log.
 *
 * The v4 DoneDetail component uses this to render the inline expansion.
 * Diff content, test-results.json, and events.ndjson are currently derived
 * from the embedded fields (`tests` counts, `last_error`, retry_history). A
 * future server-side route can enrich this envelope without breaking the
 * component contract — consumers read from the optional fields below.
 */
export interface RunDetail extends RunRecord {
  id: string;
  log: {
    path: string;
    lines: string[];
    lineCount: number;
  };
  /** Server-populated, future-compat. Unified-diff text for the run's changeset. */
  diff?: string;
  /** Parsed test-results.json, when the backend exposes it. */
  testResults?: Array<{
    name: string;
    status: "passed" | "failed" | "pending" | "skipped";
    duration_ms?: number;
    message?: string;
  }>;
  /** Parsed events.ndjson tool-call sequence, when the backend exposes it. */
  events?: Array<{
    ts: string;
    kind: string;
    tool?: string;
    detail?: string;
  }>;
}

async function fetchRunDetail(runId: string): Promise<RunDetail> {
  if (!runId) throw new Error("runId is required");
  const res = await fetch(`/api/runs/${encodeURIComponent(runId)}`);
  if (!res.ok) {
    let detail = "";
    try {
      detail = await res.text();
    } catch {
      // ignore
    }
    throw new Error(`${res.status} ${res.statusText}: ${detail || runId}`);
  }
  return (await res.json()) as RunDetail;
}

/**
 * Fetches the `/api/runs/:id` envelope lazily. Enabled by default; the
 * caller (DoneDetail) toggles via the `enabled` flag so we only fetch when
 * the parent row is expanded.
 */
export function useRunDetail(runId: string | null, enabled = true) {
  return useQuery<RunDetail>({
    queryKey: ["run-detail", runId],
    queryFn: () => {
      if (!runId) throw new Error("runId is required");
      return fetchRunDetail(runId);
    },
    enabled: enabled && !!runId,
    staleTime: 30_000,
    retry: 1,
  });
}
