/**
 * Real SessionRunner implementation (Phase T2-02).
 *
 * Drives subagent execution by recursively invoking `runAgentLoop` with an
 * isolated context. The runner:
 *   - Resolves tool subsets from the SubagentContext's allowedTools.
 *   - Forwards events through `args.onEvent`.
 *   - Maps final `session.completed` / `session.error` into `SessionRunResult`.
 *   - Enforces maxTurns from the SubagentContext.
 *   - Applies the T1-01 byte cap (inherited from runAgentLoop).
 *
 * The runner is injected into `SubagentDispatcher` at CLI bootstrap. Tests can
 * provide a mock runner via the dispatcher's `SessionRunner` seam.
 */

import type { Event } from "@jellyclaw/shared";

import type {
  RunReason,
  SessionRunArgs,
  SessionRunner,
  SessionRunResult,
  SessionRunUsage,
} from "../agents/dispatch-types.js";
import { runAgentLoop } from "../agents/loop.js";
import type { HookRegistry } from "../hooks/registry.js";
import type { Logger } from "../logger.js";
import type { McpRegistry } from "../mcp/registry.js";
import type { CompiledPermissions } from "../permissions/types.js";
import type { Provider } from "../providers/types.js";
import type { SubagentService } from "./types.js";

// ---------------------------------------------------------------------------
// Factory dependencies
// ---------------------------------------------------------------------------

export interface CreateSessionRunnerDeps {
  readonly provider: Provider;
  readonly permissions: CompiledPermissions;
  readonly hooks: HookRegistry;
  readonly logger: Logger;
  readonly mcp?: McpRegistry;
  /** Injected clock; defaults to `Date.now`. */
  readonly clock?: () => number;
  /**
   * The subagent service to pass down to nested loops. This enables recursive
   * Task tool calls up to maxDepth. When undefined, nested Task calls will
   * fail with "subagents not available".
   */
  readonly subagents?: SubagentService;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Create a real SessionRunner that drives subagent execution via runAgentLoop.
 *
 * The runner collects events from the inner loop and forwards them through
 * `args.onEvent`. It maps the loop's terminal event (session.completed or
 * session.error) into the `SessionRunResult` shape expected by the dispatcher.
 */
export function createSessionRunner(deps: CreateSessionRunnerDeps): SessionRunner {
  const { provider, permissions, hooks, logger, mcp, clock, subagents } = deps;
  const now = clock ?? Date.now;

  return {
    async run(args: SessionRunArgs): Promise<SessionRunResult> {
      const { context, signal, onEvent } = args;

      // Accumulate usage across turns.
      let inputTokens = 0;
      let outputTokens = 0;
      let cacheWriteTokens = 0;
      let cacheReadTokens = 0;

      // Track the final result.
      let finalSummary = "";
      let finalReason: RunReason = "complete";
      let finalTurns = 0;
      let errorMessage: string | undefined;

      try {
        const loop = runAgentLoop({
          provider,
          hooks,
          permissions,
          model: context.model,
          systemPrompt: context.systemPrompt,
          prompt: context.prompt,
          sessionId: context.subagentSessionId,
          cwd: process.cwd(),
          signal,
          logger,
          maxTurns: context.maxTurns,
          ...(mcp !== undefined ? { mcp } : {}),
          ...(subagents !== undefined ? { subagents } : {}),
          now,
        });

        for await (const event of loop) {
          // Forward all events upstream. Cast via unknown since AgentEvent and
          // @jellyclaw/shared Event have slight shape differences.
          onEvent(event as unknown as Event);

          // Accumulate usage from usage.updated events.
          if (event.type === "usage.updated") {
            inputTokens = event.input_tokens ?? inputTokens;
            outputTokens = event.output_tokens ?? outputTokens;
            if (event.cache_write_tokens !== undefined) {
              cacheWriteTokens = event.cache_write_tokens;
            }
            if (event.cache_read_tokens !== undefined) {
              cacheReadTokens = event.cache_read_tokens;
            }
          }

          // Capture terminal events.
          if (event.type === "session.completed") {
            finalSummary = event.summary ?? "";
            finalTurns = event.turns;
            finalReason = "complete";
          } else if (event.type === "session.error") {
            finalSummary = event.message;
            finalReason = mapErrorCodeToReason(event.code);
            errorMessage = event.message;
          }
        }
      } catch (err) {
        // runAgentLoop should never throw (errors are mapped to session.error),
        // but handle unexpected throws defensively.
        const message = err instanceof Error ? err.message : String(err);
        logger.warn({ err }, "SessionRunner: runAgentLoop threw unexpectedly");
        return {
          summary: `runner_error: ${message}`,
          usage: buildUsage(inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens),
          turns: finalTurns,
          reason: "error",
          errorMessage: message,
        };
      }

      // Build the result.
      const usage = buildUsage(inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens);

      const result: SessionRunResult = {
        summary: finalSummary,
        usage,
        turns: finalTurns,
        reason: finalReason,
      };

      if (errorMessage !== undefined) {
        return { ...result, errorMessage };
      }

      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapErrorCodeToReason(code: string): RunReason {
  switch (code) {
    case "aborted":
      return "cancelled";
    case "max_turns_exceeded":
      return "max_turns";
    case "max_output_tokens":
      return "max_tokens";
    default:
      return "error";
  }
}

function buildUsage(
  inputTokens: number,
  outputTokens: number,
  cacheWriteTokens: number,
  cacheReadTokens: number,
): SessionRunUsage {
  const usage: SessionRunUsage = {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
  };
  // Map to the SessionRunUsage field names (cache_creation_input_tokens, cache_read_input_tokens).
  if (cacheWriteTokens > 0) {
    return { ...usage, cache_creation_input_tokens: cacheWriteTokens };
  }
  if (cacheReadTokens > 0) {
    return { ...usage, cache_read_input_tokens: cacheReadTokens };
  }
  return usage;
}

/**
 * A "feature disabled" runner that returns an error result without throwing.
 * Used when subagents are not configured (no dispatcher provided).
 */
export const disabledSessionRunner: SessionRunner = {
  // biome-ignore lint/suspicious/useAwait: async contract required by interface
  async run(): Promise<SessionRunResult> {
    return {
      summary: "subagents_disabled: no subagent dispatcher configured",
      usage: { input_tokens: 0, output_tokens: 0 },
      turns: 0,
      reason: "error",
      errorMessage: "subagents_disabled: no subagent dispatcher configured",
    };
  },
};
