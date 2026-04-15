/**
 * Phase 10.02 — frozen contract between RunManager (producer), route handlers
 * (consumers), auth middleware, and the `jellyclaw serve` CLI wiring.
 *
 * All three parallel agents (A: app/auth/sse/run-manager; B: routes + CLI;
 * C: docs/integration) import from this file. Do not mutate; extend additively
 * in Phase 10.03+.
 */

import type { EventEmitter } from "node:events";
import type { AgentEvent } from "../events.js";

// ---------------------------------------------------------------------------
// Server configuration (resolved from CLI flags + env before app.ts is built)
// ---------------------------------------------------------------------------

export interface ServerConfig {
  readonly host: string; // default "127.0.0.1"
  readonly port: number; // default 8765
  readonly authToken: string; // required (auto-generated if missing); never empty
  readonly corsOrigins: readonly CorsOrigin[]; // parsed from --cors
  readonly verbose: boolean;
}

/**
 * One literal exact match ("https://app.example.com") OR a localhost-any-port
 * wildcard ("http://localhost:*", "http://127.0.0.1:*"). No other wildcards.
 */
export type CorsOrigin =
  | { readonly kind: "exact"; readonly value: string }
  | { readonly kind: "localhost-wildcard"; readonly scheme: "http" | "https"; readonly host: "localhost" | "127.0.0.1" };

// ---------------------------------------------------------------------------
// RunEntry — one per POST /v1/runs, kept in RunManager
// ---------------------------------------------------------------------------

export type RunStatus = "running" | "completed" | "cancelled" | "failed";

export interface BufferedEvent {
  /**
   * Monotonic within a run. Mirrors `AgentEvent.seq` — the SSE `id:` line uses
   * this value so `Last-Event-Id` replay is deterministic across reconnects.
   */
  readonly id: number;
  readonly event: AgentEvent;
}

export interface RunEntry {
  readonly runId: string;
  readonly sessionId: string;
  readonly status: RunStatus;
  /**
   * In-memory ring buffer of the most recent events (size cap defined by
   * RunManager). When `Last-Event-Id` is beyond the buffer's floor, routes
   * must fall back to the Phase-09 JSONL replay.
   */
  readonly buffer: readonly BufferedEvent[];
  /**
   * Emitter for SSE subscribers. Event name: `"event"` with payload
   * `BufferedEvent`. Terminal event name: `"done"` payload `{ status }`.
   */
  readonly emitter: EventEmitter;
  readonly abortController: AbortController;
  /** Unix ms; non-null once status !== "running". */
  readonly completedAt: number | null;
  readonly createdAt: number;
}

// ---------------------------------------------------------------------------
// RunManager — constructed once per app, injected into routes
// ---------------------------------------------------------------------------

export interface CreateRunOptions {
  readonly prompt: string;
  readonly sessionId?: string;
  readonly model?: string;
  readonly permissionMode?: string;
  readonly maxTurns?: number;
  readonly wishId?: string;
  readonly appendSystemPrompt?: string;
  readonly allowedTools?: readonly string[];
  readonly mcpConfig?: string;
  readonly cwd?: string;
}

export interface ResumeRunOptions {
  readonly prompt: string;
}

export interface RunManagerSnapshot {
  readonly activeRuns: number;
  readonly totalRuns: number;
  readonly completedRuns: number;
}

export interface RunManager {
  create(opts: CreateRunOptions): Promise<RunEntry>;
  get(runId: string): RunEntry | undefined;
  cancel(runId: string): boolean;
  /**
   * Inject `text` as a mid-run user turn. Returns false if run not found or
   * already terminal. Routes funnel through the UserPromptSubmit hook before
   * the engine sees it.
   */
  steer(runId: string, text: string): boolean;
  resume(runId: string, opts: ResumeRunOptions): Promise<RunEntry>;
  snapshot(): RunManagerSnapshot;
  /**
   * Stop accepting new runs; await active runs up to `graceMs`; then abort.
   * Resolves once all run entries are terminal or the deadline hits.
   */
  shutdown(graceMs: number): Promise<void>;
}

// ---------------------------------------------------------------------------
// Hono variables — typed `c.get("...")` / `c.set("...")` keys
// ---------------------------------------------------------------------------

export interface AppVariables {
  readonly authenticated: true;
  readonly requestId: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class BindSafetyError extends Error {
  override readonly name = "BindSafetyError";
  constructor(message: string) {
    super(message);
  }
}

export class AuthTokenMissingError extends Error {
  override readonly name = "AuthTokenMissingError";
  constructor(message: string) {
    super(message);
  }
}

export class RunNotFoundError extends Error {
  override readonly name = "RunNotFoundError";
  constructor(runId: string) {
    super(`run not found: ${runId}`);
  }
}

export class RunTerminalError extends Error {
  override readonly name = "RunTerminalError";
  constructor(runId: string, status: RunStatus) {
    super(`run ${runId} is already ${status}`);
  }
}
