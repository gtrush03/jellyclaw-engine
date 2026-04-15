/**
 * Phase 99-06 — pure reducer for the Ink TUI.
 *
 * `reduce(state, event | action)` consumes either an `AgentEvent` from the
 * jellyclaw SSE stream or a UI-originated `UiAction`, and returns a new
 * `UiState`. No I/O, no React, no mutation of input state.
 *
 * Frozen contract — reducer semantics are documented in
 * `phases/PHASE-99-06-tui.md`. Components should code against the resulting
 * `UiState` shape and never call this reducer directly outside the
 * `useReducer` instance owned by `<App />`.
 */

import type { AgentEvent } from "../../events.js";
import type {
  ErrorMessage,
  TextMessage,
  ToolCallMessage,
  TranscriptItem,
  UiAction,
  UiState,
} from "./types.js";

export type ReducerInput = AgentEvent | UiAction;

/**
 * Pure reducer. Accepts either an `AgentEvent` (discriminated by `type`) or a
 * `UiAction` (discriminated by `kind`). Returns a new `UiState` for any
 * change, the same reference for ignored events.
 */
export function reduce(state: UiState, input: ReducerInput): UiState {
  if ("kind" in input) {
    return reduceUiAction(state, input);
  }
  return reduceAgentEvent(state, input);
}

// ---------------------------------------------------------------------------
// AgentEvent dispatch
// ---------------------------------------------------------------------------

function reduceAgentEvent(state: UiState, event: AgentEvent): UiState {
  switch (event.type) {
    case "session.started":
      return {
        ...state,
        sessionId: event.session_id,
        model: event.model,
        provider: event.provider,
        cwd: event.cwd,
        status: "streaming",
        errorMessage: null,
      };

    case "session.completed": {
      const items =
        event.summary !== undefined && event.summary.length > 0
          ? appendItem(state.items, {
              kind: "text",
              id: `summary-${event.session_id}-${event.seq}`,
              role: "system",
              text: event.summary,
              done: true,
            })
          : state.items;
      return { ...state, status: "idle", items };
    }

    case "session.error": {
      const errorItem: ErrorMessage = {
        kind: "error",
        id: `error-${event.session_id}-${event.seq}`,
        code: event.code,
        message: event.message,
      };
      return {
        ...state,
        status: "error",
        errorMessage: event.message,
        items: appendItem(state.items, errorItem),
        ...(event.recoverable === false ? { runId: null } : {}),
      };
    }

    case "agent.thinking":
      // IGNORE — extended thinking blocks are not rendered in Phase 99-06.
      return state;

    case "agent.message":
      return mergeAgentMessage(state, event.delta, event.final, event.seq);

    case "tool.called": {
      // Dedup by tool_id — if a tool.called is replayed, leave the existing
      // entry alone.
      if (state.items.some((it) => it.kind === "tool" && it.toolId === event.tool_id)) {
        return state;
      }
      const tool: ToolCallMessage = {
        kind: "tool",
        id: event.tool_id,
        toolId: event.tool_id,
        toolName: event.tool_name,
        input: event.input,
        status: "pending",
      };
      return { ...state, items: appendItem(state.items, tool) };
    }

    case "tool.result":
      return patchTool(state, event.tool_id, (t) => ({
        ...t,
        status: "ok",
        output: event.output,
        durationMs: event.duration_ms,
      }));

    case "tool.error":
      return patchTool(state, event.tool_id, (t) => ({
        ...t,
        status: "error",
        errorCode: event.code,
        errorMessage: event.message,
      }));

    case "permission.requested":
      return {
        ...state,
        pendingPermission: {
          requestId: event.request_id,
          toolName: event.tool_name,
          reason: event.reason,
          inputPreview: event.input_preview,
        },
        status: "awaiting-permission",
      };

    case "permission.granted":
    case "permission.denied":
      if (
        state.pendingPermission === null ||
        state.pendingPermission.requestId !== event.request_id
      ) {
        return state;
      }
      return { ...state, pendingPermission: null, status: "streaming" };

    case "subagent.spawned":
    case "subagent.returned":
      // Out of Phase 99-06 scope.
      return state;

    case "usage.updated":
      return {
        ...state,
        usage: {
          inputTokens: event.input_tokens,
          outputTokens: event.output_tokens,
          cacheReadTokens: event.cache_read_tokens,
          cacheWriteTokens: event.cache_write_tokens,
          costUsd: event.cost_usd ?? state.usage.costUsd,
        },
      };

    case "stream.ping":
      return { ...state, tick: state.tick + 1 };

    default:
      // Defensive fallthrough — should be unreachable since AgentEvent is a
      // discriminated union validated upstream by zod.
      return state;
  }
}

// ---------------------------------------------------------------------------
// UiAction dispatch
// ---------------------------------------------------------------------------

function reduceUiAction(state: UiState, action: UiAction): UiState {
  switch (action.kind) {
    case "user-prompt": {
      const msg: TextMessage = {
        kind: "text",
        id: action.id,
        role: "user",
        text: action.text,
        done: true,
      };
      return { ...state, items: appendItem(state.items, msg) };
    }

    case "run-started":
      return {
        ...state,
        runId: action.runId,
        sessionId: action.sessionId,
        status: "streaming",
        errorMessage: null,
      };

    case "run-cancelled":
      return { ...state, status: "idle", runId: null };

    case "tick":
      return { ...state, tick: state.tick + 1 };

    case "clear-error":
      return {
        ...state,
        errorMessage: null,
        ...(state.status === "error" ? { status: "idle" as const } : {}),
      };

    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function appendItem(
  items: readonly TranscriptItem[],
  item: TranscriptItem,
): readonly TranscriptItem[] {
  return [...items, item];
}

function patchTool(
  state: UiState,
  toolId: string,
  patch: (t: ToolCallMessage) => ToolCallMessage,
): UiState {
  const idx = state.items.findIndex((it) => it.kind === "tool" && it.toolId === toolId);
  if (idx === -1) return state;
  const existing = state.items[idx];
  if (existing === undefined || existing.kind !== "tool") return state;
  const next = patch(existing);
  const items = state.items.slice();
  items[idx] = next;
  return { ...state, items };
}

function mergeAgentMessage(state: UiState, delta: string, final: boolean, seq: number): UiState {
  const lastIdx = state.items.length - 1;
  const last = lastIdx >= 0 ? state.items[lastIdx] : undefined;
  if (
    last !== undefined &&
    last.kind === "text" &&
    last.role === "assistant" &&
    last.done === false
  ) {
    const merged: TextMessage = {
      ...last,
      text: last.text + delta,
      done: final === true ? true : last.done,
    };
    const items = state.items.slice();
    items[lastIdx] = merged;
    return { ...state, items };
  }
  const fresh: TextMessage = {
    kind: "text",
    id: `assistant-${state.sessionId ?? "anon"}-${seq}`,
    role: "assistant",
    text: delta,
    done: final === true,
  };
  return { ...state, items: appendItem(state.items, fresh) };
}
