/**
 * Real agent loop (Phase 99.02).
 *
 * An async generator that drives a multi-turn agent conversation against a
 * `Provider`, threads chunks through the `ProviderChunk → AgentEvent` adapter
 * (see `../providers/adapter.ts`), executes tools requested by the model,
 * and feeds `tool_result` blocks back in on the next turn.
 *
 * This is the load-bearing replacement for `legacy-run.ts`'s `[phase-0 stub]`
 * generator. Prompt 99.03 wires it into `RunManager.defaultRunFactory` and
 * the CLI.
 *
 * Key invariants:
 *  - The adapter's `AdapterState` (and therefore `seq`) persists across turns,
 *    so `session.started` fires exactly once and seq is monotonic per session.
 *  - Tool handlers never bubble out of this generator. Any error (handler
 *    throw, zod validation fail, hook deny, permission deny) is emitted as
 *    `tool.error` AND fed back as `tool_result{is_error:true}` so the model
 *    can self-correct.
 *  - Abort: `signal.aborted` → yield `session.error{code:"aborted"}` and
 *    return cleanly. RunManager treats clean return as success; we
 *    intentionally don't throw.
 *  - Provider errors exhausted by internal retry surface as `APIError`;
 *    mapped to `session.error{code:"<status>" | "provider_error"}`.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { APIError } from "@anthropic-ai/sdk";
import { z } from "zod";
import type { AgentEvent } from "../events.js";
import type { HookRegistry } from "../hooks/registry.js";
import { runHooks } from "../hooks/registry.js";
import type { HookEvent } from "../hooks/types.js";
import type { Logger } from "../logger.js";
import type { McpRegistry } from "../mcp/registry.js";
import type { McpCallToolResult } from "../mcp/types.js";
import { decide } from "../permissions/engine.js";
import type { AskHandler, CompiledPermissions, ToolCall } from "../permissions/types.js";
import { adaptChunk, adaptDone, createAdapterState } from "../providers/adapter.js";
import type { Provider, ProviderRequest, SystemBlock } from "../providers/types.js";
import type { SkillRegistry } from "../skills/registry.js";
import type { SubagentService } from "../subagents/types.js";
import { buildToolList, getTool } from "../tools/index.js";
import { createSkillTool } from "../tools/skill.js";
import {
  makePermissionService,
  type PermissionService,
  type SessionHandle,
  type SessionState,
  type ToolContext,
} from "../tools/types.js";
import { compactMessages, contextBudgetForModel } from "./compaction.js";
import { formatMemoryBlock, loadMemory } from "./memory.js";
import { applyToolFilter, isToolEnabled, type ToolFilter } from "./tool-filter.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum bytes for stringified tool results before truncation. */
const MAX_TOOL_RESULT_BYTES = 200_000;

/** Default per-turn model output budget. Overridable via `AgentLoopOptions.maxOutputTokens`. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 16_384;

/** Default tool-use turn cap. Overridable via `AgentLoopOptions.maxTurns`. */
export const DEFAULT_MAX_TURNS = 50;

