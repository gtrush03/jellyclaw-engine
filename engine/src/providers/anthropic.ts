/**
 * Anthropic-direct provider.
 *
 * Implements `Provider` (see `types.ts`). Wraps `@anthropic-ai/sdk` and:
 *   - Applies cache_control breakpoints via `planBreakpoints` (research-notes §3).
 *   - Sets the `anthropic-beta: extended-cache-ttl-2025-04-11` header when any
 *     breakpoint uses ttl=1h (research-notes §3.3).
 *   - Wraps the stream call in OUR retry loop (research-notes §4.3) — the SDK's
 *     built-in retry is disabled via `maxRetries: 0` because it hides state
 *     the router needs (failure count, elapsed time, last error body).
 *   - Pipes raw `RawMessageStreamEvent` values through unchanged. The Phase 03
 *     event adapter translates to jellyclaw's semantic `AgentEvent`.
 *
 * NEVER logs API keys. NEVER uses `new Date()` — tests inject a clock.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { Logger } from "pino";
import {
  type BreakpointOptions,
  defaultBreakpointOptions,
  planBreakpoints,
} from "./cache-breakpoints.js";
import type { Provider, ProviderChunk, ProviderRequest } from "./types.js";

/**
 * Beta header required for `cache_control.ttl = "1h"` on the Messages API.
 * Verified current as of 2026-04-15 (research-notes §3.3 Appendix B).
 * Do not change without re-verification.
 */
export const BETA_EXTENDED_CACHE_TTL = "extended-cache-ttl-2025-04-11";

/**
 * Beta header required to unlock 1M-token context window on Claude Opus 4.6
 * (and Sonnet 4.6). Applied automatically when `model` starts with
 * `claude-opus-4-6` or `claude-sonnet-4-6`.
 */
export const BETA_CONTEXT_1M = "context-1m-2025-08-07";

export interface AnthropicProviderDeps {
  apiKey: string;
  baseURL?: string;
  logger: Logger;
  cache?: BreakpointOptions;
  /** Injected for tests (no `new Date()` in domain code). */
  clock?: () => number;
  /** Injected for tests — lets us supply a stubbed Anthropic client. */
  client?: Anthropic;
  /** Retry budget overrides (tests lower these to keep vitest fast). */
  retry?: Partial<RetryPolicy>;
}

export interface RetryPolicy {
  /** Max attempts INCLUDING the initial attempt. Default 3. */
  maxAttempts: number;
  /** Total wall-time budget in ms across all attempts. Default 30_000. */
  budgetMs: number;
  /** Base backoff in ms. Default 500. */
  baseMs: number;
  /** Backoff cap in ms. Default 8_000. */
  capMs: number;
}

const defaultRetry: RetryPolicy = {
  maxAttempts: 3,
  budgetMs: 30_000,
  baseMs: 500,
  capMs: 8_000,
};

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const NON_RETRYABLE_STATUS = new Set([400, 401, 403, 404, 413, 422]);

function isRetryable(err: unknown): boolean {
  if (err instanceof Anthropic.APIError) {
    if (NON_RETRYABLE_STATUS.has(err.status ?? 0)) return false;
    if (RETRYABLE_STATUS.has(err.status ?? 0)) return true;
    if (err instanceof Anthropic.APIConnectionError) return true;
    return false;
  }
  const code = (err as { code?: string })?.code;
  if (code === "ECONNRESET" || code === "ETIMEDOUT" || code === "EPIPE") return true;
  return false;
}

function parseRetryAfter(err: unknown): number | undefined {
  if (!(err instanceof Anthropic.APIError)) return undefined;
  const raw =
    (err.headers as Record<string, string | undefined> | undefined)?.["retry-after"] ??
    (err.headers as Record<string, string | undefined> | undefined)?.["Retry-After"];
  if (!raw) return undefined;
  const secs = Number.parseInt(raw, 10);
  if (!Number.isFinite(secs) || secs < 0) return undefined;
  return secs * 1000;
}

function jitteredBackoff(attempt: number, policy: RetryPolicy): number {
  const exp = Math.min(policy.capMs, policy.baseMs * 2 ** attempt);
  return Math.floor(Math.random() * exp);
}

const delay = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((res, rej) => {
    if (signal?.aborted) {
      rej(signal.reason ?? new Error("aborted"));
      return;
    }
    const t = setTimeout(res, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        rej(signal.reason ?? new Error("aborted"));
      },
      { once: true },
    );
  });

