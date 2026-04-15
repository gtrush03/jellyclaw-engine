/**
 * Subagent dispatcher (Phase 06 Prompt 02).
 *
 * Implements `SubagentService` by wiring together:
 *   - `AgentRegistry` — agent lookup.
 *   - `Semaphore`     — concurrency cap.
 *   - `buildSubagentContext` — isolated child context.
 *   - `SessionRunner` seam — runs the child (mock in tests; real OpenCode
 *                            session in Phase 09).
 *
 * Guarantees:
 *   - `dispatch()` NEVER throws. Every failure path is mapped to a
 *     `SubagentResult` with `status: "error" | "cancelled" | "max_turns"`.
 *   - All emitted events (`subagent.start`, `subagent.end`) and forwarded
 *     runner events are delivered through `emit`. Listener errors are
 *     caught and logged — a throwing listener never breaks dispatch.
 *   - Returned `SubagentResult` is fully JSON-serialisable (no Error
 *     instances, no functions, no symbols).
 */

import { randomUUID } from "node:crypto";

import type { Event, Usage } from "@jellyclaw/shared";

import { logger as defaultLogger, type Logger } from "../logger.js";
import type {
  SubagentDispatchInput,
  SubagentResult,
  SubagentService,
  SubagentUsage,
} from "../subagents/types.js";
import { buildSubagentContext } from "./context.js";
import {
  type DispatchConfig,
  NoUsableToolsError,
  type ParentContext,
  type SessionRunner,
  type SessionRunUsage,
  SubagentDepthExceededError,
} from "./dispatch-types.js";
import { makeSubagentEndEvent, makeSubagentStartEvent } from "./events.js";
import type { AgentRegistry } from "./registry.js";
import type { Semaphore } from "./semaphore.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SubagentDispatcherOptions {
  readonly registry: AgentRegistry;
  readonly runner: SessionRunner;
  readonly semaphore: Semaphore;
  readonly config: DispatchConfig;
  readonly parent: ParentContext;
  readonly clock?: () => number;
  readonly logger?: Logger;
  readonly emit?: (event: Event) => void;
  readonly idGen?: () => string;
  readonly signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ZERO_SUBAGENT_USAGE: SubagentUsage = Object.freeze({
  input_tokens: 0,
  output_tokens: 0,
});

function zeroEventUsage(): Usage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    cost_usd: 0,
  };
}

function mapRunUsageToEventUsage(u: SessionRunUsage): Usage {
  return {
    input_tokens: u.input_tokens,
    output_tokens: u.output_tokens,
    cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
    cost_usd: 0,
  };
}

function mapRunUsageToSubagentUsage(u: SessionRunUsage): SubagentUsage {
  const out: { -readonly [K in keyof SubagentUsage]: SubagentUsage[K] } = {
    input_tokens: u.input_tokens,
    output_tokens: u.output_tokens,
  };
  if (u.cache_creation_input_tokens !== undefined) {
    out.cache_creation_input_tokens = u.cache_creation_input_tokens;
  }
  if (u.cache_read_input_tokens !== undefined) {
    out.cache_read_input_tokens = u.cache_read_input_tokens;
  }
  return out;
}

