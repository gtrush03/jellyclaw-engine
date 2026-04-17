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
  // Discriminate: UiAction has `kind` but no `type`; AgentEvent has `type`.
  // Note: monitor.started has both `kind` and `type`, so check for `type` first.
  if ("type" in input) {
    return reduceAgentEvent(state, input as AgentEvent);
  }
  return reduceUiAction(state, input as UiAction);
}

// ---------------------------------------------------------------------------
// AgentEvent dispatch
// ---------------------------------------------------------------------------

function reduceAgentEvent(state: UiState, event: AgentEvent): UiState {
  // Seq-based dedupe: drop any event we've already processed for this session.
  // Guards against SSE reconnects replaying from seq 0 without a Last-Event-Id.
  const sameSession =
    state.sessionId !== null &&
    "session_id" in event &&
    (event as { session_id?: unknown }).session_id === state.sessionId;
  if (
    sameSession &&
    event.type !== "session.started" &&
    "seq" in event &&
    typeof (event as { seq?: unknown }).seq === "number" &&
    (event as { seq: number }).seq <= state.lastSeenSeq
  ) {
    return state;
  }
  const next = reduceAgentEventInner(state, event);
  if ("seq" in event && typeof (event as { seq?: unknown }).seq === "number") {
    const s = (event as { seq: number }).seq;
    if (event.type === "session.started") {
      return { ...next, lastSeenSeq: s };
    }
    if (sameSession && s > state.lastSeenSeq) {
      return { ...next, lastSeenSeq: s };
    }
  }
  return next;
}

function reduceAgentEventInner(state: UiState, event: AgentEvent): UiState {
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
        // Reset dedupe counter if this is a new session.
        ...(state.sessionId !== event.session_id ? { lastSeenSeq: -1 } : {}),
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

    // Team events (T4-03) — not rendered in TUI.
    case "team.created":
    case "team.member.started":
    case "team.member.result":
    case "team.deleted":
      return state;

    // Monitor events (T4-04) — not rendered in TUI.
    case "monitor.started":
    case "monitor.event":
    case "monitor.stopped":
      return state;

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

    case "clear-transcript":
      return {
        ...state,
        items: [],
        errorMessage: null,
        ...(state.status === "error" ? { status: "idle" as const } : {}),
      };

    case "new-session":
      return {
        ...state,
        sessionId: null,
        runId: null,
        items: [],
        status: "idle",
        pendingPermission: null,
        errorMessage: null,
        lastSeenSeq: -1,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: 0,
        },
      };

    case "set-model":
      return { ...state, currentModel: action.model };

    case "system-message": {
      const msg: TextMessage = {
        kind: "text",
        id: action.id,
        role: "system",
        text: action.text,
        done: true,
      };
      return { ...state, items: appendItem(state.items, msg) };
    }

    case "open-modal":
      return { ...state, modal: action.modal };

    case "close-modal":
      return { ...state, modal: null };

    case "connection-lost":
      return {
        ...state,
        connection: { kind: "disconnected", reason: action.reason },
      };

    case "reconnecting":
      return {
        ...state,
        connection: {
          kind: "reconnecting",
          attempt: action.attempt,
          nextRetryMs: action.nextRetryMs,
        },
      };

    case "connection-restored": {
      const reconnectedMsg: TextMessage = {
        kind: "text",
        id: `reconnected-${Date.now().toString(36)}`,
        role: "system",
        text: "\u2713 reconnected",
        done: true,
      };
      return {
        ...state,
        connection: { kind: "connected" },
        items: appendItem(state.items, reconnectedMsg),
      };
    }

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
