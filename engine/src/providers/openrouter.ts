/**
 * OpenRouter provider.
 *
 * Implements `Provider` (see `types.ts`). POSTs to OR's OpenAI-compatible
 * `/chat/completions` endpoint with `stream: true`, hand-rolls the SSE
 * parser, and translates OpenAI-compat chunks into events shaped like the
 * Anthropic `RawMessageStreamEvent` set so the Phase 03 event adapter can
 * stay provider-agnostic.
 *
 * Key invariants (see `engine/provider-research-notes.md` §5-§8):
 *   - Strip EVERY `cache_control` field from the outbound body recursively
 *     (research-notes §7.3). Issue #1245 drops them silently; #17910 throws
 *     HTTP 400 when OAuth-auth is used.
 *   - Warn EXACTLY ONCE per process when routing an `anthropic/*` model.
 *   - Mirror the Anthropic retry policy (3 attempts, 30s budget, jittered
 *     backoff, honor `Retry-After`, same non-retryable status set plus 402).
 *   - Pre-stream failures may retry; mid-stream failures (after any chunk
 *     yielded) rethrow to avoid interleaved output.
 *
 * NEVER logs API keys. NEVER uses `new Date()` — tests inject a clock.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { Logger } from "pino";
import type { Provider, ProviderChunk, ProviderRequest } from "./types.js";

export interface OpenRouterProviderDeps {
  apiKey: string;
  baseURL?: string;
  referer?: string;
  title?: string;
  logger: Logger;
  /** Injected for tests (no `new Date()` in domain code). */
  clock?: () => number;
  /** Injected for tests — lets us supply a stubbed fetch. */
  fetchImpl?: typeof fetch;
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

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_REFERER = "https://github.com/gtrush03/jellyclaw-engine";
const DEFAULT_TITLE = "jellyclaw";

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const NON_RETRYABLE_STATUS = new Set([400, 401, 402, 403, 404, 413, 422]);

/**
 * Module-level flag so the Anthropic-via-OR warning fires exactly once per
 * process regardless of how many OpenRouterProvider instances are created.
 * Exported reset helper exists solely for tests.
 */
let warned = false;

export function __resetOpenRouterWarningForTests(): void {
  warned = false;
}

/** HTTP error carrying status + body so the retry loop can classify it. */
class OpenRouterHTTPError extends Error {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: string;
  constructor(status: number, headers: Record<string, string>, body: string) {
    super(`OpenRouter HTTP ${status}: ${body.slice(0, 200)}`);
    this.name = "OpenRouterHTTPError";
    this.status = status;
    this.headers = headers;
    this.body = body;
  }
}

function isRetryable(err: unknown): boolean {
  if (err instanceof OpenRouterHTTPError) {
    if (NON_RETRYABLE_STATUS.has(err.status)) return false;
    if (RETRYABLE_STATUS.has(err.status)) return true;
    return false;
  }
  const code = (err as { code?: string })?.code;
  if (code === "ECONNRESET" || code === "ETIMEDOUT" || code === "EPIPE") return true;
  // Node fetch wraps network failures in TypeError with a `cause` that carries
  // the code; a bare TypeError from fetch means network trouble — retry.
  if (err instanceof TypeError) return true;
  return false;
}

function parseRetryAfter(err: unknown): number | undefined {
  if (!(err instanceof OpenRouterHTTPError)) return undefined;
  const raw = err.headers["retry-after"] ?? err.headers["Retry-After"];
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

/**
 * Walk a JSON-shaped value and strip every `cache_control` key we find.
 * Non-destructive — returns a new tree.
 */
function stripCacheControl(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripCacheControl);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "cache_control") continue;
      out[k] = stripCacheControl(v);
    }
    return out;
  }
  return value;
}

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}

interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: unknown;
  };
}

interface OpenRouterRequestBody {
  model: string;
  max_tokens: number;
  stream: true;
  messages: OpenAIMessage[];
  tools?: OpenAITool[];
}

type AnthContent =
  | string
  | Array<
      | { type: "text"; text: string }
      | { type: "tool_use"; id: string; name: string; input: unknown }
      | { type: "tool_result"; tool_use_id: string; content: unknown }
      | { type: string; [k: string]: unknown }
    >;