function mapReason(
  reason: "complete" | "max_turns" | "max_tokens" | "error" | "cancelled",
): SubagentResult["status"] {
  switch (reason) {
    case "complete":
      return "success";
    case "cancelled":
      return "cancelled";
    case "max_turns":
    case "max_tokens":
      return "max_turns";
    case "error":
      return "error";
  }
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export class SubagentDispatcher implements SubagentService {
  readonly #registry: AgentRegistry;
  readonly #runner: SessionRunner;
  readonly #semaphore: Semaphore;
  readonly #config: DispatchConfig;
  readonly #parent: ParentContext;
  readonly #clock: () => number;
  readonly #logger: Logger;
  readonly #emit: (event: Event) => void;
  readonly #idGen: () => string;
  readonly #signal: AbortSignal;

  constructor(opts: SubagentDispatcherOptions) {
    this.#registry = opts.registry;
    this.#runner = opts.runner;
    this.#semaphore = opts.semaphore;
    this.#config = opts.config;
    this.#parent = opts.parent;
    this.#clock = opts.clock ?? Date.now;
    this.#logger = opts.logger ?? defaultLogger;
    this.#emit = opts.emit ?? (() => {});
    this.#idGen = opts.idGen ?? (() => randomUUID());
    this.#signal = opts.signal ?? new AbortController().signal;
  }

  async dispatch(input: SubagentDispatchInput): Promise<SubagentResult> {
    // Step 1: agent lookup.
    const agent = this.#registry.get(input.subagent_type);
    if (!agent) {
      const summary = `unknown_agent: ${input.subagent_type}`;
      this.#logger.warn(
        { subagent_type: input.subagent_type, reason: "unknown_agent" },
        "subagent dispatch rejected",
      );
      const syntheticId = this.#idGen();
      this.#safeEmit(
        makeSubagentEndEvent({
          sessionId: syntheticId,
          summary,
          usage: zeroEventUsage(),
          ts: this.#clock(),
        }),
      );
      return { summary, status: "error", usage: ZERO_SUBAGENT_USAGE };
    }

    // Step 2: depth guard (pre-slot so we do not waste concurrency).
    const depth = this.#parent.depth + 1;
    if (depth > this.#config.maxDepth) {
      const summary = `subagent_depth_exceeded: depth=${depth} maxDepth=${this.#config.maxDepth}`;
      this.#logger.warn(
        { depth, maxDepth: this.#config.maxDepth, reason: "subagent_depth_exceeded" },
        "subagent dispatch rejected",
      );
      const syntheticId = this.#idGen();
      this.#safeEmit(
        makeSubagentEndEvent({
          sessionId: syntheticId,
          summary,
          usage: zeroEventUsage(),
          ts: this.#clock(),
        }),
      );
      return { summary, status: "error", usage: ZERO_SUBAGENT_USAGE };
    }

    // Step 3+: run inside the semaphore slot. Release is automatic.
    return await this.#semaphore.run(async () => {
      // Step 4: build isolated context. Catch NoUsableToolsError /
      // SubagentDepthExceededError from the pure builder (depth was
      // already gated above, but belt-and-braces).
      const subagentSessionId = this.#idGen();
      let context: ReturnType<typeof buildSubagentContext>;
      try {
        context = buildSubagentContext({
          agent,
          parent: this.#parent,
          description: input.description,
          prompt: input.prompt,
          config: this.#config,
          subagentSessionId,
        });
      } catch (err) {
        let summary: string;
        if (err instanceof NoUsableToolsError) {
          summary = `no_usable_tools: agent '${err.agentName}'`;
          this.#logger.warn(
            { subagent_type: input.subagent_type, reason: "no_usable_tools" },
            "subagent context build failed",
          );
        } else if (err instanceof SubagentDepthExceededError) {
          summary = `subagent_depth_exceeded: depth=${err.depth} maxDepth=${err.maxDepth}`;
          this.#logger.warn({ reason: "subagent_depth_exceeded" }, "subagent context build failed");
        } else {
          summary = `context_build_error: ${(err as Error)?.message ?? "unknown"}`;
          this.#logger.warn(
            { err, subagent_type: input.subagent_type, reason: "context_build_error" },
            "subagent context build failed",
          );
        }
        this.#safeEmit(
          makeSubagentEndEvent({
            sessionId: subagentSessionId,
            summary,
            usage: zeroEventUsage(),
            ts: this.#clock(),
          }),
        );
        return { summary, status: "error", usage: ZERO_SUBAGENT_USAGE };
      }

      // Step 5: emit subagent.start.
      this.#safeEmit(
        makeSubagentStartEvent({
          sessionId: subagentSessionId,
          agentName: context.agentName,
          parentId: this.#parent.sessionId,
          allowedTools: context.allowedTools,
          ts: this.#clock(),
        }),
      );

      // Step 6: link parent cancellation into a child AbortController.
      const childController = new AbortController();
      const onParentAbort = (): void => {
        childController.abort(this.#signal.reason);
      };
      if (this.#signal.aborted) {
        childController.abort(this.#signal.reason);
      } else {
        this.#signal.addEventListener("abort", onParentAbort, { once: true });
      }

      // Step 7: run the child session.
      let runResult: Awaited<ReturnType<SessionRunner["run"]>>;
      try {
        runResult = await this.#runner.run({
          context,
          signal: childController.signal,
          onEvent: (event) => this.#safeEmit(event),
          clock: this.#clock,
        });
      } catch (err) {
        this.#signal.removeEventListener("abort", onParentAbort);
        const summary = `runner_error: ${(err as Error)?.message ?? "unknown"}`;
        this.#logger.warn(
          { err, subagent_type: input.subagent_type, reason: "runner_threw" },
          "subagent runner threw; mapping to error result",
        );
        this.#safeEmit(
          makeSubagentEndEvent({
            sessionId: subagentSessionId,
            summary,
            usage: zeroEventUsage(),
            ts: this.#clock(),
          }),
        );
        return { summary, status: "error", usage: ZERO_SUBAGENT_USAGE };
      }
      this.#signal.removeEventListener("abort", onParentAbort);

      // Step 8: map runner reason → public SubagentResult.status.
      if (runResult.reason === "error") {
        this.#logger.warn(
          {
            subagent_type: input.subagent_type,
            errorMessage: runResult.errorMessage,
            reason: "runner_error",
          },
          "subagent runner reported error",
        );
      }
      const status = mapReason(runResult.reason);

      // Step 9: emit subagent.end.
      this.#safeEmit(
        makeSubagentEndEvent({
          sessionId: subagentSessionId,
          summary: runResult.summary,
          usage: mapRunUsageToEventUsage(runResult.usage),
          ts: this.#clock(),
        }),
      );

      // Step 10: return public SubagentResult.
      return {
        summary: runResult.summary,
        status,
        usage: mapRunUsageToSubagentUsage(runResult.usage),
      };
    });
  }

  #safeEmit(event: Event): void {
    try {
      this.#emit(event);
    } catch (err) {
      this.#logger.warn({ err, eventType: event.type }, "subagent event listener threw");
    }
  }
}

/**
 * Convenience factory — returns the bare `SubagentService` shape (just the
 * `dispatch` method) for callers that do not need the class instance.
 */
export function createSubagentDispatcher(opts: SubagentDispatcherOptions): SubagentService {
  const dispatcher = new SubagentDispatcher(opts);
  return {
    dispatch: (input) => dispatcher.dispatch(input),
  };
}
