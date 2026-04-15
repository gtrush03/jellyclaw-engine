/**
 * Shared types + errors for subagent dispatch (Phase 06 Prompt 02).
 *
 * The dispatcher is split across:
 *   - `semaphore.ts` — p-limit concurrency gate
 *   - `context.ts`   — pure `buildSubagentContext` (tool intersection,
 *                      depth guard, model + skills resolution)
 *   - `dispatch.ts`  — the `SubagentDispatcher` service that wires it all
 *                      together and implements `SubagentService`
 *
 * The engine does not yet have a first-class "spawn a new OpenCode session
 * bound to this context" API — that lands later. To keep this phase
 * testable without introducing a half-built OpenCode client, dispatch is
 * parameterised on a `SessionRunner` seam. Tests inject a mock that emits
 * a scripted sequence of `Event`s; production wiring will come in Phase 09.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Default parallel-subagent cap when config omits `agents.maxConcurrency`. */
export const DEFAULT_MAX_CONCURRENCY = 3;
/** Hard ceiling — config values above this are clamped with a warn. */
export const MAX_CONCURRENCY_CEILING = 5;
/** Default nested Task depth when config omits `agents.maxDepth`. */
export const DEFAULT_MAX_DEPTH = 2;

export interface DispatchConfig {
  readonly maxConcurrency: number;
  readonly maxDepth: number;
}

export const DEFAULT_DISPATCH_CONFIG: DispatchConfig = Object.freeze({
  maxConcurrency: DEFAULT_MAX_CONCURRENCY,
  maxDepth: DEFAULT_MAX_DEPTH,
});

// ---------------------------------------------------------------------------
// Parent context + built child context
// ---------------------------------------------------------------------------

/**
 * What the dispatcher needs to know about the caller (the parent
 * session) in order to build an isolated child context.
 */
export interface ParentContext {
  readonly sessionId: string;
  /** Parent's allowed tool names (the cap — child tools intersect with this). */
  readonly allowedTools: readonly string[];
  /** Parent's active model id. Used as the fallback when the agent file does not pin one. */
  readonly model: string;
  /** Current subagent depth. Root session = 0. A subagent dispatched by a root is depth 1. */
  readonly depth: number;
  /**
   * Inherited CLAUDE.md contents. Read once at engine boot and cached; the
   * dispatcher does not re-read per call. `undefined` if no CLAUDE.md.
   */
  readonly claudeMd?: string;
}

/**
 * The fully-resolved, isolated context handed to `SessionRunner.run()`.
 * No parent transcript, no parent scratch state — only what the subagent
 * is permitted to see.
 */
export interface SubagentContext {
  readonly subagentSessionId: string;
  readonly parentSessionId: string;
  readonly agentName: string;
  readonly description: string;
  readonly prompt: string;
  /** System prompt = CLAUDE.md prefix (if any) + two blank lines + agent body. */
  readonly systemPrompt: string;
  /** Model id resolved via agent.model ?? parent.model. */
  readonly model: string;
  /** Tool allowlist after intersection with parent.allowedTools. Non-empty by construction. */
  readonly allowedTools: readonly string[];
  /** Skill names to inject; empty if agent.skills is undefined/empty. */
  readonly skills: readonly string[];
  readonly maxTurns: number;
  readonly maxTokens: number;
  /** Depth of this subagent run (parent.depth + 1). */
  readonly depth: number;
}

// ---------------------------------------------------------------------------
// SessionRunner seam — tests inject a mock
// ---------------------------------------------------------------------------

export interface SessionRunUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_creation_input_tokens?: number;
  readonly cache_read_input_tokens?: number;
}

export type RunReason = "complete" | "max_turns" | "max_tokens" | "error" | "cancelled";

export interface SessionRunResult {
  readonly summary: string;
  readonly usage: SessionRunUsage;
  readonly turns: number;
  readonly reason: RunReason;
  /** Optional error message when `reason === "error"`. */
  readonly errorMessage?: string;
}

/**
 * Abstraction over "spawn a subagent run with this isolated context and
 * stream events upstream." Production wiring lives in Phase 09 (it will
 * wrap a new OpenCode session bound to the same server). Phase 06 tests
 * supply a mock.
 *
 * Implementations MUST:
 *   - Never leak parent transcript into the child.
 *   - Forward events by calling `onEvent` synchronously in arrival order.
 *   - Honour `signal`: abort cleanly with `reason: "cancelled"`.
 *   - Enforce `maxTurns` / `maxTokens` and report via `reason`.
 *   - Return `reason: "error"` (not throw) on model/network failure.
 */
export interface SessionRunner {
  run(args: SessionRunArgs): Promise<SessionRunResult>;
}

export interface SessionRunArgs {
  readonly context: SubagentContext;
  readonly signal: AbortSignal;
  /** Synchronous event sink. Every emitted event already carries the child's session_id. */
  readonly onEvent: (event: import("@jellyclaw/shared").Event) => void;
  /** Injected clock; defaults to `Date.now` in production. */
  readonly clock: () => number;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class UnknownSubagentError extends Error {
  override readonly name = "UnknownSubagentError";
  constructor(readonly subagentType: string) {
    super(`unknown_agent: no subagent registered with name '${subagentType}'`);
  }
}

export class SubagentDepthExceededError extends Error {
  override readonly name = "SubagentDepthExceededError";
  constructor(
    readonly depth: number,
    readonly maxDepth: number,
  ) {
    super(`subagent depth exceeded: requested depth=${depth}, maxDepth=${maxDepth}`);
  }
}

export class NoUsableToolsError extends Error {
  override readonly name = "NoUsableToolsError";
  constructor(
    readonly agentName: string,
    readonly requested: readonly string[],
    readonly parentAllowed: readonly string[],
  ) {
    super(
      `subagent has no usable tools: agent '${agentName}' requested [${requested.join(
        ", ",
      )}] but parent allows only [${parentAllowed.join(", ")}]`,
    );
  }
}