function textFromContent(content: AnthContent): {
  text: string;
  toolUses: Array<{ id: string; name: string; input: unknown }>;
} {
  if (typeof content === "string") return { text: content, toolUses: [] };
  let text = "";
  const toolUses: Array<{ id: string; name: string; input: unknown }> = [];
  for (const block of content) {
    if (block.type === "text" && typeof (block as { text?: unknown }).text === "string") {
      text += (block as { text: string }).text;
    } else if (block.type === "tool_use") {
      toolUses.push({
        id: (block as { id: string }).id,
        name: (block as { name: string }).name,
        input: (block as { input: unknown }).input,
      });
    }
  }
  return { text, toolUses };
}

function toolResultToString(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    let acc = "";
    for (const part of content) {
      if (
        part !== null &&
        typeof part === "object" &&
        (part as { type?: string }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string"
      ) {
        acc += (part as { text: string }).text;
      }
    }
    if (acc) return acc;
  }
  return JSON.stringify(content);
}

function translateMessages(req: ProviderRequest): {
  messages: OpenAIMessage[];
  tools?: OpenAITool[];
} {
  const messages: OpenAIMessage[] = [];

  // System blocks → one system message per block (text concatenated if that
  // block is itself multi-text, which in our schema it isn't, but cheap).
  for (const sys of req.system) {
    messages.push({ role: "system", content: sys.text });
  }

  for (const msg of req.messages) {
    const content = msg.content as unknown as AnthContent;

    if (msg.role === "assistant") {
      const { text, toolUses } = textFromContent(content);
      if (toolUses.length > 0) {
        messages.push({
          role: "assistant",
          content: text.length > 0 ? text : null,
          tool_calls: toolUses.map((tu) => ({
            id: tu.id,
            type: "function",
            function: { name: tu.name, arguments: JSON.stringify(tu.input ?? {}) },
          })),
        });
      } else {
        messages.push({ role: "assistant", content: text });
      }
      continue;
    }

    // role === "user"
    if (typeof content === "string") {
      messages.push({ role: "user", content });
      continue;
    }

    // Walk the user content array: tool_results become separate `tool`
    // messages; remaining text blocks coalesce into a single user message.
    let userText = "";
    for (const block of content) {
      if (block.type === "tool_result") {
        const str = toolResultToString((block as { content: unknown }).content);
        messages.push({
          role: "tool",
          tool_call_id: (block as { tool_use_id: string }).tool_use_id,
          content: str,
        });
      } else if (block.type === "text" && typeof (block as { text?: unknown }).text === "string") {
        userText += (block as { text: string }).text;
      }
    }
    if (userText.length > 0) {
      messages.push({ role: "user", content: userText });
    }
  }

  let tools: OpenAITool[] | undefined;
  if (req.tools && req.tools.length > 0) {
    tools = req.tools.map((t: Anthropic.Messages.Tool): OpenAITool => {
      const fn: OpenAITool["function"] = {
        name: t.name,
        parameters: t.input_schema,
      };
      if (typeof t.description === "string") fn.description = t.description;
      return { type: "function", function: fn };
    });
  }

  const result: { messages: OpenAIMessage[]; tools?: OpenAITool[] } = { messages };
  if (tools) result.tools = tools;
  return result;
}

function mapFinishReason(fr: string | null | undefined): string {
  switch (fr) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool_calls":
      return "tool_use";
    case "content_filter":
      return "refusal";
    default:
      return fr ?? "end_turn";
  }
}

interface OAChunk {
  choices?: Array<{
    index?: number;
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  error?: unknown;
}

export class OpenRouterProvider implements Provider {
  readonly name = "openrouter" as const;

  private readonly apiKey: string;
  private readonly baseURL: string;
  private readonly referer: string;
  private readonly title: string;
  private readonly logger: Logger;
  private readonly clock: () => number;
  private readonly fetchImpl: typeof fetch;
  private readonly retry: RetryPolicy;

  constructor(deps: OpenRouterProviderDeps) {
    this.apiKey = deps.apiKey;
    this.baseURL = deps.baseURL ?? DEFAULT_BASE_URL;
    this.referer = deps.referer ?? DEFAULT_REFERER;
    this.title = deps.title ?? DEFAULT_TITLE;
    this.logger = deps.logger;
    this.clock = deps.clock ?? ((): number => Date.now());
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.retry = { ...defaultRetry, ...(deps.retry ?? {}) };
  }