export class AnthropicProvider implements Provider {
  readonly name = "anthropic" as const;

  private readonly client: Anthropic;
  private readonly logger: Logger;
  private readonly cache: BreakpointOptions;
  private readonly clock: () => number;
  private readonly retry: RetryPolicy;

  constructor(deps: AnthropicProviderDeps) {
    this.client =
      deps.client ??
      new Anthropic({
        apiKey: deps.apiKey,
        ...(deps.baseURL !== undefined ? { baseURL: deps.baseURL } : {}),
        maxRetries: 0, // our retry loop owns this — see header comment
      });
    this.logger = deps.logger;
    this.cache = deps.cache ?? defaultBreakpointOptions;
    this.clock = deps.clock ?? ((): number => Date.now());
    this.retry = { ...defaultRetry, ...(deps.retry ?? {}) };
  }

  async *stream(req: ProviderRequest, signal?: AbortSignal): AsyncIterable<ProviderChunk> {
    const planned = planBreakpoints(req, this.cache);

    const body: Anthropic.Messages.MessageStreamParams = {
      model: req.model,
      max_tokens: req.maxOutputTokens,
      ...(planned.system.length > 0
        ? { system: planned.system as unknown as Anthropic.Messages.TextBlockParam[] }
        : {}),
      messages: planned.messages,
      ...(planned.tools ? { tools: planned.tools } : {}),
      ...(req.thinking ? { thinking: req.thinking } : {}),
    };

    const baseHeaders: Record<string, string> = {};
    const betas: string[] = [];
    if (planned.hasOneHourBreakpoint) betas.push(BETA_EXTENDED_CACHE_TTL);
    if (req.model.startsWith("claude-opus-4-6") || req.model.startsWith("claude-sonnet-4-6")) {
      betas.push(BETA_CONTEXT_1M);
    }
    if (betas.length > 0) baseHeaders["anthropic-beta"] = betas.join(",");

    const t0 = this.clock();
    let attempt = 0;
    let lastErr: unknown;

    while (attempt < this.retry.maxAttempts) {
      if (signal?.aborted) throw signal.reason ?? new Error("aborted");
      const elapsed = this.clock() - t0;
      if (elapsed >= this.retry.budgetMs) {
        throw lastErr ?? new Error("retry budget exhausted before first attempt");
      }

      try {
        const opts: { headers?: Record<string, string>; signal?: AbortSignal } = {};
        if (Object.keys(baseHeaders).length > 0) opts.headers = baseHeaders;
        if (signal) opts.signal = signal;

        const stream = this.client.messages.stream(body, opts);

        this.logger.debug(
          {
            provider: "anthropic",
            model: req.model,
            attempt: attempt + 1,
            plan: planned.plan,
            beta: baseHeaders["anthropic-beta"],
          },
          "anthropic.stream.begin",
        );

        for await (const event of stream) {
          // Raw event passthrough. The Phase 03 adapter handles semantic
          // translation; here we stay at the SDK wire layer.
          yield event as unknown as ProviderChunk;
        }
        return;
      } catch (err) {
        lastErr = err;
        if (signal?.aborted) throw err;
        if (!isRetryable(err)) {
          this.logger.warn(
            { provider: "anthropic", status: (err as { status?: number })?.status },
            "anthropic.stream.fatal",
          );
          throw err;
        }

        attempt++;
        if (attempt >= this.retry.maxAttempts) {
          this.logger.warn(
            { provider: "anthropic", attempts: attempt },
            "anthropic.stream.retries_exhausted",
          );
          throw err;
        }

        const remaining = this.retry.budgetMs - (this.clock() - t0);
        const retryAfter = parseRetryAfter(err);
        if (retryAfter !== undefined && retryAfter > remaining) {
          this.logger.warn(
            { provider: "anthropic", retryAfter, remaining },
            "anthropic.stream.retry_after_exceeds_budget",
          );
          throw err;
        }
        const wait = Math.max(
          0,
          Math.min(remaining, retryAfter ?? jitteredBackoff(attempt, this.retry)),
        );

        this.logger.info(
          {
            provider: "anthropic",
            attempt,
            wait_ms: wait,
            status: (err as { status?: number })?.status,
          },
          "anthropic.stream.retry",
        );
        await delay(wait, signal);
      }
    }

    throw lastErr ?? new Error("exhausted retries");
  }
}
