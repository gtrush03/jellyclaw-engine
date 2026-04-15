/**
 * Hook engine types (Phase 08.02).
 *
 * See `docs/hooks.md` and `phases/PHASE-08-permissions-hooks.md`. Ten event
 * kinds fire at well-defined lifecycle points; user-supplied shell commands
 * receive a JSON payload on stdin and return either an empty body (neutral)
 * or a decision JSON on stdout. Exit code 2 is a hard block with the reason
 * surfaced from stderr.
 *
 * Invariants:
 *  - Hook commands run via `child_process.spawn(command, args, ...)` with
 *    NO `shell: true`.  User input is never interpolated into a shell
 *    string.  See SECURITY.md.
 *  - Notification hooks cannot block.  Enforced by the `HookResult`
 *    discriminator — `NotificationHookResult` has no `decision` field.
 *  - Deny-wins composes with permissions: if a hook denies in
 *    `bypassPermissions` mode, the call is still blocked.
 *  - PostToolUse async (blocking: false): result is fire-and-forget; the
 *    hook CANNOT modify the tool result.  Enforced at runtime.
 */
import type { z } from "zod";
import type { Logger } from "../logger.js";

// ---------------------------------------------------------------------------
// Event kinds
// ---------------------------------------------------------------------------

/**
 * The 10 hook event kinds. Match Claude Code's surface exactly.
 */
export type HookEventKind =
  | "SessionStart"
  | "InstructionsLoaded"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  | "SubagentStart"
  | "SubagentStop"
  | "PreCompact"
  | "Stop"
  | "Notification";

export const ALL_HOOK_EVENTS: readonly HookEventKind[] = [
  "SessionStart",
  "InstructionsLoaded",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "Stop",
  "Notification",
] as const;

/**
 * Events that may block execution. The runner refuses to honor `decision`
 * from any other event kind (treated as neutral + warn).
 */
export const BLOCKING_EVENTS: ReadonlySet<HookEventKind> = new Set([
  "PreToolUse",
  "UserPromptSubmit",
  "PreCompact",
]);

/**
 * Events whose payload the runner may `modify`. For all others, `modified`
 * in the hook stdout JSON is ignored + warned.
 */
export const MODIFIABLE_EVENTS: ReadonlySet<HookEventKind> = new Set([
  "PreToolUse",
  "UserPromptSubmit",
]);

// ---------------------------------------------------------------------------
// Payload shapes — per-event
// ---------------------------------------------------------------------------

export interface SessionStartPayload {
  readonly sessionId: string;
  readonly cwd: string;
  readonly config: Readonly<Record<string, unknown>>;
}

export interface InstructionsLoadedPayload {
  readonly sessionId: string;
  readonly claudeMd: string | null;
  readonly systemPromptBytes: number;
}

export interface UserPromptSubmitPayload {
  readonly sessionId: string;
  readonly prompt: string;
}

export interface PreToolUsePayload {
  readonly sessionId: string;
  readonly toolName: string;
  readonly toolInput: Readonly<Record<string, unknown>>;
  readonly callId: string;
}

export interface PostToolUsePayload {
  readonly sessionId: string;
  readonly toolName: string;
  readonly toolInput: Readonly<Record<string, unknown>>;
  readonly toolResult: unknown;
  readonly callId: string;
  readonly durationMs: number;
  /** Set to true when toolResult was truncated to fit the 256 KB per-hook cap. */
  readonly truncated?: boolean;
}

export interface SubagentStartPayload {
  readonly parentSessionId: string;
  readonly subagentSessionId: string;
  readonly agentName: string;
}

export interface SubagentStopPayload {
  readonly parentSessionId: string;
  readonly subagentSessionId: string;
  readonly reason: string;
  readonly usage: Readonly<Record<string, unknown>>;
}

export interface PreCompactPayload {
  readonly sessionId: string;
  readonly tokenCount: number;
  readonly threshold: number;
}

export interface StopPayload {
  readonly sessionId: string;
  readonly reason: string;
  readonly usage: Readonly<Record<string, unknown>>;
}

export interface NotificationPayload {
  readonly sessionId: string;
  readonly level: "info" | "warn" | "error";
  readonly message: string;
}

/**
 * Payload type keyed by event kind. The runner carries the kind alongside
 * the payload so it can enforce per-event invariants (see BLOCKING_EVENTS,
 * MODIFIABLE_EVENTS).
 */
export interface HookEventMap {
  SessionStart: SessionStartPayload;
  InstructionsLoaded: InstructionsLoadedPayload;
  UserPromptSubmit: UserPromptSubmitPayload;
  PreToolUse: PreToolUsePayload;
  PostToolUse: PostToolUsePayload;
  SubagentStart: SubagentStartPayload;
  SubagentStop: SubagentStopPayload;
  PreCompact: PreCompactPayload;
  Stop: StopPayload;
  Notification: NotificationPayload;
}

export type HookEvent = {
  [K in HookEventKind]: { readonly kind: K; readonly payload: HookEventMap[K] };
}[HookEventKind];

// ---------------------------------------------------------------------------
// Hook config (user-supplied, parsed from jellyclaw.json)
// ---------------------------------------------------------------------------