  async *stream(req: ProviderRequest, signal?: AbortSignal): AsyncIterable<ProviderChunk> {
    if (signal?.aborted) throw signal.reason ?? new Error("aborted");

    // Warning — anthropic/* model on the OR path. Fire before the first
    // attempt so tests observe it even if the HTTP call fails.
    if (!warned && req.model.startsWith("anthropic/")) {
      this.logger.warn(
        { provider: "openrouter", model: req.model },
        "[jellyclaw] OpenRouter provider active with an Anthropic model. Prompt caching is currently broken on this route (upstream issues #1245, #17910). Expect 4-10× higher token cost. Use --provider anthropic for full caching.",
      );
      warned = true;
    }

    const { messages, tools } = translateMessages(req);

    const rawBody: OpenRouterRequestBody = {
      model: req.model,
      max_tokens: req.maxOutputTokens,
      stream: true,
      messages,
      ...(tools ? { tools } : {}),
    };

    // Strip cache_control unconditionally (research-notes §7.3).
    const body = stripCacheControl(rawBody) as OpenRouterRequestBody;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "HTTP-Referer": this.referer,
      "X-Title": this.title,
    };

    const url = `${this.baseURL.replace(/\/+$/, "")}/chat/completions`;
    const t0 = this.clock();
    let attempt = 0;
    let lastErr: unknown;

    while (attempt < this.retry.maxAttempts) {
      if (signal?.aborted) throw signal.reason ?? new Error("aborted");
      const elapsed = this.clock() - t0;
      if (elapsed >= this.retry.budgetMs) {
        throw lastErr ?? new Error("retry budget exhausted before first attempt");
      }

      let hasYielded = false;
      try {
        this.logger.debug(
          { provider: "openrouter", model: req.model, attempt: attempt + 1 },
          "openrouter.stream.begin",
        );

        const init: RequestInit = {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        };
        if (signal) init.signal = signal;

        const res = await this.fetchImpl(url, init);

        if (!res.ok) {
          const text = await res.text().catch(() => "");
          const hdrs: Record<string, string> = {};
          res.headers.forEach((v, k) => {
            hdrs[k.toLowerCase()] = v;
          });
          throw new OpenRouterHTTPError(res.status, hdrs, text);
        }

        if (!res.body) {
          throw new Error("openrouter: response had no body");
        }

        // Iterate SSE frames.
        for await (const chunk of parseSSE(res.body as ReadableStream<Uint8Array>, signal)) {
          if (chunk === "[DONE]") return;

          let parsed: OAChunk;
          try {
            parsed = JSON.parse(chunk) as OAChunk;
          } catch {
            // Malformed chunk — skip it; upstream rarely emits these but
            // we do not want to kill the stream for a single bad frame.
            continue;
          }

          for (const ev of this.translateChunk(parsed, hasYielded)) {
            hasYielded = true;
            yield ev;
          }
        }
        return;
      } catch (err) {
        lastErr = err;
        if (signal?.aborted) throw err;

        // Mid-stream failures: rethrow, no retry (avoid duplicate output).
        if (hasYielded) {
          this.logger.warn({ provider: "openrouter" }, "openrouter.stream.mid_stream_error");
          throw err;
        }

        if (!isRetryable(err)) {
          this.logger.warn(
            { provider: "openrouter", status: (err as { status?: number })?.status },
            "openrouter.stream.fatal",
          );
          throw err;
        }

        attempt++;
        if (attempt >= this.retry.maxAttempts) {
          this.logger.warn(
            { provider: "openrouter", attempts: attempt },
            "openrouter.stream.retries_exhausted",
          );
          throw err;
        }

        const remaining = this.retry.budgetMs - (this.clock() - t0);
        const retryAfter = parseRetryAfter(err);
        if (retryAfter !== undefined && retryAfter > remaining) {
          this.logger.warn(
            { provider: "openrouter", retryAfter, remaining },
            "openrouter.stream.retry_after_exceeds_budget",
          );
          throw err;
        }
        const wait = Math.max(
          0,
          Math.min(remaining, retryAfter ?? jitteredBackoff(attempt, this.retry)),
        );

        this.logger.info(
          {
            provider: "openrouter",
            attempt,
            wait_ms: wait,
            status: (err as { status?: number })?.status,
          },
          "openrouter.stream.retry",
        );
        await delay(wait, signal);
      }
    }