/** Hard upper limit on tool-use turns. Prevents runaway sessions. */
export const MAX_ITERATIONS = 150;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface AgentLoopOptions {
  readonly provider: Provider;
  readonly hooks: HookRegistry;
  readonly permissions: CompiledPermissions;
  readonly askHandler?: AskHandler;
  readonly model: string;
  readonly systemPrompt?: string;
  readonly prompt: string;
  /**
   * Conversation history from prior turns in this session. Prepended to the
   * working `messages` array so multi-turn sessions retain context.
   */
  readonly priorMessages?: ReadonlyArray<{ role: "user" | "assistant"; content: string }>;
  readonly sessionId: string;
  readonly cwd: string;
  readonly signal: AbortSignal;
  readonly logger: Logger;
  readonly agent?: string;
  readonly wish?: string;
  /** Key-based permission service for intra-tool checks (e.g. `bash.cd_escape`). */
  readonly toolPermissionService?: PermissionService;
  /** Subagent dispatcher (Task tool). Defaults to the Phase-04 stub. */
  readonly subagents?: SubagentService;
  /** Maximum tool-use turns before giving up. Default 25. */
  readonly maxTurns?: number;
  /** Optional USD budget. Skipped when adapter/provider doesn't surface cost. */
  readonly maxBudgetUsd?: number;
  /** Model max_tokens per turn. Default DEFAULT_MAX_OUTPUT_TOKENS (16384). */
  readonly maxOutputTokens?: number;
  /** Clock injection per CLAUDE.md §6. Default `Date.now`. */
  readonly now?: () => number;
  /**
   * MCP (Model Context Protocol) registry. When provided, tools from connected
   * MCP servers are merged into the provider request and `mcp__*` tool calls
   * are routed through the registry.
   */
  readonly mcp?: McpRegistry;
  /**
   * Skill registry. When provided and non-empty, the Skill tool is registered
   * and skill bodies are returned when invoked.
   */
  readonly skillRegistry?: SkillRegistry;
  /**
   * Tool filter for --allowed-tools / --disallowed-tools (T2-09).
   * When provided, filters the tools advertised to the model and rejects
   * runtime calls to disabled tools.
   */
  readonly toolFilter?: ToolFilter;
  /**
   * Additional allowed root directories (T2-10). Paths under any of these are
   * permitted by path tools in addition to `cwd`. Set via `--add-dir` CLI flag.
   */
  readonly additionalRoots?: readonly string[];
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface ToolUseBlock {
  readonly type: "tool_use";
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

type ContentBlockParam =
  | { type: "text"; text: string }
  | ToolUseBlock
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string;
      is_error?: boolean;
    };

interface ToolExecutionOutcome {
  readonly events: readonly AgentEvent[];
  readonly result: ContentBlockParam;
}

// ---------------------------------------------------------------------------
// Public generator
// ---------------------------------------------------------------------------

export async function* runAgentLoop(
  opts: AgentLoopOptions,
): AsyncGenerator<AgentEvent, void, void> {
  const now = opts.now ?? defaultNow;
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
  if (maxTurns > MAX_ITERATIONS) {
    throw new Error(`maxTurns=${maxTurns} exceeds MAX_ITERATIONS=${MAX_ITERATIONS}`);
  }
  const maxOutputTokens = opts.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const t0 = now();

  const state = createAdapterState({
    sessionId: opts.sessionId,
    model: opts.model,
    wish: opts.wish ?? opts.prompt,
    agent: opts.agent ?? "default",
    cwd: opts.cwd,
    provider: opts.provider.name === "openrouter" ? "openrouter" : "anthropic",
  });

  const readCache = new Set<string>();
  const permService = opts.toolPermissionService ?? makePermissionService();
  // Subagents: require caller to provide one, or default to a disabled service
  // that returns an error result (not a throw). The CLI path MUST always supply one.
  const subagents: SubagentService = opts.subagents ?? disabledSubagentService;

  // Per-run session handle for tools that need session state (e.g. TodoWrite).
  const sessionState: SessionState = { todos: [] };
  const sessionHandle: SessionHandle = {
    get state() {
      return sessionState;
    },
    update(patch) {
      if (patch.todos !== undefined) {
        (sessionState as { todos: SessionState["todos"] }).todos = patch.todos;
      }
      // NOTE(T2): forward to an outbound `session.update` AgentEvent once the
      // event type lands. For T1 the in-memory state + tool return value is
      // sufficient to unblock planning.
    },
  };

  // Load auto-memory (T3-04).
  const memoryContents = await loadMemory(opts.cwd);
  opts.logger.info({ memoryBytes: memoryContents?.length ?? 0 }, "auto-memory loaded");
  const memoryBlock = formatMemoryBlock(memoryContents);

  // Build system prompt with optional memory injection.
  const systemText =
    memoryBlock.length > 0 && opts.systemPrompt !== undefined && opts.systemPrompt.length > 0
      ? `${opts.systemPrompt}\n\n${memoryBlock}`
      : memoryBlock.length > 0
        ? memoryBlock
        : (opts.systemPrompt ?? "");

  const system: SystemBlock[] = systemText.length > 0 ? [{ type: "text", text: systemText }] : [];
  const tools = toolsAsProviderTools(opts.mcp, opts.skillRegistry, opts.toolFilter);
  let messages: Anthropic.Messages.MessageParam[] = [
    ...(opts.priorMessages ?? []).map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: opts.prompt },
  ];

  // Running token counter for compaction trigger (T3-01).
  // Accumulates input_tokens + cache_read_tokens + cache_write_tokens across turns.
  let runningInputTokens = 0;
  const budget = contextBudgetForModel(opts.model);
  const compactionThreshold = Math.floor(budget.windowTokens * budget.triggerRatio);

  for (let turn = 1; turn <= maxTurns; turn++) {
    if (opts.signal.aborted) {
      yield abortedEvent(opts.sessionId, now(), state);
      return;
    }

    // Compaction check (T3-01): if running tokens exceed threshold, compact.
    if (runningInputTokens >= compactionThreshold) {
      const preCompactEvent: HookEvent = {
        kind: "PreCompact",
        payload: {
          sessionId: opts.sessionId,
          tokenCount: runningInputTokens,
          threshold: compactionThreshold,
        },
      };

      let shouldCompact = true;
      try {
        const hookResult = await runHooks({
          event: preCompactEvent,
          sessionId: opts.sessionId,
          hooks: opts.hooks.hooksFor(preCompactEvent),
          logger: opts.logger,
        });
        if (hookResult.decision === "deny") {
          // Hook denied compaction — skip this iteration's compaction (advisory).
          opts.logger.info({ reason: hookResult.reason }, "compaction skipped: hook denied");
          shouldCompact = false;
        }
      } catch (err) {
        opts.logger.warn({ err }, "pre-compact-hook error (proceeding with compaction)");
      }

      if (shouldCompact) {
        opts.logger.info({ runningInputTokens, compactionThreshold }, "compaction triggered");

        const compactResult = await compactMessages({
          messages,
          system,
          provider: opts.provider,
          model: opts.model,
          sessionId: opts.sessionId,
          signal: opts.signal,
          logger: opts.logger,
        });

        if (compactResult.summary.length > 0) {
          messages = compactResult.rewritten;
          // Reset token counter to an estimate of the new prefix size.
          // Approximate: 1 token ≈ 4 characters.
          runningInputTokens = Math.floor(compactResult.summary.length / 4);
          opts.logger.info(
            {
              newMessageCount: messages.length,
              estimatedTokens: runningInputTokens,
            },
            "compaction completed",
          );
        }
      }
    }

    const req: ProviderRequest = {
      model: opts.model,
      maxOutputTokens,
      system,
      messages,
      ...(tools.length > 0 ? { tools } : {}),
    };

    const queuedTools: Array<Extract<AgentEvent, { type: "tool.called" }>> = [];
    /** tool.error events produced by the adapter (e.g. invalid_input) — need
     * to be fed back to the model even though no handler runs. */
    const adapterToolErrors: Array<Extract<AgentEvent, { type: "tool.error" }>> = [];
    let assistantText = "";
    let budgetBlown = false;

    try {
      for await (const chunk of opts.provider.stream(req, opts.signal)) {
        if (opts.signal.aborted) {
          yield abortedEvent(opts.sessionId, now(), state);
          return;
        }
        for (const ev of adaptChunk(state, chunk, now())) {
          if (ev.type === "tool.called") {
            queuedTools.push(ev);
          } else if (ev.type === "tool.error") {
            adapterToolErrors.push(ev);
          } else if (
            ev.type === "agent.message" &&
            ev.final === false &&
            typeof ev.delta === "string"
          ) {
            assistantText += ev.delta;
          }

          // Track running input tokens for compaction (T3-01).
          if (ev.type === "usage.updated") {
            // Accumulate input + cache tokens for compaction threshold check.
            runningInputTokens =
              ev.input_tokens + (ev.cache_read_tokens ?? 0) + (ev.cache_write_tokens ?? 0);
          }

          if (
            ev.type === "usage.updated" &&
            opts.maxBudgetUsd !== undefined &&
            typeof ev.cost_usd === "number" &&
            ev.cost_usd > opts.maxBudgetUsd
          ) {
            yield ev;
            yield {
              type: "session.error",
              session_id: opts.sessionId,
              ts: now(),
              seq: state.seq++,
              code: "max_cost_usd_exceeded",
              message: `cumulative cost $${ev.cost_usd.toFixed(4)} exceeded cap $${opts.maxBudgetUsd.toFixed(4)}`,
              recoverable: false,
            };
            budgetBlown = true;
            break;
          }
          yield ev;
        }
        if (budgetBlown) return;
      }
    } catch (err) {
      if (opts.signal.aborted) {
        yield abortedEvent(opts.sessionId, now(), state);
        return;
      }
      const { code, message } = mapProviderError(err);
      yield {
        type: "session.error",
        session_id: opts.sessionId,
        ts: now(),
        seq: state.seq++,
        code,
        message,
        recoverable: false,
      };
      return;
    }

    // Check for max_tokens truncation before declaring success.
    if (
      queuedTools.length === 0 &&
      adapterToolErrors.length === 0 &&
      state.stopReason === "max_tokens"
    ) {
      yield {
        type: "session.error",
        session_id: opts.sessionId,
        ts: now(),
        seq: state.seq++,
        code: "max_output_tokens",
        message: `model response truncated at max_output_tokens=${maxOutputTokens} (turn ${turn})`,
        recoverable: false,
      };
      return;
    }

    if (queuedTools.length === 0 && adapterToolErrors.length === 0) {
      yield adaptDone(state, {
        turns: turn,
        duration_ms: now() - t0,
        now: now(),
      });
      return;
    }

    // Build the assistant transcript entry.
    const assistantContent: ContentBlockParam[] = [];
    if (assistantText.length > 0) {
      assistantContent.push({ type: "text", text: assistantText });
    }
    for (const tc of queuedTools) {
      assistantContent.push({
        type: "tool_use",
        id: tc.tool_id,
        name: tc.tool_name,
        input: tc.input,
      });
    }
    // Adapter-emitted tool errors (e.g. invalid_input) need a synthetic
    // tool_use block so the corresponding tool_result has something to
    // reference — otherwise Anthropic rejects the message.
    for (const te of adapterToolErrors) {
      assistantContent.push({
        type: "tool_use",
        id: te.tool_id,
        name: te.tool_name,
        input: {},
      });
    }
    messages.push({
      role: "assistant",
      content: assistantContent as unknown as Anthropic.Messages.ContentBlockParam[],
    });

    // Execute each tool call; yield emitted events in insertion order.
    const toolResults: ContentBlockParam[] = [];
    for (const tc of queuedTools) {
      const outcome = await executeTool({
        tc,
        opts,
        now,
        state,
        readCache,
        permService,
        subagents,
        sessionHandle,
        ...(opts.skillRegistry !== undefined ? { skillRegistry: opts.skillRegistry } : {}),
      });
      for (const ev of outcome.events) yield ev;
      toolResults.push(outcome.result);
    }
    for (const te of adapterToolErrors) {
      toolResults.push(errorResult(te.tool_id, `${te.code}: ${te.message}`));
    }

    messages.push({
      role: "user",
      content: toolResults as unknown as Anthropic.Messages.ContentBlockParam[],
    });
  }

  yield {
    type: "session.error",
    session_id: opts.sessionId,
    ts: now(),
    seq: state.seq++,
    code: "max_turns_exceeded",
    message: `exceeded maxTurns=${maxTurns}`,
    recoverable: false,
  };
}

