/**
 * Phase 10.03 — the public library-surface types for `@jellyclaw/engine`.
 *
 * This file is the boundary between what library consumers see and what lives
 * internally. If a consumer needs a type, re-export it here (type-only), never
 * deep-import from `engine/src/events.ts`, `session/types.ts`, etc.
 *
 * Rules:
 *   1. Type-only. No runtime code.
 *   2. Every export below is stable across 10.03 → Genie Phase-12 migration.
 *      Breaking changes require a major version bump + note in docs/library.md.
 *   3. Re-exports use `export type { X } from "..."` — preserves tree-shaking.
 *   4. No `any`. No `unknown` without a narrowing explanation in comments.
 */

import type { AgentEvent } from "./events.js";

// ---------------------------------------------------------------------------
// Core event stream — AgentEvent is the 15-variant discriminated union defined
// in `events.ts`; we expose it under the consumer-friendly alias `EngineEvent`.
// ---------------------------------------------------------------------------

export type { AgentEvent as EngineEvent, Usage } from "./events.js";

/**
 * `message_start` / `text_delta` / `tool_use` / `tool_result` / `message_stop`
 * / `session.started` / `session.completed` / `usage.updated` / `permission.ask`
 * / `hook.audit` / `agent.message` / `subagent.start` / `subagent.end` /
 * `error` / `cancelled` — see `events.ts` for the authoritative union.
 *
 * Exported as a string-literal type for narrowing when consumers don't want
 * the whole discriminated union in scope.
 */
export type EngineEventKind = AgentEvent["type"];

// ---------------------------------------------------------------------------
// Config — consumers can pass a partial or the whole thing; loaders resolve
// defaults + env vars.
// ---------------------------------------------------------------------------

export type {
  JellyclawConfig as EngineConfig,
  ProviderConfig,
  ProviderName,
  AnthropicProviderConfig,
  OpenRouterProviderConfig,
  LoggerConfig,
  McpServerConfig,
  PermissionPolicy,
  OAuthConfig,
} from "./config.js";

// ---------------------------------------------------------------------------
// Permissions + hooks — the enums consumers need for policy wiring.
// ---------------------------------------------------------------------------

export type { PermissionMode, PermissionRule, PermissionDecision } from "./permissions/types.js";
export type {
  HookEventKind as HookEvent,
  HookConfig,
  HookOutcome,
  HookRunResult,
} from "./hooks/types.js";

// ---------------------------------------------------------------------------
// Subsystem entities — re-exported so consumers introspecting registries get
// typed shapes without deep imports.
// ---------------------------------------------------------------------------

export type { Skill, SkillSource } from "./skills/types.js";
export type { Agent } from "./agents/types.js";
export type { McpTool } from "./mcp/types.js";

// ---------------------------------------------------------------------------
// Session surface — everything a consumer might query about persistence.
// ---------------------------------------------------------------------------

export type {
  SessionMeta as SessionSummary,
  CumulativeUsage,
  EngineState,
  ReplayedMessage,
  ReplayedToolCall,
} from "./session/types.js";

// ---------------------------------------------------------------------------
// Engine-specific public types — these live in engine.ts / create-engine.ts
// once Agent A lands them. Declared here so consumers import a single module.
// ---------------------------------------------------------------------------

/**
 * Everything a consumer can pass to `createEngine()`. All fields optional —
 * sensible defaults come from `loadConfig()` (file on disk) and env vars.
 *
 * Phase 10.03 locks this shape; additions are non-breaking, removals are not
 * allowed without a major version bump.
 */
export interface EngineOptions {
  /** Inline config. Takes priority over `configPath` + env. */
  readonly config?: Partial<EngineOptionsConfig>;
  /** Path to a `jellyclaw.json` file. Overridden by `config`. */
  readonly configPath?: string;
  /** Working directory — defaults to `process.cwd()`. */
  readonly cwd?: string;
  /**
   * Optional logger override. Defaults to the engine's internal pino logger
   * with secrets redacted. Library consumers wanting to unify with their own
   * logger should pass an object conforming to `Logger` from pino.
   */
  readonly logger?: unknown; // pino.Logger — intentionally loose to avoid dep
  /**
   * Inject a provider for testing. When present, skips the real provider
   * construction. Useful for consumer tests that don't want to hit the API.
   *
   * Shape: `{ name: "anthropic" | "openrouter"; stream(...); }`.
   */
  readonly providerOverride?: unknown;
}

/**
 * The config subset callers can pass inline. Mirrors `JellyclawConfig` but
 * with a lighter touch — we keep full validation in the loader.
 */
export interface EngineOptionsConfig {
  readonly provider?: string | { readonly type: string; readonly [key: string]: unknown };
  readonly model?: string;
  readonly cwd?: string;
  readonly permissions?: unknown;
  readonly mcp?: readonly unknown[];
  readonly hooks?: unknown;
  readonly logger?: { readonly level?: string; readonly pretty?: boolean };
  readonly [key: string]: unknown;
}

/**
 * A single `run()` invocation. `prompt` OR `sessionId` (resume path) must be set.
 */
export interface RunInput {
  readonly prompt?: string;
  /** Resume an existing session by id. If set without `prompt`, the engine continues latest turn. */
  readonly sessionId?: string;
  /** Idempotency key — see Phase 09 WishLedger. Same wishId → cached result. */
  readonly wishId?: string;
  /** Per-run overrides. */
  readonly model?: string;
  readonly maxTurns?: number;
  readonly permissionMode?: import("./permissions/types.js").PermissionMode;
  readonly appendSystemPrompt?: string;
  readonly allowedTools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly addDirs?: readonly string[];
  readonly cwd?: string;
  /** External abort signal — tripping this cancels the run. */
  readonly signal?: AbortSignal;
}

/**
 * The object returned by `engine.run()`. It is simultaneously:
 *   - an `AsyncIterable<EngineEvent>` (for `for await` consumers)
 *   - a structured handle (`id`, `sessionId`, `cancel`, `resume`)
 *
 * `sessionId` resolves SYNCHRONOUSLY at `run()` call time — consumers can
 * subscribe to the session through other channels (HTTP SSE, tail the JSONL)
 * without waiting for the first event.
 */
export interface RunHandle extends AsyncIterable<import("./events.js").AgentEvent> {
  readonly id: string;
  readonly sessionId: string;
  cancel(): void;
  resume(prompt: string): RunHandle;
}

/**
 * Error thrown by `engine.run()` / `engine.dispose()` / subsystem constructors
 * when invariants are violated. All inherit from `Error` and carry a stable
 * `name` discriminant for pattern matching.
 */
export interface EngineError extends Error {
  readonly name: string;
}
