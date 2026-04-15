/**
 * Phase 99 — jellyclaw HTTP client.
 *
 * Narrow typed wrapper around jellyclaw's HTTP surface:
 *   - `GET  /v1/health`
 *   - `POST /v1/runs`
 *   - `GET  /v1/runs/:id/events`           (SSE)
 *   - `POST /v1/runs/:id/cancel`
 *   - `GET  /v1/sessions`
 *   - `GET  /v1/sessions/:id/replay`       (SSE)
 *
 * Replaces the old OpenCode-shape translator (`sdk-adapter.ts`). Every
 * boundary is zod-validated via `AgentEvent.parse` from `../events.js`.
 *
 * SSE uses `eventsource-parser` for frame decoding. The `events()` iterator
 * reconnects on transient failure with 200/800/3200 ms backoff (≤ 5 retries),
 * passing `Last-Event-Id` so the server can replay from the ring buffer or
 * JSONL. A terminal `event: done` frame stops the iterator cleanly — no
 * reconnect in that case.
 */

import { createParser, type EventSourceMessage } from "eventsource-parser";

import { AgentEvent } from "../events.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SessionMeta {
  readonly id: string;
  readonly createdAt?: number;
  readonly title?: string;
}

export interface HealthResponse {
  readonly ok: boolean;
  readonly version: string;
  readonly uptime_ms?: number;
  readonly active_runs?: number;
}

export interface CreateRunInput {
  readonly prompt: string;
  readonly sessionId?: string;
  readonly cwd?: string;
  readonly systemPrompt?: string;
}

export interface JellyclawClient {
  health(): Promise<HealthResponse>;
  createRun(opts: CreateRunInput): Promise<{ runId: string; sessionId: string }>;
  /**
   * Yields AgentEvents from /v1/runs/:id/events. Automatically reconnects on
   * transient SSE failure with 200/800/3200 ms backoff (≤ 5 retries). Passes
   * the last seen event id via `Last-Event-Id` on reconnect.
   */
  events(runId: string, lastEventId?: string): AsyncIterable<AgentEvent>;
  cancel(runId: string): Promise<void>;
  /**
   * Resolve a pending permission request by POSTing to
   * `/v1/permissions/:id` with `{ granted }`. Used by the Ink TUI's
   * permission modal.
   */
  resolvePermission(requestId: string, granted: boolean): Promise<void>;
  listSessions(): Promise<readonly SessionMeta[]>;
  /**
   * Like `events()` but for a completed session — replays JSONL from disk
   * via the /v1/sessions/:id/replay endpoint.
   */
  resumeSession(sessionId: string): AsyncIterable<AgentEvent>;
}

export interface CreateClientOptions {
  readonly baseUrl: string;
  readonly token: string;
  /** Abort signal that kills ongoing requests + SSE streams. */
  readonly signal?: AbortSignal;
  /** Optional reconnect observer. Called BEFORE each retry. */
  readonly onReconnect?: (attempt: number, delayMs: number) => void;
  /** Injected for tests. Defaults to globalThis.fetch. */
  readonly fetch?: typeof fetch;
  /** Injected for tests — defaults to setTimeout. */
  readonly setTimeout?: (fn: () => void, ms: number) => unknown;
}

export class JellyclawClientError extends Error {
  override readonly name = "JellyclawClientError";
  constructor(
    message: string,
    public readonly status: number | null,
    public readonly body: unknown,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RECONNECT_DELAYS_MS = [200, 800, 3200, 3200, 3200] as const;
const MAX_RECONNECT_ATTEMPTS = RECONNECT_DELAYS_MS.length;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createClient(opts: CreateClientOptions): JellyclawClient {
  const fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const baseUrl = opts.baseUrl.replace(/\/$/, "");
  const outerSignal = opts.signal;
  const onReconnect = opts.onReconnect;
  const scheduleDelay = opts.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));

