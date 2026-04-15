/**
 * jellyclaw event stream — canonical 15-variant discriminated union.
 *
 * Emitted on stdout as newline-delimited JSON when the engine runs with
 * `--output-format stream-json`. Human-readable text goes on stderr.
 *
 * This module is the authoritative boundary between the engine's internal
 * adapter (which translates OpenCode SSE frames; Phase 03 Prompt 02) and
 * every downstream consumer (Genie dispatcher, Claurst, the Tauri
 * desktop app, third-party integrators). It lives in `@jellyclaw/shared`
 * rather than `@jellyclaw/engine` because the desktop frontend must
 * consume the same types without pulling Node-only deps.
 *
 * Invariants enforced elsewhere (the schemas permit them, the adapter in
 * Prompt 02 guarantees them):
 *   - Every `tool.call.end` is preceded by a `tool.call.start` with the
 *     same `tool_use_id`.
 *   - Every nested tool event inside a subagent is preceded by
 *     `subagent.start` and followed, eventually, by `subagent.end`.
 *   - `ts` is monotonic within a session.
 *
 * See `docs/event-stream.md` for the upstream OpenCode → jellyclaw
 * mapping table and the three output-format downgrades.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Usage — shared token/cost ledger
// ---------------------------------------------------------------------------

export const Usage = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cache_creation_input_tokens: z.number().int().nonnegative().default(0),
  cache_read_input_tokens: z.number().int().nonnegative().default(0),
  cost_usd: z.number().nonnegative().default(0),
});
export type Usage = z.infer<typeof Usage>;

// ---------------------------------------------------------------------------
// Message content blocks — minimal Anthropic-shape Block union used inside
// `user` events and inside the `assistant.message` payload.
// ---------------------------------------------------------------------------

export const TextBlock = z.object({
  type: z.literal("text"),
  text: z.string(),
});
export type TextBlock = z.infer<typeof TextBlock>;

export const ToolUseBlock = z.object({
  type: z.literal("tool_use"),
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
});
export type ToolUseBlock = z.infer<typeof ToolUseBlock>;

export const ToolResultBlock = z.object({
  type: z.literal("tool_result"),
  tool_use_id: z.string(),
  content: z.union([z.string(), z.array(TextBlock)]),
  is_error: z.boolean().optional(),
});
export type ToolResultBlock = z.infer<typeof ToolResultBlock>;

export const Block = z.discriminatedUnion("type", [TextBlock, ToolUseBlock, ToolResultBlock]);
export type Block = z.infer<typeof Block>;

export const Message = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.union([z.string(), z.array(Block)]),
});
export type Message = z.infer<typeof Message>;

// ---------------------------------------------------------------------------
// Redacted config snapshot (for `system.config` payload)
// ---------------------------------------------------------------------------

export const RedactedConfig = z.record(z.string(), z.unknown());
export type RedactedConfig = z.infer<typeof RedactedConfig>;

// Fields to strip from any config snapshot before it hits the wire.
// The list is deliberately conservative — anything that *looks* like a
// secret goes. `redactConfig` walks the tree recursively.
const SECRET_KEY_PATTERNS = [
  /^apiKey$/i,
  /^api[_-]?key$/i,
  /token$/i,
  /password$/i,
  /secret$/i,
  /OPENCODE_SERVER_PASSWORD$/,
];

const SECRET_STRING_PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]{10,}/,
  /sk-or-[A-Za-z0-9_-]{10,}/,
  /AKIA[0-9A-Z]{16}/,
  /github_pat_[A-Za-z0-9_]{22,}/,
  /gh[pous]_[A-Za-z0-9]{30,}/,
];

const REDACTED = "[REDACTED]";

/**
 * Recursively redact secrets from a config-shaped object. Returns a new
 * object; the input is not mutated. Any key matching a known secret
 * pattern has its value replaced with `[REDACTED]` regardless of the
 * value's shape. Any string value matching a known secret pattern is
 * also replaced, to catch secrets that were placed under an
 * unrecognised key.
 */
