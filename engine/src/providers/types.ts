/**
 * Shared provider interface. See `engine/provider-research-notes.md`.
 *
 * The provider wrapper yields RAW SDK events (discriminated by `type`),
 * not jellyclaw's `AgentEvent`. The Phase 03 event adapter does the
 * translation. Keeping the boundary this thin means providers don't need
 * to know anything about jellyclaw's semantic layer.
 */

import type Anthropic from "@anthropic-ai/sdk";

export interface CacheControlInput {
  type: "ephemeral";
  ttl?: "5m" | "1h";
}

export interface SystemBlock {
  type: "text";
  text: string;
  cache_control?: CacheControlInput;
}

export interface MemoryContext {
  /** CLAUDE.md contents, if present. Injected as a stable user-turn block. */
  claudeMd?: string;
  /** Top-N most-relevant skills. Concatenated into one stable block. */
  skills?: Array<{ name: string; body: string }>;
}

export interface ProviderRequest {
  model: string;
  maxOutputTokens: number;
  system: SystemBlock[];
  messages: Anthropic.Messages.MessageParam[];
  tools?: Anthropic.Messages.Tool[];
  thinking?: { type: "enabled"; budget_tokens: number };
  memory?: MemoryContext;
}

/**
 * Raw chunk yielded from a provider's stream. Discriminated by `type`.
 * Anthropic chunks match `Anthropic.Messages.RawMessageStreamEvent`
 * shapes; OpenRouter chunks will use the OpenAI-compat shape (lands
 * in Prompt 03).
 */
export interface ProviderChunk {
  readonly type: string;
  readonly [k: string]: unknown;
}

export interface Provider {
  readonly name: "anthropic" | "openrouter" | "router";
  stream(req: ProviderRequest, signal?: AbortSignal): AsyncIterable<ProviderChunk>;
  close?(): Promise<void>;
}