    throw lastErr ?? new Error("exhausted retries");
  }

  /**
   * Translate one OpenAI chat.completion.chunk into a sequence of
   * Anthropic-shaped ProviderChunks. Stateful wrt `hasYielded` — on the
   * first call, prepend a synthetic `message_start`.
   */
  private *translateChunk(chunk: OAChunk, hasYielded: boolean): IterableIterator<ProviderChunk> {
    if (!hasYielded) {
      yield {
        type: "message_start",
        message: {
          id: "msg_openrouter",
          type: "message",
          role: "assistant",
          content: [],
          model: "",
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      };
    }

    const choice = chunk.choices?.[0];
    if (!choice) return;

    const delta = choice.delta;
    if (delta) {
      if (typeof delta.content === "string" && delta.content.length > 0) {
        yield {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: delta.content },
        };
      }

      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          // Use delta-provided index if present; block index is tc.index+1
          // so index 0 stays reserved for the assistant text block (mirrors
          // Anthropic's layout when tool_use follows text).
          const tcIndex = typeof tc.index === "number" ? tc.index : 0;
          const blockIndex = tcIndex + 1;

          if (tc.id && tc.function?.name) {
            yield {
              type: "content_block_start",
              index: blockIndex,
              content_block: {
                type: "tool_use",
                id: tc.id,
                name: tc.function.name,
                input: {},
              },
            };
          }

          const args = tc.function?.arguments;
          if (typeof args === "string" && args.length > 0) {
            yield {
              type: "content_block_delta",
              index: blockIndex,
              delta: { type: "input_json_delta", partial_json: args },
            };
          }
        }
      }
    }

    if (choice.finish_reason) {
      yield {
        type: "message_delta",
        delta: { stop_reason: mapFinishReason(choice.finish_reason), stop_sequence: null },
        usage: { output_tokens: 0 },
      };
      yield { type: "message_stop" };
    }
  }
}

/**
 * Hand-rolled SSE parser over a byte ReadableStream. Yields the raw
 * `data:` payload for each frame (may be JSON or the literal `[DONE]`).
 * Ignores comment lines (`:` prefix) and unknown fields per the SSE spec.
 */
async function* parseSSE(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncIterableIterator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  try {
    while (true) {
      if (signal?.aborted) throw signal.reason ?? new Error("aborted");
      const { value, done } = await reader.read();
      if (done) {
        if (buffer.length > 0) {
          const frame = extractDataPayload(buffer);
          if (frame !== undefined) yield frame;
        }
        return;
      }
      buffer += decoder.decode(value, { stream: true });

      // Split on blank lines; tolerate both \n\n and \r\n\r\n.
      let sepIdx: number;
      // biome-ignore lint/suspicious/noAssignInExpressions: loop idiom
      while ((sepIdx = findFrameBoundary(buffer)) !== -1) {
        const frameRaw = buffer.slice(0, sepIdx);
        buffer = buffer.slice(sepIdx).replace(/^(\r?\n){1,2}/, "");
        const frame = extractDataPayload(frameRaw);
        if (frame !== undefined) yield frame;
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* noop */
    }
  }
}

function findFrameBoundary(buf: string): number {
  const a = buf.indexOf("\n\n");
  const b = buf.indexOf("\r\n\r\n");
  if (a === -1) return b;
  if (b === -1) return a;
  return Math.min(a, b);
}

function extractDataPayload(frame: string): string | undefined {
  const lines = frame.split(/\r?\n/);
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.length === 0) continue;
    if (line.startsWith(":")) continue; // SSE comment (e.g., ": OPENROUTER PROCESSING")
    if (line.startsWith("data:")) {
      // Strip leading "data:" + optional single space (per SSE spec).
      const rest = line.slice(5);
      dataLines.push(rest.startsWith(" ") ? rest.slice(1) : rest);
    }
    // Ignore `event:`, `id:`, `retry:` fields — we don't need them.
  }
  if (dataLines.length === 0) return undefined;
  return dataLines.join("\n");
}
