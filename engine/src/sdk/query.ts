/**
 * SDK-compatible query() function (T3-12).
 *
 * Provides a @anthropic-ai/claude-agent-sdk compatible interface that yields
 * SDKMessage objects instead of internal AgentEvent objects.
 *
 * Usage:
 *   import { query } from "@jellyclaw/engine";
 *   for await (const msg of query({ prompt: "hello" })) {
 *     console.log(msg.type);
 *   }
 */

import { randomUUID } from "node:crypto";
import type { AgentEvent } from "../events.js";
import {
  createMapperState,
  createTerminalErrorMessage,
  type EventMapperOptions,
  mapEventToSdkMessages,
} from "./event-mapper.js";
import type { Query, QueryOptions, SDKMessage, UserInputMessage } from "./types.js";

// ---------------------------------------------------------------------------
// Stub provider for testing / offline mode
// ---------------------------------------------------------------------------

interface StubProviderOptions {
  readonly prompt: string;
  readonly model: string;
  readonly sessionId: string;
  readonly cwd: string;
  readonly signal?: AbortSignal;
}

/**
 * A minimal stub that emits a basic session flow.
 * This is used when no real provider is available (e.g., testing).
 */
// biome-ignore lint/suspicious/useAwait: async generator for AsyncIterable compatibility
async function* stubProviderEvents(opts: StubProviderOptions): AsyncIterable<AgentEvent> {
  const { prompt, model, sessionId, cwd, signal } = opts;
  const now = Date.now();
  let seq = 0;

  // Check abort before starting
  if (signal?.aborted) {
    return;
  }

  yield {
    type: "session.started",
    session_id: sessionId,
    ts: now + seq,
    seq: seq++,
    wish: prompt,
    agent: "default",
    model,
    provider: "anthropic",
    cwd,
  };

  // Check abort after session.started
  if (signal?.aborted) {
    yield {
      type: "session.error",
      session_id: sessionId,
      ts: now + seq,
      seq: seq++,
      code: "aborted",
      message: "Operation aborted",
      recoverable: false,
    };
    return;
  }

  // Emit a simple response
  yield {
    type: "agent.message",
    session_id: sessionId,
    ts: now + seq,
    seq: seq++,
    delta: "hi there",
    final: false,
  };

  yield {
    type: "agent.message",
    session_id: sessionId,
    ts: now + seq,
    seq: seq++,
    delta: "",
    final: true,
  };

  // Usage event
  yield {
    type: "usage.updated",
    session_id: sessionId,
    ts: now + seq,
    seq: seq++,
    input_tokens: 10,
    output_tokens: 5,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
  };

  // Session completed
  yield {
    type: "session.completed",
    session_id: sessionId,
    ts: now + seq,
    seq: seq++,
    turns: 1,
    duration_ms: 100,
  };
}

// ---------------------------------------------------------------------------
// Query implementation
// ---------------------------------------------------------------------------

/**
 * Resolve prompt from string or async iterable.
 * When prompt is an AsyncIterable, we consume it and concatenate user messages.
 */
async function resolvePrompt(
  prompt: string | AsyncIterable<UserInputMessage>,
): Promise<{ prompt: string; priorMessages: ReadonlyArray<{ role: "user"; content: string }> }> {
  if (typeof prompt === "string") {
    return { prompt, priorMessages: [] };
  }

  // Consume the async iterable
  const messages: { role: "user"; content: string }[] = [];
  for await (const msg of prompt) {
    if (msg.type === "user" && msg.message.role === "user") {
      messages.push({ role: "user", content: msg.message.content });
    }
  }

  if (messages.length === 0) {
    return { prompt: "", priorMessages: [] };
  }

  // Last message becomes the active prompt, rest are prior messages
  const lastMsg = messages[messages.length - 1];
  const priorMessages = messages.slice(0, -1);

  return {
    prompt: lastMsg?.content ?? "",
    priorMessages,
  };
}

/**
 * Create an SDK-compatible query generator.
 */
export function query(args: QueryOptions): Query {
  const abortController = args.options?.abortController ?? new AbortController();
  let interruptCalled = false;
  let generatorDone = false;

  async function* generateMessages(): AsyncGenerator<SDKMessage, void, void> {
    // Resolve the prompt
    const { prompt: resolvedPrompt } = await resolvePrompt(args.prompt);

    const sessionId = randomUUID();
    const model = args.options?.model ?? "claude-sonnet-4-20250514";
    const cwd = args.options?.cwd ?? process.cwd();

    // Create mapper state and options
    const state = createMapperState();
    const mapperOpts: EventMapperOptions = {
      cwd,
      tools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep"],
      permissionMode: args.options?.permissionMode ?? "default",
      apiKeySource: process.env.ANTHROPIC_API_KEY ? "env" : "none",
      claudeCodeVersion: "0.0.1",
      agents: [],
      skills: [],
      slashCommands: [],
      plugins: [],
      mcpServers: [],
      outputStyle: "default",
    };

    // Use stub provider for now (real provider integration in future)
    const events = stubProviderEvents({
      prompt: resolvedPrompt,
      model,
      sessionId,
      cwd,
      signal: abortController.signal,
    });

    try {
      for await (const event of events) {
        // Check for abort
        if (abortController.signal.aborted) {
          // Emit terminal message if not already done
          if (!state.terminalEmitted) {
            yield createTerminalErrorMessage(state);
          }
          return;
        }

        // Map event to SDK messages
        const messages = mapEventToSdkMessages(event, state, mapperOpts);
        for (const msg of messages) {
          yield msg;
        }

        // Stop if terminal was emitted
        if (state.terminalEmitted) {
          return;
        }
      }

      // If stream ended without terminal, emit error
      if (!state.terminalEmitted) {
        yield createTerminalErrorMessage(state);
      }
    } finally {
      generatorDone = true;
    }
  }

  // Create the generator
  const generator = generateMessages();

  // Add interrupt method
  const queryGenerator: Query = {
    [Symbol.asyncIterator](): AsyncIterator<SDKMessage, void, void> {
      return this;
    },

    next(): Promise<IteratorResult<SDKMessage, void>> {
      return generator.next();
    },

    return(value?: void | PromiseLike<void>): Promise<IteratorResult<SDKMessage, void>> {
      return generator.return(value as undefined);
    },

    throw(error?: unknown): Promise<IteratorResult<SDKMessage, void>> {
      return generator.throw(error);
    },

    async interrupt(): Promise<void> {
      if (interruptCalled || generatorDone) {
        return;
      }
      interruptCalled = true;
      abortController.abort();
      // Wait for generator to clean up
      try {
        // Drain remaining messages
        let result = await generator.next();
        while (!result.done) {
          result = await generator.next();
        }
      } catch {
        // Ignore errors during drain
      }
    },
  };

  return queryGenerator;
}
