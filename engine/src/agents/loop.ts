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
import { decide } from "../permissions/engine.js";
import type { AskHandler, CompiledPermissions, ToolCall } from "../permissions/types.js";
import { adaptChunk, adaptDone, createAdapterState } from "../providers/adapter.js";
import type { Provider, ProviderRequest, SystemBlock } from "../providers/types.js";
import { stubSubagentService } from "../subagents/stub.js";
import type { SubagentService } from "../subagents/types.js";
import { getTool, listTools } from "../tools/index.js";
import { makePermissionService, type PermissionService, type ToolContext } from "../tools/types.js";

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
  /** Model max_tokens per turn. Default 4096. */
  readonly maxOutputTokens?: number;
  /** Clock injection per CLAUDE.md §6. Default `Date.now`. */
  readonly now?: () => number;
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
  const maxTurns = opts.maxTurns ?? 25;
  const maxOutputTokens = opts.maxOutputTokens ?? 4096;
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
  const subagents = opts.subagents ?? stubSubagentService;

  const system: SystemBlock[] =
    opts.systemPrompt !== undefined && opts.systemPrompt.length > 0
      ? [{ type: "text", text: opts.systemPrompt }]
      : [];
  const tools = toolsAsProviderTools();
  const messages: Anthropic.Messages.MessageParam[] = [
    ...(opts.priorMessages ?? []).map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: opts.prompt },
  ];

  for (let turn = 1; turn <= maxTurns; turn++) {
    if (opts.signal.aborted) {
      yield abortedEvent(opts.sessionId, now(), state);
      return;
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
              code: "budget_exceeded",
              message: `cost_usd ${ev.cost_usd} exceeded maxBudgetUsd ${opts.maxBudgetUsd}`,
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
}

async function executeTool(args: ExecuteToolArgs): Promise<ToolExecutionOutcome> {
  const events: AgentEvent[] = [];
  const { tc, opts, now, state } = args;
  const { tool_id, tool_name } = tc;
  let toolInput: Readonly<Record<string, unknown>> = isPlainObject(tc.input) ? tc.input : {};

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

  // 3. Resolve tool + validate input.
  const tool = getTool(tool_name);
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
    sessionId: opts.sessionId,
    readCache: args.readCache,
    abort: opts.signal,
    logger: opts.logger,
    permissions: args.permService,
    subagents: args.subagents,
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
  events.push({
    type: "tool.result",
    session_id: opts.sessionId,
    ts: now(),
    seq: state.seq++,
    tool_id,
    tool_name,
    output,
    duration_ms,
  });

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
      content: stringifyResult(output),
    },
  };
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

function stringifyResult(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function toolsAsProviderTools(): Anthropic.Messages.Tool[] {
  return listTools().map(
    (t) =>
      ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      }) as unknown as Anthropic.Messages.Tool,
  );
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
