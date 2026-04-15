/**
 * Anthropic direct provider.
 *
 * Status: SKELETON — Phase 2 lands the full implementation.
 *
 * Why Anthropic direct is the recommended primary provider:
 *
 *   - `cache_control: { type: "ephemeral" }` blocks give us prompt caching with
 *     up to 4 breakpoints per request. Correctly placed, cache hits cut input
 *     tokens by 90 % on long sessions.
 *   - Extended thinking is natively supported.
 *   - Tool use streaming emits structured input_json_delta blocks we can map to
 *     AgentEvent.tool.called without regex parsing.
 *
 * Cache breakpoint strategy (auto mode):
 *
 *   1. After the system prompt (stable across session)
 *   2. After the tools array (stable across session)
 *   3. After the most-recent assistant turn (stable across next user turn)
 *   4. Reserved — hooks/agents may place their own when they inject content
 *
 * All four breakpoints are marked `cache_control: { type: "ephemeral" }`.
 * When `manual` mode is selected via config, the caller is responsible.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { AnthropicProviderConfig } from "../config.js";
import type { AgentEvent } from "../events.js";
import type { Logger } from "../logger.js";

export interface AnthropicProviderDeps {
  config: AnthropicProviderConfig;
  logger: Logger;
  /** Injected for tests. Production code passes a real Anthropic SDK client. */
  client?: Anthropic;
}

export interface StreamRequest {
  model: string;
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  tools: unknown[];
  maxTokens: number;
}

export class AnthropicProvider {
  readonly name = "anthropic" as const;

  constructor(private readonly deps: AnthropicProviderDeps) {}

  /**
   * Resolve the effective API key: explicit config → ANTHROPIC_API_KEY env.
   * Throws if neither is present.
   */
  apiKey(): string {
    const fromConfig = this.deps.config.apiKey;
    const fromEnv = process.env.ANTHROPIC_API_KEY;
    const key = fromConfig ?? fromEnv;
    if (!key) {
      throw new Error(
        "Anthropic provider: no API key found. Set ANTHROPIC_API_KEY or provider.apiKey.",
      );
    }
    return key;
  }

  /**
   * Compute cache_control breakpoints for a request payload.
   * Returns an array of (block index, block kind) pairs where cache_control should be
   * applied. `auto` mode is implemented here; `manual` returns [].
   */
  computeCacheBreakpoints(req: StreamRequest): ReadonlyArray<{
    index: number;
    kind: "system" | "tools" | "last_assistant";
  }> {
    if (this.deps.config.cache.enabled === false) return [];
    if (this.deps.config.cache.breakpoints === "manual") return [];

    const breakpoints: Array<{
      index: number;
      kind: "system" | "tools" | "last_assistant";
    }> = [];

    // 1. System prompt — always a breakpoint when non-empty
    if (req.system.length > 0) breakpoints.push({ index: 0, kind: "system" });

    // 2. Tools — always a breakpoint when non-empty
    if (req.tools.length > 0) breakpoints.push({ index: 0, kind: "tools" });

    // 3. Last assistant turn — if one exists
    const lastAssistantIdx = findLastIndex(req.messages, (m) => m.role === "assistant");
    if (lastAssistantIdx >= 0) {
      breakpoints.push({ index: lastAssistantIdx, kind: "last_assistant" });
    }

    // Anthropic API caps at 4 breakpoints. We never exceed 3 in auto mode.
    return breakpoints;
  }

  /**
   * Stream a completion. Phase 2 wires this to the real SDK.
   */
  // biome-ignore lint/suspicious/useAwait: stub
  // biome-ignore lint/correctness/useYield: stub
  async *stream(_req: StreamRequest): AsyncGenerator<AgentEvent, void, void> {
    this.deps.logger.warn(
      { provider: "anthropic" },
      "AnthropicProvider.stream called in Phase 0 — not implemented",
    );
    throw new Error("AnthropicProvider.stream not yet implemented (lands Phase 2)");
  }
}

function findLastIndex<T>(arr: readonly T[], pred: (x: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    const item = arr[i];
    if (item !== undefined && pred(item)) return i;
  }
  return -1;
}
