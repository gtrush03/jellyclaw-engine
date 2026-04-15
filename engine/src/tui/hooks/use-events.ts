/**
 * Phase 99-06 — `useEvents` React hook.
 *
 * Subscribes to `client.events(runId)` while `runId` is non-null and forwards
 * each yielded `AgentEvent` to `onEvent`. Cancels the for-await loop on unmount
 * or when `runId` changes via a closure-owned `cancelled` flag.
 *
 * The reducer consumer pattern is:
 *
 *   const [state, dispatch] = useReducer(reduce, createInitialState());
 *   useEvents({ client, runId, onEvent: dispatch });
 *
 * `onEvent` throws are swallowed so a buggy reducer can't terminate the
 * stream silently. Iterator throws bubble to `onError` if provided.
 */

import { useEffect } from "react";

import type { AgentEvent } from "../../events.js";
import type { JellyclawClient } from "../client.js";

export interface UseEventsOptions {
  readonly client: JellyclawClient;
  readonly runId: string | null;
  readonly onEvent?: (event: AgentEvent) => void;
  readonly onError?: (err: unknown) => void;
}

/** Subscribes on mount when runId is non-null; cancels on unmount / runId change. */
export function useEvents(opts: UseEventsOptions): void {
  const { client, runId, onEvent, onError } = opts;

  useEffect(() => {
    if (runId === null) return;

    let cancelled = false;

    const run = async (): Promise<void> => {
      try {
        for await (const ev of client.events(runId)) {
          if (cancelled) break;
          if (onEvent !== undefined) {
            try {
              onEvent(ev);
            } catch {
              // Swallow consumer errors so the SSE pump stays alive.
            }
          }
        }
      } catch (err) {
        if (cancelled) return;
        if (onError !== undefined) {
          try {
            onError(err);
          } catch {
            // Swallow secondary errors from the error handler itself.
          }
        }
      }
    };

    void run();

    return (): void => {
      cancelled = true;
    };
  }, [client, runId, onEvent, onError]);
}
