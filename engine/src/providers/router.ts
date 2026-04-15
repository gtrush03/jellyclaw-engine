/**
 * Provider router.
 *
 * Implements the `Provider` interface by wrapping a primary provider and an
 * optional secondary. Failover is **pre-stream only** — once the primary has
 * yielded its first chunk, any further error propagates as-is to avoid
 * interleaved / duplicate output downstream.
 *
 * Failover policy (research-notes §4.3, §8):
 *   - 429 and 5xx (500, 502, 503, 504) → failover.
 *   - Network/socket errors (ECONNRESET, ETIMEDOUT, EPIPE, Anthropic-style
 *     `APIConnectionError`) → failover.
 *   - AbortError / ABORT_ERR → never failover, propagate.
 *   - Any other 4xx / generic errors → propagate.
 *
 * This module is intentionally provider-agnostic: it does NOT import the
 * Anthropic or OpenRouter SDKs, and works purely against the `Provider`
 * interface + duck-typed error inspection.
 */

import type { Logger } from "pino";
import type { Provider, ProviderChunk, ProviderRequest } from "./types.js";

export interface ProviderRouterDeps {
  primary: Provider;
  secondary?: Provider;
  logger: Logger;
  clock?: () => number;
}

const RETRYABLE_STATUSES = new Set<number>([429, 500, 502, 503, 504]);
const RETRYABLE_CODES = new Set<string>(["ECONNRESET", "ETIMEDOUT", "EPIPE"]);

function isAbortError(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  const e = err as { name?: unknown; code?: unknown };
  if (e.name === "AbortError") return true;
  if (e.code === "ABORT_ERR") return true;
  return false;
}

export function shouldFailover(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  if (isAbortError(err)) return false;

  const e = err as { status?: unknown; code?: unknown; name?: unknown };

  if (typeof e.status === "number" && RETRYABLE_STATUSES.has(e.status)) {
    return true;
  }

  if (typeof e.code === "string" && RETRYABLE_CODES.has(e.code)) {
    return true;
  }

  // Duck-typed Anthropic-style connection errors (and similar network errors
  // from other SDKs). We intentionally do not import @anthropic-ai/sdk here.
  if (e.name === "APIConnectionError" || e.name === "ConnectionError") {
    return true;
  }

  // Any status present and not in the retryable set → do not failover (4xx).
  if (typeof e.status === "number") return false;

  return false;
}

export class ProviderRouter implements Provider {
  readonly name = "router" as const;

  readonly #primary: Provider;
  readonly #secondary: Provider | undefined;
  readonly #logger: Logger;

  constructor(deps: ProviderRouterDeps) {
    this.#primary = deps.primary;
    this.#secondary = deps.secondary;
    this.#logger = deps.logger;
  }

  async *stream(req: ProviderRequest, signal?: AbortSignal): AsyncIterable<ProviderChunk> {
    if (signal?.aborted) {
      const err = new Error("aborted");
      (err as { name: string }).name = "AbortError";
      throw err;
    }

    let yieldedFromPrimary = false;
    try {
      for await (const chunk of this.#primary.stream(req, signal)) {
        yieldedFromPrimary = true;
        yield chunk;
      }
      return;
    } catch (err) {
      if (yieldedFromPrimary) {
        // Mid-stream — never failover. Would cause interleaved output.
        throw err;
      }
      if (isAbortError(err) || signal?.aborted) {
        throw err;
      }
      if (!shouldFailover(err)) {
        throw err;
      }
      if (this.#secondary === undefined) {
        throw err;
      }

      const reason = describeReason(err);
      this.#logger.warn(
        {
          provider: "router",
          from: this.#primary.name,
          to: this.#secondary.name,
          reason,
        },
        "provider.failover",
      );

      // Failover. Mid-stream errors on the secondary also propagate as-is.
      let yieldedFromSecondary = false;
      try {
        for await (const chunk of this.#secondary.stream(req, signal)) {
          yieldedFromSecondary = true;
          yield chunk;
        }
      } catch (secondaryErr) {
        // Whether pre-stream or mid-stream on the secondary, we do not
        // have a third provider. Rethrow as-is. `yieldedFromSecondary` is
        // kept for potential future telemetry but is intentionally unused
        // in control flow here.
        void yieldedFromSecondary;
        throw secondaryErr;
      }
    }
  }
}

function describeReason(err: unknown): string {
  if (err === null || typeof err !== "object") return "unknown";
  const e = err as { status?: unknown; code?: unknown; name?: unknown };
  if (typeof e.status === "number") return `status_${e.status}`;
  if (typeof e.code === "string") return `code_${e.code}`;
  if (typeof e.name === "string") return `name_${e.name}`;
  return "unknown";
}