/**
 * One user-configured hook entry. A single jellyclaw.json may declare many.
 *
 * - `event`   — required; restricts this hook to one kind.
 * - `matcher` — optional picomatch pattern; semantics depend on event:
 *     * PreToolUse / PostToolUse → matches against the `toolName` (and
 *       optionally `toolName(argString)` using the same grammar as
 *       permissions rules).
 *     * UserPromptSubmit → matches against the first 256 chars of the prompt.
 *     * Other events → ignored (match-all).
 * - `command` — literal executable path or PATH-resolved binary. Warned
 *               when relative (PATH-shift risk).
 * - `args`    — array, argv-style. Never shell-interpolated.
 * - `timeout` — ms; default 30_000, max 120_000.
 * - `blocking` — only meaningful for PostToolUse. Default true. When false,
 *               the runner fire-and-forgets and `modified` is ignored.
 * - `name`    — free-form label for logs. Defaults to `${command}#${index}`.
 */
export interface HookConfig {
  readonly event: HookEventKind;
  readonly matcher?: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly timeout?: number;
  readonly blocking?: boolean;
  readonly name?: string;
  /** Free-form environment vars to set for this hook specifically. */
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * Compiled hook: HookConfig + derived match predicate + stable name.
 */
export interface CompiledHook {
  readonly config: HookConfig;
  readonly name: string;
  /**
   * True iff this hook should run for the given event instance. Pure
   * function of the event payload + matcher.
   */
  match(event: HookEvent): boolean;
}

// ---------------------------------------------------------------------------
// Hook runner I/O
// ---------------------------------------------------------------------------

/**
 * Terminal outcome of running a single hook. Surfaces the values needed by
 * the engine (composition with the permissions layer) and by the audit log.
 */
export interface HookOutcome<K extends HookEventKind = HookEventKind> {
  readonly hookName: string;
  readonly event: K;
  readonly decision: "allow" | "deny" | "modify" | "neutral";
  /** Present iff decision === "modify" AND event is in MODIFIABLE_EVENTS. */
  readonly modified?: HookEventMap[K];
  readonly reason?: string;
  readonly durationMs: number;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly stderrTruncated?: boolean;
  readonly stdoutTruncated?: boolean;
  readonly warn?: string;
}

/**
 * Aggregate result of running all hooks for an event, after composition.
 * Produced by `runHooks()` in `runner.ts` (or `registry.ts`, depending on
 * how the implementing agent lays things out).
 */
export interface HookRunResult<K extends HookEventKind = HookEventKind> {
  readonly event: K;
  /** Every hook that fired, in declaration order. */
  readonly outcomes: readonly HookOutcome<K>[];
  /**
   * Composed decision. Deny wins. If any hook denied, this is "deny" and
   * `reason` carries the denying hook's reason (first denier wins).
   * If any hook modified AND none denied, this is "modify" and `modified`
   * carries the final payload (last modification wins — document this).
   * Otherwise "allow" (or "neutral" when no hooks fired / all neutral).
   */
  readonly decision: "allow" | "deny" | "modify" | "neutral";
  readonly modified?: HookEventMap[K];
  readonly reason?: string;
  readonly denyingHookName?: string;
}

// ---------------------------------------------------------------------------
// Audit log entry (separate file from the permissions audit)
// ---------------------------------------------------------------------------

/**
 * One line in `~/.jellyclaw/logs/hooks.jsonl`. One entry PER hook invocation
 * (not per event) — an event that fires 3 matching hooks produces 3 lines.
 */
export interface HookAuditEntry {
  readonly ts: string;
  readonly event: HookEventKind;
  readonly sessionId: string;
  readonly hookName: string;
  readonly decision: "allow" | "deny" | "modify" | "neutral";
  readonly durationMs: number;
  readonly exitCode: number | null;
  readonly reason?: string;
  readonly timedOut?: boolean;
  readonly stdoutBytes?: number;
  readonly stderrBytes?: number;
  readonly warn?: string;
}

// ---------------------------------------------------------------------------
// Runner options (dependency injection seams for tests)
// ---------------------------------------------------------------------------

export interface RunHooksOptions<K extends HookEventKind = HookEventKind> {
  readonly event: HookEvent & { readonly kind: K };
  readonly sessionId: string;
  readonly hooks: readonly CompiledHook[];
  /** Override the audit sink (defaults to `defaultHookAuditSink`). */
  readonly audit?: (entry: HookAuditEntry) => void;
  readonly logger?: Logger;
  /** Override default 30_000 ms timeout. Only used when hook has no explicit timeout. */
  readonly defaultTimeoutMs?: number;
  /** Maximum bytes of stdout/stderr retained per hook. Default 1_048_576. */
  readonly maxOutputBytes?: number;
  /** Maximum bytes of tool_result passed to PostToolUse hooks. Default 262_144. */
  readonly maxToolResultBytes?: number;
  /** Abort signal — cancels pending hooks. */
  readonly signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Zod-schema export surface (runner's per-event payload validators)
// ---------------------------------------------------------------------------

/**
 * Per-event Zod schema registry. `events.ts` populates this at module load.
 * Tests use this to assert every event kind has a schema.
 */
export type HookPayloadSchemas = {
  readonly [K in HookEventKind]: z.ZodType<HookEventMap[K]>;
};

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_HOOK_TIMEOUT_MS = 30_000;
export const MAX_HOOK_TIMEOUT_MS = 120_000;
export const MAX_HOOK_OUTPUT_BYTES = 1_048_576;
export const MAX_POST_TOOL_RESULT_BYTES = 262_144;
/** SIGTERM → SIGKILL grace period. */
export const HOOK_KILL_GRACE_MS = 1_000;