// ---------------------------------------------------------------------------
// Per-tool-call pipeline
// ---------------------------------------------------------------------------

interface ExecuteToolArgs {
  readonly tc: Extract<AgentEvent, { type: "tool.called" }>;
  readonly opts: AgentLoopOptions;
  readonly now: () => number;
  readonly state: ReturnType<typeof createAdapterState>;
  readonly readCache: Set<string>;
  readonly permService: PermissionService;
  readonly subagents: SubagentService;
  readonly sessionHandle: SessionHandle;
  readonly skillRegistry?: SkillRegistry;
}

async function executeTool(args: ExecuteToolArgs): Promise<ToolExecutionOutcome> {
  const events: AgentEvent[] = [];
  const { tc, opts, now, state } = args;
  const { tool_id, tool_name } = tc;
  let toolInput: Readonly<Record<string, unknown>> = isPlainObject(tc.input) ? tc.input : {};

  // 0. Tool filter check (T2-09).
  // Before any hooks, verify the tool is enabled by the filter.
  if (opts.toolFilter !== undefined && !isToolEnabled(tool_name, opts.toolFilter)) {
    events.push({
      type: "tool.error",
      session_id: opts.sessionId,
      ts: now(),
      seq: state.seq++,
      tool_id,
      tool_name,
      code: "tool_not_enabled",
      message: `${tool_name} is disabled for this session`,
    });
    return {
      events,
      result: {
        type: "tool_result",
        tool_use_id: tool_id,
        content: `Error: ${tool_name} is disabled for this session`,
        is_error: true,
      },
    };
  }

  // 1. PreToolUse hook.
  const preEvent: HookEvent = {
    kind: "PreToolUse",
    payload: {
      sessionId: opts.sessionId,
      toolName: tool_name,
      toolInput,
      callId: tool_id,
    },
  };
  try {
    const hookResult = await runHooks({
      event: preEvent,
      sessionId: opts.sessionId,
      hooks: opts.hooks.hooksFor(preEvent),
      logger: opts.logger,
    });
    if (hookResult.decision === "deny") {
      const reason = hookResult.reason ?? "hook denied";
      events.push({
        type: "tool.error",
        session_id: opts.sessionId,
        ts: now(),
        seq: state.seq++,
        tool_id,
        tool_name,
        code: "hook_denied",
        message: reason,
      });
      return { events, result: errorResult(tool_id, `hook denied: ${reason}`) };
    }
    if (hookResult.decision === "modify" && hookResult.modified) {
      toolInput = hookResult.modified.toolInput;
    }
  } catch (err) {
    opts.logger.warn({ err, tool_name }, "pre-tool-hook error (treating as neutral)");
  }

  // 2. Permission gate.
  const callId = `req_${tool_id}`;
  const call: ToolCall = { name: tool_name, input: toolInput };
  events.push({
    type: "permission.requested",
    session_id: opts.sessionId,
    ts: now(),
    seq: state.seq++,
    request_id: callId,
    tool_name,
    reason: `tool.use ${tool_name}`,
    input_preview: toolInput,
  });

  let permDecision: "allow" | "deny" | "ask";
  try {
    permDecision = await decide({
      call,
      permissions: opts.permissions,
      sessionId: opts.sessionId,
      ...(opts.askHandler !== undefined ? { askHandler: opts.askHandler } : {}),
      audit: () => {
        /* engine-level audit wired in Phase 10+ */
      },
      logger: opts.logger,
    });
  } catch (err) {
    opts.logger.warn({ err, tool_name }, "permission decide() threw — treating as deny");
    permDecision = "deny";
  }

  if (permDecision !== "allow") {
    events.push({
      type: "permission.denied",
      session_id: opts.sessionId,
      ts: now(),
      seq: state.seq++,
      request_id: callId,
      denied_by: permDecision === "ask" ? "auto" : "policy",
      reason: `permission ${permDecision}`,
    });
    events.push({
      type: "tool.error",
      session_id: opts.sessionId,
      ts: now(),
      seq: state.seq++,
      tool_id,
      tool_name,
      code: "permission_denied",
      message: `permission ${permDecision}`,
    });
    return { events, result: errorResult(tool_id, `permission ${permDecision}`) };
  }

  events.push({
    type: "permission.granted",
    session_id: opts.sessionId,
    ts: now(),
    seq: state.seq++,
    request_id: callId,
    scope: "once",
    granted_by: "policy",
  });

  // 3. MCP tool dispatch — if tool_name starts with "mcp__" and registry is present.
  if (tool_name.startsWith("mcp__") && opts.mcp !== undefined) {
    return executeMcpTool({
      tc,
      opts,
      now,
      state,
      toolInput,
      events,
    });
  }

  // 4. Resolve builtin tool + validate input.
  // Handle Skill tool separately since it's dynamically created with a registry.
  let tool = getTool(tool_name);
  if (!tool && tool_name === "Skill" && args.skillRegistry !== undefined) {
    tool = createSkillTool(args.skillRegistry);
  }
  if (!tool) {
    events.push({
      type: "tool.error",
      session_id: opts.sessionId,
      ts: now(),
      seq: state.seq++,
      tool_id,
      tool_name,
      code: "unknown_tool",
      message: `no tool registered with name ${tool_name}`,
    });
    return { events, result: errorResult(tool_id, `unknown tool ${tool_name}`) };
  }

  const parsed = tool.zodSchema.safeParse(toolInput);
  if (!parsed.success) {
    const message = parsed.error instanceof z.ZodError ? parsed.error.message : "invalid input";
    events.push({
      type: "tool.error",
      session_id: opts.sessionId,
      ts: now(),
      seq: state.seq++,
      tool_id,
      tool_name,
      code: "invalid_input",
      message,
    });
    return { events, result: errorResult(tool_id, message) };
  }

  // 4. Handler.
  const ctx: ToolContext = {
    cwd: opts.cwd,
    ...(opts.additionalRoots !== undefined ? { additionalRoots: opts.additionalRoots } : {}),
    sessionId: opts.sessionId,
    readCache: args.readCache,
    abort: opts.signal,
    logger: opts.logger,
    permissions: args.permService,
    subagents: args.subagents,
    session: args.sessionHandle,
  };

  const start = now();
  let output: unknown;
  try {
    output = await tool.handler(parsed.data, ctx);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code =
      err && typeof err === "object" && "code" in err && typeof err.code === "string"
        ? err.code
        : "tool_error";
    events.push({
      type: "tool.error",
      session_id: opts.sessionId,
      ts: now(),
      seq: state.seq++,
      tool_id,
      tool_name,
      code,
      message,
    });
    return { events, result: errorResult(tool_id, message) };
  }

  const duration_ms = now() - start;
  const stringified = stringifyResult(output);

  // Build tool.result event, conditionally including truncation fields.
  const toolResultEvent: AgentEvent = stringified.truncated
    ? {
        type: "tool.result",
        session_id: opts.sessionId,
        ts: now(),
        seq: state.seq++,
        tool_id,
        tool_name,
        output,
        duration_ms,
        truncated: true,
        output_bytes: stringified.originalBytes,
      }
    : {
        type: "tool.result",
        session_id: opts.sessionId,
        ts: now(),
        seq: state.seq++,
        tool_id,
        tool_name,
        output,
        duration_ms,
      };
  events.push(toolResultEvent);

  // 5. PostToolUse — fire-and-forget by default.
  const postEvent: HookEvent = {
    kind: "PostToolUse",
    payload: {
      sessionId: opts.sessionId,
      toolName: tool_name,
      toolInput,
      toolResult: output,
      callId: tool_id,
      durationMs: duration_ms,
    },
  };
  runHooks({
    event: postEvent,
    sessionId: opts.sessionId,
    hooks: opts.hooks.hooksFor(postEvent),
    logger: opts.logger,
  }).catch((err) => opts.logger.warn({ err, tool_name }, "post-tool-hook error (ignored)"));

  return {
    events,
    result: {
      type: "tool_result",
      tool_use_id: tool_id,
      content: stringified.content,
    },
  };
}

