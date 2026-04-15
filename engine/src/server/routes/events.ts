/**
 * Phase 10.5 — `GET /v1/events` global SSE stream.
 *
 * Fan-in of every attached run's events. The TUI's
 * {@link engine/src/tui/sdk-adapter.ts#sseIterator} reads this stream to feed
 * the vendored OpenCode TUI. Each frame is `event: "event"` with `data:` set
 * to a JSON-serialised {@link AgentEvent}. A terminal `done` frame is emitted
 * when the client aborts (no natural terminus exists for a global stream —
 * runs come and go — so `done` fires on shutdown / client disconnect only).
 *
 * Events are left in jellyclaw dotted snake shape (`session.started`,
 * `agent.message`, ...); the adapter re-translates via `event-map.ts` if
 * needed. Reusing {@link SSEStreamingApi} keeps the wire identical to the
 * per-run `/v1/runs/:id/events` stream so the TUI's SSE parser stays shared.
 */

import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";

import type { Logger } from "../../logger.js";
import type { AgentEvent } from "../../events.js";
import type { SessionManager } from "../session-manager.js";
import type { AppVariables } from "../types.js";

export interface RegisterEventRoutesDeps {
  readonly sessionManager: SessionManager;
  readonly logger: Logger;
}

export function registerEventRoutes(
  app: Hono<{ Variables: AppVariables }>,
  deps: RegisterEventRoutesDeps,
): void {
  const { sessionManager, logger } = deps;

  app.get("/v1/events", (c) => {
    return streamSSE(
      c,
      async (stream) => {
        let seq = 0;
        const queue: AgentEvent[] = [];
        let resolveWait: (() => void) | null = null;
        let closed = false;

        const unsub = sessionManager.onEvent((ev) => {
          queue.push(ev);
          if (resolveWait) {
            resolveWait();
            resolveWait = null;
          }
        });

        const onAbort = (): void => {
          closed = true;
          if (resolveWait) {
            resolveWait();
            resolveWait = null;
          }
        };
        c.req.raw.signal.addEventListener("abort", onAbort, { once: true });

        try {
          while (!closed) {
            if (queue.length === 0) {
              await new Promise<void>((resolve) => {
                resolveWait = resolve;
              });
              continue;
            }
            const ev = queue.shift();
            if (!ev) continue;
            await stream.writeSSE({
              id: String(seq++),
              event: "event",
              data: JSON.stringify(ev),
            });
          }
          await stream.writeSSE({
            id: "done",
            event: "done",
            data: JSON.stringify({ reason: "client_disconnect" }),
          });
        } finally {
          unsub();
          c.req.raw.signal.removeEventListener("abort", onAbort);
        }
      },
      async (err, stream) => {
        logger.error({ err }, "global SSE stream errored");
        await stream.close();
      },
    );
  });
}
