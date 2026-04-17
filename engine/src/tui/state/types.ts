/**
 * Phase 99-06 — UI state shape consumed by every Ink component.
 *
 * Pure data. No React, no Ink imports. The reducer in `./reducer.ts` produces
 * values of type `UiState`; components render from a `UiState` slice.
 *
 * Contract frozen here so components (Agent B), auth flow (Agent C), and the
 * integrator (Agent D) can code against the same shape while the reducer
 * (Agent A) is built in parallel.
 */

export type TranscriptRole = "user" | "assistant" | "system";

export interface TextMessage {
  readonly kind: "text";
  readonly id: string;
  readonly role: TranscriptRole;
  readonly text: string;
  /** True once the model marked its final delta. */
  readonly done: boolean;
}

export type ToolCallStatus = "pending" | "ok" | "error";

export interface ToolCallMessage {
  readonly kind: "tool";
  readonly id: string;
  /** `tool_id` from the engine event stream. */
  readonly toolId: string;
  readonly toolName: string;
  readonly input: unknown;
  readonly output?: unknown;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly durationMs?: number;
  readonly status: ToolCallStatus;
}

export interface ErrorMessage {
  readonly kind: "error";
  readonly id: string;
  readonly code: string;
  readonly message: string;
}

export type TranscriptItem = TextMessage | ToolCallMessage | ErrorMessage;

export interface PendingPermission {
  readonly requestId: string;
  readonly toolName: string;
  readonly reason: string;
  readonly inputPreview: unknown;
}

export interface UiUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly costUsd: number;
}

export type UiStatus = "idle" | "streaming" | "awaiting-permission" | "error";

export type UiModalKind = "api-key" | null;

export type UiConnection =
  | { readonly kind: "connected" }
  | { readonly kind: "reconnecting"; readonly attempt: number; readonly nextRetryMs: number }
  | { readonly kind: "disconnected"; readonly reason: string };

export interface UiState {
  readonly sessionId: string | null;
  readonly runId: string | null;
  readonly model: string;
  readonly provider: "anthropic" | "openrouter" | null;
  readonly cwd: string;
  readonly items: readonly TranscriptItem[];
  readonly status: UiStatus;
  readonly pendingPermission: PendingPermission | null;
  readonly modal: UiModalKind;
  readonly connection: UiConnection;
  readonly usage: UiUsage;
  readonly errorMessage: string | null;
  /** Monotonic counter used as a tick for the animated spinner. */
  readonly tick: number;
  /**
   * Highest `seq` already processed for the current `sessionId`. Used to
   * drop replayed events (e.g., when an SSE reconnect starts from seq 0
   * without a Last-Event-Id), which would otherwise duplicate every prior
   * message in the transcript in a cascading 1×,2×,3×… pattern.
   */
  readonly lastSeenSeq: number;
  /**
   * User-selected model override (set via `/model <name>`). Forwarded to
   * `createRun` as the `model` field when non-empty. Empty string = let the
   * server pick its default.
   */
  readonly currentModel: string;
}

export function createInitialState(overrides: Partial<UiState> = {}): UiState {
  return {
    sessionId: null,
    runId: null,
    model: "",
    provider: null,
    cwd: "",
    items: [],
    status: "idle",
    pendingPermission: null,
    modal: null,
    connection: { kind: "connected" },
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
    },
    errorMessage: null,
    tick: 0,
    lastSeenSeq: -1,
    currentModel: "",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Reducer-produced actions for UI-originated events (not from SSE).
// ---------------------------------------------------------------------------

export type UiAction =
  | { readonly kind: "user-prompt"; readonly text: string; readonly id: string }
  | { readonly kind: "run-started"; readonly runId: string; readonly sessionId: string }
  | { readonly kind: "run-cancelled" }
  | { readonly kind: "tick" }
  | { readonly kind: "clear-error" }
  | { readonly kind: "clear-transcript" }
  | { readonly kind: "new-session" }
  | { readonly kind: "set-model"; readonly model: string }
  | { readonly kind: "system-message"; readonly id: string; readonly text: string }
  | { readonly kind: "open-modal"; readonly modal: Exclude<UiModalKind, null> }
  | { readonly kind: "close-modal" }
  | { readonly kind: "connection-lost"; readonly reason: string }
  | { readonly kind: "reconnecting"; readonly attempt: number; readonly nextRetryMs: number }
  | { readonly kind: "connection-restored" };