export function redactConfig(input: unknown): unknown {
  if (input === null || input === undefined) return input;
  if (typeof input === "string") {
    for (const pat of SECRET_STRING_PATTERNS) {
      if (pat.test(input)) return REDACTED;
    }
    return input;
  }
  if (typeof input !== "object") return input;
  if (Array.isArray(input)) return input.map(redactConfig);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (SECRET_KEY_PATTERNS.some((p) => p.test(k))) {
      out[k] = REDACTED;
    } else {
      out[k] = redactConfig(v);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The 15 event variants
// ---------------------------------------------------------------------------

const ts = z.number().nonnegative();

// 1. system.init — one per session, emitted before any other event.
export const SystemInitEvent = z.object({
  type: z.literal("system.init"),
  session_id: z.string().min(1),
  cwd: z.string(),
  model: z.string(),
  tools: z.array(z.string()),
  ts,
});
export type SystemInitEvent = z.infer<typeof SystemInitEvent>;

// 2. system.config — redacted config snapshot, one per session, right
//    after system.init.
export const SystemConfigEvent = z.object({
  type: z.literal("system.config"),
  config: RedactedConfig,
  ts,
});
export type SystemConfigEvent = z.infer<typeof SystemConfigEvent>;

// 3. user — a user turn (either plain text or structured blocks).
export const UserEvent = z.object({
  type: z.literal("user"),
  session_id: z.string().min(1),
  content: z.union([z.string(), z.array(Block)]),
  ts,
});
export type UserEvent = z.infer<typeof UserEvent>;

// 4. assistant.delta — streaming text chunk; coalesced in
//    claude-code-compat into the terminal assistant.message.
export const AssistantDeltaEvent = z.object({
  type: z.literal("assistant.delta"),
  session_id: z.string().min(1),
  text: z.string(),
  ts,
});
export type AssistantDeltaEvent = z.infer<typeof AssistantDeltaEvent>;

// 5. assistant.message — final assistant message with usage roll-up.
export const AssistantMessageEvent = z.object({
  type: z.literal("assistant.message"),
  session_id: z.string().min(1),
  message: Message,
  usage: Usage,
  ts,
});
export type AssistantMessageEvent = z.infer<typeof AssistantMessageEvent>;

// 6. tool.call.start — preceded by buffering in the adapter so it never
//    arrives after its matching .end.
export const ToolCallStartEvent = z.object({
  type: z.literal("tool.call.start"),
  session_id: z.string().min(1),
  tool_use_id: z.string().min(1),
  name: z.string(),
  input: z.unknown(),
  subagent_path: z.array(z.string()),
  ts,
});
export type ToolCallStartEvent = z.infer<typeof ToolCallStartEvent>;

// 7. tool.call.delta — optional streaming progress frames emitted for
//    tools that produce intermediate JSON (rare in v1.4.5, reserved).
export const ToolCallDeltaEvent = z.object({
  type: z.literal("tool.call.delta"),
  session_id: z.string().min(1),
  tool_use_id: z.string().min(1),
  partial_json: z.string(),
  ts,
});
export type ToolCallDeltaEvent = z.infer<typeof ToolCallDeltaEvent>;

// 8. tool.call.end — result XOR error; duration in milliseconds.
export const ToolCallEndEvent = z.object({
  type: z.literal("tool.call.end"),
  session_id: z.string().min(1),
  tool_use_id: z.string().min(1),
  result: z.unknown().optional(),
  error: z.string().optional(),
  duration_ms: z.number().nonnegative(),
  ts,
});
export type ToolCallEndEvent = z.infer<typeof ToolCallEndEvent>;

// 9. subagent.start — emitted before any tool event the subagent makes.
export const SubagentStartEvent = z.object({
  type: z.literal("subagent.start"),
  session_id: z.string().min(1),
  agent_name: z.string(),
  parent_id: z.string(),
  allowed_tools: z.array(z.string()),
  ts,
});
export type SubagentStartEvent = z.infer<typeof SubagentStartEvent>;

// 10. subagent.end — emitted after the subagent's final assistant turn.
export const SubagentEndEvent = z.object({
  type: z.literal("subagent.end"),
  session_id: z.string().min(1),
  summary: z.string(),
  usage: Usage,
  ts,
});
export type SubagentEndEvent = z.infer<typeof SubagentEndEvent>;

// 11. hook.fire — observability for permission / tool / chat hooks.
export const HookFireEvent = z.object({
  type: z.literal("hook.fire"),
  session_id: z.string().min(1),
  event: z.string(),
  decision: z.string(),
  stdout: z.string(),
  stderr: z.string(),
  ts,
});
export type HookFireEvent = z.infer<typeof HookFireEvent>;

// 12. permission.request — one per tool invocation the policy engine
//     sees (allow / ask / deny).
export const PermissionRequestEvent = z.object({
  type: z.literal("permission.request"),
  session_id: z.string().min(1),
  tool: z.string(),
  rule_matched: z.string(),
  action: z.enum(["allow", "ask", "deny"]),
  ts,
});
export type PermissionRequestEvent = z.infer<typeof PermissionRequestEvent>;

// 13. session.update — todo / memory patches applied mid-session.
export const SessionUpdateEvent = z.object({
  type: z.literal("session.update"),
  session_id: z.string().min(1),
  patch: z.unknown(),
  ts,
});
export type SessionUpdateEvent = z.infer<typeof SessionUpdateEvent>;

// 14. cost.tick — rolling ledger; emitted at assistant turn boundaries.
export const CostTickEvent = z.object({
  type: z.literal("cost.tick"),
  session_id: z.string().min(1),
  usage: Usage,
  ts,
});
export type CostTickEvent = z.infer<typeof CostTickEvent>;

// 15. result — terminal event; exactly one per session.
export const ResultEvent = z.object({
  type: z.literal("result"),
  session_id: z.string().min(1),
  status: z.enum(["success", "error", "cancelled", "max_turns"]),
  stats: z.object({
    turns: z.number().int().nonnegative(),
    tools_called: z.number().int().nonnegative(),
    duration_ms: z.number().nonnegative(),
  }),
  ts,
});
export type ResultEvent = z.infer<typeof ResultEvent>;

// ---------------------------------------------------------------------------
// Discriminated union
// ---------------------------------------------------------------------------

export const Event = z.discriminatedUnion("type", [
  SystemInitEvent,
  SystemConfigEvent,
  UserEvent,
  AssistantDeltaEvent,
  AssistantMessageEvent,
  ToolCallStartEvent,
  ToolCallDeltaEvent,
  ToolCallEndEvent,
  SubagentStartEvent,
  SubagentEndEvent,
  HookFireEvent,
  PermissionRequestEvent,
  SessionUpdateEvent,
  CostTickEvent,
  ResultEvent,
]);
export type Event = z.infer<typeof Event>;
export type EventType = Event["type"];

/**
 * The 15 event type strings, in the canonical order used by the
 * adapter and by `docs/event-stream.md`. Exposed so the adapter can
 * iterate the set for smoke tests and so downgrade tables can gate
 * on membership without stringly-typed magic.
 */
export const EVENT_TYPES = [
  "system.init",
  "system.config",
  "user",
  "assistant.delta",
  "assistant.message",
  "tool.call.start",
  "tool.call.delta",
  "tool.call.end",
  "subagent.start",
  "subagent.end",
  "hook.fire",
  "permission.request",
  "session.update",
  "cost.tick",
  "result",
] as const satisfies readonly EventType[];

// ---------------------------------------------------------------------------
// Type guards — factory-generated to avoid 15 copies of the same code.
// ---------------------------------------------------------------------------

function makeGuard<T extends EventType>(type: T) {
  return (e: Event): e is Extract<Event, { type: T }> => e.type === type;
}

export const isSystemInit = makeGuard("system.init");
export const isSystemConfig = makeGuard("system.config");
export const isUser = makeGuard("user");
export const isAssistantDelta = makeGuard("assistant.delta");
export const isAssistantMessage = makeGuard("assistant.message");
export const isToolStart = makeGuard("tool.call.start");
export const isToolDelta = makeGuard("tool.call.delta");
export const isToolEnd = makeGuard("tool.call.end");
export const isSubagentStart = makeGuard("subagent.start");
export const isSubagentEnd = makeGuard("subagent.end");
export const isHookFire = makeGuard("hook.fire");
export const isPermissionRequest = makeGuard("permission.request");
export const isSessionUpdate = makeGuard("session.update");
export const isCostTick = makeGuard("cost.tick");
export const isResult = makeGuard("result");

/**
 * Generic guard: `isEvent(e, "tool.call.start")` narrows to ToolCallStartEvent.
 */
export function isEvent<T extends EventType>(e: Event, type: T): e is Extract<Event, { type: T }> {
  return e.type === type;
}

/**
 * Parse an unknown value into a validated Event. Throws `ZodError` on
 * invalid input; callers that need soft handling should use
 * `Event.safeParse` directly.
 */
export function parseEvent(input: unknown): Event {
  return Event.parse(input);
}

// ---------------------------------------------------------------------------
// Output-format downgrades
// ---------------------------------------------------------------------------

export type OutputFormat = "jellyclaw-full" | "claude-code-compat" | "claurst-min";

/**
 * Which event types survive each output-format downgrade.
 *
 *   - `jellyclaw-full`     — all 15; verbatim.
 *   - `claude-code-compat` — system.init, user, assistant.message, result.
 *                            assistant.delta is coalesced into the terminal
 *                            assistant.message by the emitter.
 *   - `claurst-min`        — assistant.delta + result. Text only; no tool
 *                            events. Matches the minimum-surface format
 *                            Claurst's v0 dispatcher was built against.
 *
 * The emitter consults this table; the adapter itself produces the full
 * set unconditionally (so recorded sessions can be re-emitted in any
 * format without re-running the model).
 */
export const OUTPUT_FORMAT_EVENTS: Record<OutputFormat, ReadonlySet<EventType>> = {
  "jellyclaw-full": new Set<EventType>(EVENT_TYPES),
  "claude-code-compat": new Set<EventType>(["system.init", "user", "assistant.message", "result"]),
  "claurst-min": new Set<EventType>(["assistant.delta", "result"]),
};