// ---------------------------------------------------------------------------
// MCP tool dispatch
// ---------------------------------------------------------------------------

interface ExecuteMcpToolArgs {
  readonly tc: Extract<AgentEvent, { type: "tool.called" }>;
  readonly opts: AgentLoopOptions;
  readonly now: () => number;
  readonly state: ReturnType<typeof createAdapterState>;
  readonly toolInput: Readonly<Record<string, unknown>>;
  readonly events: AgentEvent[];
}

/**
 * Execute an MCP tool via the registry. Called when `tool_name.startsWith("mcp__")`
 * and `opts.mcp` is defined. The PreToolUse hook and permission gate have already
 * run — this function handles the actual call and result mapping.
 */
async function executeMcpTool(args: ExecuteMcpToolArgs): Promise<ToolExecutionOutcome> {
  const { tc, opts, now, state, toolInput, events } = args;
  const { tool_id, tool_name } = tc;
  const mcp = opts.mcp;

  // Guard: mcp should always be defined here (caller checked), but TypeScript
  // needs reassurance.
  if (mcp === undefined) {
    events.push({
      type: "tool.error",
      session_id: opts.sessionId,
      ts: now(),
      seq: state.seq++,
      tool_id,
      tool_name,
      code: "mcp_not_configured",
      message: "MCP registry not configured",
    });
    return { events, result: errorResult(tool_id, "MCP registry not configured") };
  }

  const start = now();
  let result: McpCallToolResult;
  try {
    result = await mcp.callTool(tool_name, toolInput);
  } catch (err) {
    // Map MCP errors to tool.error events.
    const isMcpError =
      err instanceof Error &&
      (err.name === "McpUnknownServerError" || err.name === "McpNotReadyError");
    const code = isMcpError ? err.name : "mcp_error";
    const message = err instanceof Error ? err.message : String(err);

    events.push({
      type: "tool.error",
      session_id: opts.sessionId,
      ts: now(),
      seq: state.seq++,
      tool_id,
      tool_name,
      code,
      message,
    });
    return { events, result: errorResult(tool_id, message) };
  }

  const duration_ms = now() - start;

  // If the MCP server returned isError:true, treat as error.
  if (result.isError) {
    const message = mcpResultToString(result);
    events.push({
      type: "tool.error",
      session_id: opts.sessionId,
      ts: now(),
      seq: state.seq++,
      tool_id,
      tool_name,
      code: "mcp_tool_error",
      message,
    });
    return { events, result: errorResult(tool_id, message) };
  }

  // Success path: convert MCP result to string and apply byte cap (T1-01).
  const output = mcpResultToString(result);
  const stringified = stringifyResult(output);

  const toolResultEvent: AgentEvent = stringified.truncated
    ? {
        type: "tool.result",
        session_id: opts.sessionId,
        ts: now(),
        seq: state.seq++,
        tool_id,
        tool_name,
        output,
        duration_ms,
        truncated: true,
        output_bytes: stringified.originalBytes,
      }
    : {
        type: "tool.result",
        session_id: opts.sessionId,
        ts: now(),
        seq: state.seq++,
        tool_id,
        tool_name,
        output,
        duration_ms,
      };
  events.push(toolResultEvent);

  // Fire PostToolUse hook (fire-and-forget).
  const postEvent: HookEvent = {
    kind: "PostToolUse",
    payload: {
      sessionId: opts.sessionId,
      toolName: tool_name,
      toolInput,
      toolResult: output,
      callId: tool_id,
      durationMs: duration_ms,
    },
  };
  runHooks({
    event: postEvent,
    sessionId: opts.sessionId,
    hooks: opts.hooks.hooksFor(postEvent),
    logger: opts.logger,
  }).catch((err) => opts.logger.warn({ err, tool_name }, "post-tool-hook error (ignored)"));

  return {
    events,
    result: {
      type: "tool_result",
      tool_use_id: tool_id,
      content: stringified.content,
    },
  };
}