  function authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${opts.token}` };
  }

  function combineSignals(extra?: AbortSignal): {
    signal: AbortSignal;
    dispose: () => void;
  } {
    const controller = new AbortController();
    const forward = (): void => controller.abort();
    if (outerSignal !== undefined) {
      if (outerSignal.aborted) controller.abort();
      else outerSignal.addEventListener("abort", forward, { once: true });
    }
    if (extra !== undefined) {
      if (extra.aborted) controller.abort();
      else extra.addEventListener("abort", forward, { once: true });
    }
    return {
      signal: controller.signal,
      dispose: (): void => {
        if (outerSignal !== undefined) outerSignal.removeEventListener("abort", forward);
        if (extra !== undefined) extra.removeEventListener("abort", forward);
      },
    };
  }

  async function jsonRequest<T>(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<T> {
    const method = init.method ?? "GET";
    const headers: Record<string, string> = {
      ...authHeaders(),
      Accept: "application/json",
    };
    let body: string | undefined;
    if (init.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(init.body);
    }
    const { signal, dispose } = combineSignals();
    try {
      const res = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
        signal,
      });
      if (!res.ok) {
        const text = await safeText(res);
        throw new JellyclawClientError(
          `jellyclaw HTTP ${res.status} on ${method} ${path}`,
          res.status,
          text,
        );
      }
      const raw = await safeText(res);
      if (raw.length === 0) return undefined as unknown as T;
      return JSON.parse(raw) as T;
    } finally {
      dispose();
    }
  }

  async function* sseEvents(
    path: string,
    initialLastEventId: string | undefined,
    opts2: { allowReconnect: boolean },
  ): AsyncGenerator<AgentEvent> {
    let lastEventId = initialLastEventId;
    let attempt = 0;

    while (true) {
      const { signal, dispose } = combineSignals();
      let streamDone = false;
      let transientError: unknown = null;
      let fatalError: unknown = null;
      try {
        let res: Response;
        try {
          const headers: Record<string, string> = {
            ...authHeaders(),
            Accept: "text/event-stream",
          };
          if (lastEventId !== undefined) headers["Last-Event-Id"] = lastEventId;

          res = await fetchImpl(`${baseUrl}${path}`, {
            method: "GET",
            headers,
            signal,
          });
        } catch (err) {
          // Network-level failure opening the stream — transient.
          transientError = err;
          throw new _InternalReconnect();
        }

        if (!res.ok || res.body === null) {
          const text = await safeText(res).catch(() => "");
          const err = new JellyclawClientError(
            `jellyclaw SSE open failed: ${res.status}`,
            res.status,
            text,
          );
          // 5xx is transient; 4xx/etc is fatal.
          if (opts2.allowReconnect && res.status >= 500) {
            transientError = err;
            throw new _InternalReconnect();
          }
          fatalError = err;
          throw err;
        }

        const pending: Array<AgentEvent | { __done: true }> = [];
        let waiter: (() => void) | null = null;
        const wake = (): void => {
          if (waiter !== null) {
            const w = waiter;
            waiter = null;
            w();
          }
        };

        const parser = createParser({
          onEvent(ev: EventSourceMessage) {
            if (ev.id !== undefined && ev.id !== "done" && ev.id.length > 0) {
              lastEventId = ev.id;
            }
            const name = ev.event ?? "message";
            if (name === "done") {
              pending.push({ __done: true });
              wake();
              return;
            }
            if (name !== "event") {
              return;
            }
            try {
              const parsed = AgentEvent.parse(JSON.parse(ev.data));
              pending.push(parsed);
              wake();
            } catch {
              // Skip malformed frames — the server is the source of truth,
              // but a single bad frame shouldn't kill the stream.
            }
          },
        });

        // Pump reader in the background; yield from `pending` in order.
        const reader = res.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let readerDone = false;
        let readerError: unknown = null;

        const pump = (async (): Promise<void> => {
          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) {
                readerDone = true;
                wake();
                return;
              }
              parser.feed(decoder.decode(value, { stream: true }));
              wake();
            }
          } catch (err) {
            readerError = err;
            readerDone = true;
            wake();
          }
        })();

        try {
          while (true) {
            if (pending.length === 0) {
              if (readerDone) break;
              await new Promise<void>((resolve) => {
                waiter = resolve;
              });
              continue;
            }
            const next = pending.shift();
            if (next === undefined) continue;
            if ("__done" in next) {
              streamDone = true;
              break;
            }
            yield next;
          }
        } finally {
          try {
            await reader.cancel();
          } catch {
            /* reader already closed */
          }
          await pump.catch(() => undefined);
        }

        if (streamDone) return;
        // Either the reader errored or the stream ended without `done`.
        // Both are transient — fall through to reconnect logic.
        if (readerError !== null) {
          transientError = readerError;
          throw new _InternalReconnect();
        }
        // Stream closed cleanly without a `done` frame — still treat as
        // transient so the server can replay via Last-Event-Id.
        transientError = new Error("SSE stream ended without done frame");
        throw new _InternalReconnect();
      } catch (err) {
        if (err instanceof _InternalReconnect) {
          // fall through to reconnect logic below
        } else {
          fatalError = err;
          throw err;
        }
      } finally {
        dispose();
      }

      // Reconnect logic --------------------------------------------------
      if (fatalError !== null) return; // unreachable — throw already left us
      if (!opts2.allowReconnect) return;
      if (outerSignal?.aborted) return;
      if (attempt >= MAX_RECONNECT_ATTEMPTS) {
        throw new JellyclawClientError(
          `jellyclaw SSE exceeded ${MAX_RECONNECT_ATTEMPTS} reconnect attempts`,
          null,
          null,
        );
      }
      const delayMs = RECONNECT_DELAYS_MS[attempt] ?? 3200;
      attempt += 1;
      if (onReconnect !== undefined) onReconnect(attempt, delayMs);
      await new Promise<void>((resolve) => {
        scheduleDelay(resolve, delayMs);
      });
      void transientError; // retained for future telemetry
    }
  }

  // Sentinel thrown inside `sseEvents` to trigger the reconnect branch
  // without crossing a real async boundary. Never surfaced to callers.
  class _InternalReconnect extends Error {
    override readonly name = "_InternalReconnect";
  }

  return {
    health: () => jsonRequest<HealthResponse>("/v1/health"),
    createRun: (input) => {
      const body: Record<string, unknown> = { prompt: input.prompt };
      if (input.sessionId !== undefined) body.sessionId = input.sessionId;
      if (input.cwd !== undefined) body.cwd = input.cwd;
      if (input.systemPrompt !== undefined) body.appendSystemPrompt = input.systemPrompt;
      return jsonRequest<{ runId: string; sessionId: string }>("/v1/runs", {
        method: "POST",
        body,
      });
    },
    events: (runId, lastEventId) =>
      sseEvents(`/v1/runs/${encodeURIComponent(runId)}/events`, lastEventId, {
        allowReconnect: true,
      }),
    cancel: async (runId) => {
      await jsonRequest<unknown>(`/v1/runs/${encodeURIComponent(runId)}/cancel`, {
        method: "POST",
      });
    },
    resolvePermission: async (requestId, granted) => {
      await jsonRequest<unknown>(`/v1/permissions/${encodeURIComponent(requestId)}`, {
        method: "POST",
        body: { granted },
      });
    },
    listSessions: async () => {
      const raw = await jsonRequest<readonly Record<string, unknown>[]>("/v1/sessions");
      return raw.map((s) => {
        const id = typeof s.id === "string" ? s.id : "";
        const out: { id: string; createdAt?: number; title?: string } = { id };
        if (typeof s.createdAt === "number") out.createdAt = s.createdAt;
        if (typeof s.title === "string") out.title = s.title;
        return out;
      });
    },
    resumeSession: (sessionId) =>
      sseEvents(`/v1/sessions/${encodeURIComponent(sessionId)}/replay`, undefined, {
        allowReconnect: false,
      }),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}
