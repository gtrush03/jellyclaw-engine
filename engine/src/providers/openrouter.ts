/**
 * OpenRouter provider.
 *
 * Status: SKELETON — Phase 2 lands the full implementation.
 *
 * CAVEAT EMPTOR — caching limitations.
 *
 * OpenRouter routes Anthropic traffic through their own proxy. As of this writing the
 * following Anthropic-native features either degrade or do not work at all through
 * OpenRouter:
 *
 *   1. prompt caching (`cache_control`) — partial support. The marker is forwarded to
 *      the upstream Anthropic API only on the `anthropic/*` route, and only when the
 *      user's OpenRouter org has the caching feature flagged on. Third-party routes
 *      strip it silently.
 *   2. extended thinking — supported on `anthropic/*` routes only; dropped elsewhere.
 *   3. fine-grained usage reporting — OpenRouter reports aggregated tokens, without the
 *      `cache_read_input_tokens` / `cache_creation_input_tokens` split, so our
 *      `UsageUpdatedEvent` will have `cache_*_tokens: 0` even when caching fired.
 *   4. tool_use input streaming — streams as chunked JSON strings rather than
 *      `input_json_delta`, so the event mapper needs a different code path.
 *
 * Because of 1–4 we require the user to set
 *
 *     provider.acknowledgeCachingLimits: true
 *
 * in `jellyclaw.json` before we will instantiate this provider. This is a deliberately
 * annoying speed bump — Anthropic direct is a better default for almost every workload.
 */

import type { OpenRouterProviderConfig } from "../config.js";
import type { AgentEvent } from "../events.js";
import type { Logger } from "../logger.js";

export interface OpenRouterProviderDeps {
  config: OpenRouterProviderConfig;
  logger: Logger;
}

export interface StreamRequest {
  model: string;
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  tools: unknown[];
  maxTokens: number;
}

export class OpenRouterProvider {
  readonly name = "openrouter" as const;

  constructor(private readonly deps: OpenRouterProviderDeps) {
    if (deps.config.acknowledgeCachingLimits !== true) {
      throw new Error(
        "OpenRouter provider requires `provider.acknowledgeCachingLimits: true` in config. " +
          "See engine/src/providers/openrouter.ts for why.",
      );
    }
    deps.logger.warn(
      { provider: "openrouter", model: deps.config.defaultModel },
      "OpenRouter provider active — prompt caching and usage fidelity degraded vs Anthropic direct",
    );
  }

  apiKey(): string {
    const fromConfig = this.deps.config.apiKey;
    const fromEnv = process.env.OPENROUTER_API_KEY;
    const key = fromConfig ?? fromEnv;
    if (!key) {
      throw new Error(
        "OpenRouter provider: no API key found. Set OPENROUTER_API_KEY or provider.apiKey.",
      );
    }
    return key;
  }

  /**
   * Whether the given model string is a native Anthropic route (which means at least
   * partial feature parity with Anthropic direct).
   */
  isAnthropicRoute(model: string): boolean {
    return model.startsWith("anthropic/");
  }

  // biome-ignore lint/suspicious/useAwait: stub
  // biome-ignore lint/correctness/useYield: stub
  async *stream(_req: StreamRequest): AsyncGenerator<AgentEvent, void, void> {
    this.deps.logger.warn(
      { provider: "openrouter" },
      "OpenRouterProvider.stream called in Phase 0 — not implemented",
    );
    throw new Error("OpenRouterProvider.stream not yet implemented (lands Phase 2)");
  }
}