/**
 * Convert an MCP call result to a string for the model. Concatenates text
 * content blocks; non-text blocks are summarized.
 */
function mcpResultToString(result: McpCallToolResult): string {
  const parts: string[] = [];
  for (const block of result.content) {
    if (block.type === "text" && "text" in block && typeof block.text === "string") {
      parts.push(block.text);
    } else if (
      block.type === "image" &&
      "mimeType" in block &&
      typeof block.mimeType === "string"
    ) {
      parts.push(`[image: ${block.mimeType}]`);
    } else if (block.type === "resource" && "resource" in block) {
      parts.push(`[resource: ${JSON.stringify(block.resource)}]`);
    } else {
      parts.push(`[${block.type}]`);
    }
  }
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function errorResult(tool_use_id: string, message: string): ContentBlockParam {
  return {
    type: "tool_result",
    tool_use_id,
    content: message,
    is_error: true,
  };
}

function abortedEvent(
  sessionId: string,
  now: number,
  state: ReturnType<typeof createAdapterState>,
): AgentEvent {
  return {
    type: "session.error",
    session_id: sessionId,
    ts: now,
    seq: state.seq++,
    code: "aborted",
    message: "aborted",
    recoverable: false,
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

interface StringifyOutput {
  readonly content: string;
  readonly truncated: boolean;
  readonly originalBytes: number;
}

function stringifyResult(value: unknown): StringifyOutput {
  let raw: string;
  if (typeof value === "string") {
    raw = value;
  } else {
    try {
      raw = JSON.stringify(value);
    } catch {
      raw = String(value);
    }
  }

  const originalBytes = Buffer.byteLength(raw, "utf8");
  if (originalBytes <= MAX_TOOL_RESULT_BYTES) {
    return { content: raw, truncated: false, originalBytes };
  }

  // Truncate to MAX_TOOL_RESULT_BYTES while respecting UTF-8 boundaries.
  // Buffer.from().subarray().toString() handles partial codepoint trim.
  const truncatedContent = Buffer.from(raw, "utf8")
    .subarray(0, MAX_TOOL_RESULT_BYTES)
    .toString("utf8");
  const elidedBytes = originalBytes - Buffer.byteLength(truncatedContent, "utf8");
  const content = `${truncatedContent}\n\n[... ${elidedBytes} more bytes elided ...]`;

  return { content, truncated: true, originalBytes };
}

function toolsAsProviderTools(
  mcp?: McpRegistry,
  skillRegistry?: SkillRegistry,
  filter?: ToolFilter,
): Anthropic.Messages.Tool[] {
  // Builtin tools first, with optional Skill tool when skills exist.
  const builtins = buildToolList(skillRegistry).map(
    (t) =>
      ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      }) as unknown as Anthropic.Messages.Tool,
  );

  // Append MCP tools when a registry is provided.
  let allTools: Anthropic.Messages.Tool[];
  if (mcp === undefined) {
    allTools = builtins;
  } else {
    const mcpTools = mcp.listTools().map(
      (t) =>
        ({
          name: t.namespacedName,
          description: t.description ?? "",
          input_schema: t.inputSchema,
        }) as unknown as Anthropic.Messages.Tool,
    );
    allTools = [...builtins, ...mcpTools];
  }

  // Apply tool filter (T2-09).
  if (filter !== undefined) {
    return applyToolFilter(allTools, filter) as Anthropic.Messages.Tool[];
  }
  return allTools;
}

function defaultNow(): number {
  return Date.now();
}

function mapProviderError(err: unknown): { code: string; message: string } {
  if (err instanceof APIError) {
    return {
      code: err.status !== undefined ? String(err.status) : "provider_error",
      message: err.message,
    };
  }
  if (err instanceof Error) {
    return { code: "provider_error", message: err.message };
  }
  return { code: "provider_error", message: String(err) };
}

/**
 * A "feature disabled" subagent service that returns an error result without
 * throwing. Used when no subagent dispatcher is configured (e.g. the Task tool
 * is called but the CLI didn't wire in a real dispatcher).
 */
const disabledSubagentService: SubagentService = {
  // biome-ignore lint/suspicious/useAwait: async contract required by interface
  async dispatch() {
    return {
      summary: "subagents_disabled: Task tool is not available in this configuration",
      status: "error" as const,
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  },
};
