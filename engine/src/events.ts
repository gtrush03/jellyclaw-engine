/**
 * AgentEvent — the canonical streaming event protocol for jellyclaw.
 *
 * Every consumer (Genie, the CLI, the jelly-claw macOS bridge) subscribes to a stream of
 * AgentEvent values. The shape of this union is a **public API** — breaking changes bump the
 * engine major version.
 *
 * The 16 variants cover the full lifecycle of a wish:
 *
 *   lifecycle:   session.started · session.completed · session.error
 *   user input:  user.prompt
 *   planning:    agent.thinking · agent.message
 *   tools:       tool.called · tool.result · tool.error
 *   permission:  permission.requested · permission.granted · permission.denied
 *   subagent:    subagent.spawned · subagent.returned
 *   runtime:     usage.updated · stream.ping
 *
 * Every event carries `session_id`, `ts` (unix ms), and `seq` (monotonic per session).
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Common envelope
// ---------------------------------------------------------------------------

const EventBase = z.object({
  session_id: z.string().min(1),
  ts: z.number().int().nonnegative(),
  seq: z.number().int().nonnegative(),
});

// ---------------------------------------------------------------------------
// 1. session.started
// ---------------------------------------------------------------------------
export const SessionStartedEvent = EventBase.extend({
  type: z.literal("session.started"),
  wish: z.string(),
  agent: z.string().default("default"),
  model: z.string(),
  provider: z.enum(["anthropic", "openrouter"]),
  cwd: z.string(),
});
export type SessionStartedEvent = z.infer<typeof SessionStartedEvent>;

// ---------------------------------------------------------------------------
// 2. session.completed
// ---------------------------------------------------------------------------
export const SessionCompletedEvent = EventBase.extend({
  type: z.literal("session.completed"),
  summary: z.string().optional(),
  turns: z.number().int().nonnegative(),
  duration_ms: z.number().int().nonnegative(),
  /** T4-02: Paths to final-state screenshots captured before session teardown. */
  final_screenshots: z.array(z.string()).optional(),
});
export type SessionCompletedEvent = z.infer<typeof SessionCompletedEvent>;

// ---------------------------------------------------------------------------
// 3. session.error
// ---------------------------------------------------------------------------
export const SessionErrorEvent = EventBase.extend({
  type: z.literal("session.error"),
  code: z.string(),
  message: z.string(),
  recoverable: z.boolean().default(false),
});
export type SessionErrorEvent = z.infer<typeof SessionErrorEvent>;

// ---------------------------------------------------------------------------
// 4. agent.thinking  (extended thinking blocks, streamed incrementally)
// ---------------------------------------------------------------------------
export const AgentThinkingEvent = EventBase.extend({
  type: z.literal("agent.thinking"),
  delta: z.string(),
  signature: z.string().optional(),
});
export type AgentThinkingEvent = z.infer<typeof AgentThinkingEvent>;

// ---------------------------------------------------------------------------
// 5. agent.message  (user-visible text output, streamed)
// ---------------------------------------------------------------------------
export const AgentMessageEvent = EventBase.extend({
  type: z.literal("agent.message"),
  delta: z.string(),
  final: z.boolean().default(false),
});
export type AgentMessageEvent = z.infer<typeof AgentMessageEvent>;

// ---------------------------------------------------------------------------
// 6. tool.called
// ---------------------------------------------------------------------------
export const ToolCalledEvent = EventBase.extend({
  type: z.literal("tool.called"),
  tool_id: z.string(),
  tool_name: z.string(),
  input: z.unknown(),
});
export type ToolCalledEvent = z.infer<typeof ToolCalledEvent>;

// ---------------------------------------------------------------------------
// 7. tool.result
// ---------------------------------------------------------------------------
export const ToolResultEvent = EventBase.extend({
  type: z.literal("tool.result"),
  tool_id: z.string(),
  tool_name: z.string(),
  output: z.unknown(),
  duration_ms: z.number().int().nonnegative(),
  /** Present and `true` when the tool output was truncated to fit within MAX_TOOL_RESULT_BYTES. */
  truncated: z.boolean().optional(),
  /** Original byte length of the tool output (UTF-8). Only present when truncated. */
  output_bytes: z.number().int().nonnegative().optional(),
});
export type ToolResultEvent = z.infer<typeof ToolResultEvent>;

// ---------------------------------------------------------------------------
// 8. tool.error
// ---------------------------------------------------------------------------
export const ToolErrorEvent = EventBase.extend({
  type: z.literal("tool.error"),
  tool_id: z.string(),
  tool_name: z.string(),
  code: z.string(),
  message: z.string(),
});
export type ToolErrorEvent = z.infer<typeof ToolErrorEvent>;

// ---------------------------------------------------------------------------
// 9. permission.requested
// ---------------------------------------------------------------------------
export const PermissionRequestedEvent = EventBase.extend({
  type: z.literal("permission.requested"),
  request_id: z.string(),
  tool_name: z.string(),
  reason: z.string(),
  input_preview: z.unknown(),
});
export type PermissionRequestedEvent = z.infer<typeof PermissionRequestedEvent>;

// ---------------------------------------------------------------------------
// 10. permission.granted
// ---------------------------------------------------------------------------
export const PermissionGrantedEvent = EventBase.extend({
  type: z.literal("permission.granted"),
  request_id: z.string(),
  scope: z.enum(["once", "session", "forever"]),
  granted_by: z.enum(["user", "policy", "auto"]),
});
export type PermissionGrantedEvent = z.infer<typeof PermissionGrantedEvent>;

// ---------------------------------------------------------------------------
// 11. permission.denied
// ---------------------------------------------------------------------------
export const PermissionDeniedEvent = EventBase.extend({
  type: z.literal("permission.denied"),
  request_id: z.string(),
  denied_by: z.enum(["user", "policy", "auto"]),
  reason: z.string().optional(),
});
export type PermissionDeniedEvent = z.infer<typeof PermissionDeniedEvent>;

// ---------------------------------------------------------------------------
// 12. subagent.spawned
// ---------------------------------------------------------------------------
export const SubagentSpawnedEvent = EventBase.extend({
  type: z.literal("subagent.spawned"),
  subagent_id: z.string(),
  parent_session_id: z.string(),
  agent: z.string(),
  wish: z.string(),
});
export type SubagentSpawnedEvent = z.infer<typeof SubagentSpawnedEvent>;

// ---------------------------------------------------------------------------
// 13. subagent.returned
// ---------------------------------------------------------------------------
export const SubagentReturnedEvent = EventBase.extend({
  type: z.literal("subagent.returned"),
  subagent_id: z.string(),
  parent_session_id: z.string(),
  summary: z.string().optional(),
  ok: z.boolean(),
});
export type SubagentReturnedEvent = z.infer<typeof SubagentReturnedEvent>;

// ---------------------------------------------------------------------------
// 14. usage.updated
// ---------------------------------------------------------------------------

/**
 * Token counts + cost for a single usage update. Exposed publicly (via
 * `public-types.ts`) so library consumers can type their own usage handlers
 * without pulling in the full `UsageUpdatedEvent` envelope.
 */
export const UsageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cache_read_tokens: z.number().int().nonnegative().default(0),
  cache_write_tokens: z.number().int().nonnegative().default(0),
  cost_usd: z.number().nonnegative().optional(),
});
export type Usage = z.infer<typeof UsageSchema>;

export const UsageUpdatedEvent = EventBase.extend({
  type: z.literal("usage.updated"),
}).merge(UsageSchema);
export type UsageUpdatedEvent = z.infer<typeof UsageUpdatedEvent>;

// ---------------------------------------------------------------------------
// 15. stream.ping  (keepalive — emitted every 15 s during long tool calls)
// ---------------------------------------------------------------------------
export const StreamPingEvent = EventBase.extend({
  type: z.literal("stream.ping"),
});
export type StreamPingEvent = z.infer<typeof StreamPingEvent>;

// ---------------------------------------------------------------------------
// 16. user.prompt  (user-supplied turn text, persisted before the agent loop
//     begins so replay/resume can reconstruct the full multi-turn transcript)
// ---------------------------------------------------------------------------
export const UserPromptEvent = EventBase.extend({
  type: z.literal("user.prompt"),
  text: z.string(),
});
export type UserPromptEvent = z.infer<typeof UserPromptEvent>;

// ---------------------------------------------------------------------------
// 17. team.created  (T4-03 - multi-agent team spawn)
// ---------------------------------------------------------------------------
export const TeamCreatedEvent = EventBase.extend({
  type: z.literal("team.created"),
  team_id: z.string(),
  members: z.array(
    z.object({
      agent_id: z.string(),
      subagent_id: z.string(),
    }),
  ),
});
export type TeamCreatedEvent = z.infer<typeof TeamCreatedEvent>;

// ---------------------------------------------------------------------------
// 18. team.member.started  (individual member agent started)
// ---------------------------------------------------------------------------
export const TeamMemberStartedEvent = EventBase.extend({
  type: z.literal("team.member.started"),
  team_id: z.string(),
  agent_id: z.string(),
  subagent_id: z.string(),
});
export type TeamMemberStartedEvent = z.infer<typeof TeamMemberStartedEvent>;

// ---------------------------------------------------------------------------
// 19. team.member.result  (individual member agent completed)
// ---------------------------------------------------------------------------
export const TeamMemberResultEvent = EventBase.extend({
  type: z.literal("team.member.result"),
  team_id: z.string(),
  agent_id: z.string(),
  status: z.enum(["done", "error", "cancelled"]),
  output: z.string().optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
    })
    .optional(),
});
export type TeamMemberResultEvent = z.infer<typeof TeamMemberResultEvent>;

// ---------------------------------------------------------------------------
// 20. team.deleted  (team cancelled and cleaned up)
// ---------------------------------------------------------------------------
export const TeamDeletedEvent = EventBase.extend({
  type: z.literal("team.deleted"),
  team_id: z.string(),
  cancelled: z.number().int().nonnegative(),
  already_done: z.number().int().nonnegative(),
});
export type TeamDeletedEvent = z.infer<typeof TeamDeletedEvent>;

// ---------------------------------------------------------------------------
// 21. monitor.started  (T4-04 - background process monitor started)
// ---------------------------------------------------------------------------
export const MonitorStartedEvent = EventBase.extend({
  type: z.literal("monitor.started"),
  monitor_id: z.string(),
  kind: z.enum(["tail", "watch", "cmd"]),
  target: z.string(),
});
export type MonitorStartedEvent = z.infer<typeof MonitorStartedEvent>;

// ---------------------------------------------------------------------------
// 22. monitor.event  (T4-04 - monitor emitted line(s) or fs event)
// ---------------------------------------------------------------------------
export const MonitorEventEvent = EventBase.extend({
  type: z.literal("monitor.event"),
  monitor_id: z.string(),
  // Exactly one of lines, fs_event, or dropped per event.
  lines: z.array(z.string()).optional(),
  fs_event: z
    .object({
      type: z.string(),
      path: z.string(),
    })
    .optional(),
  dropped: z.number().int().nonnegative().optional(),
});
export type MonitorEventEvent = z.infer<typeof MonitorEventEvent>;

// ---------------------------------------------------------------------------
// 23. monitor.stopped  (T4-04 - monitor stopped)
// ---------------------------------------------------------------------------
export const MonitorStoppedEvent = EventBase.extend({
  type: z.literal("monitor.stopped"),
  monitor_id: z.string(),
  reason: z.enum(["user", "exhausted", "error", "daemon_restart"]),
  total_events: z.number().int().nonnegative(),
  stopped_at: z.number().int(),
  error: z.string().optional(),
});
export type MonitorStoppedEvent = z.infer<typeof MonitorStoppedEvent>;

// ---------------------------------------------------------------------------
// Discriminated union
// ---------------------------------------------------------------------------

export const AgentEvent = z.discriminatedUnion("type", [
  SessionStartedEvent,
  SessionCompletedEvent,
  SessionErrorEvent,
  AgentThinkingEvent,
  AgentMessageEvent,
  ToolCalledEvent,
  ToolResultEvent,
  ToolErrorEvent,
  PermissionRequestedEvent,
  PermissionGrantedEvent,
  PermissionDeniedEvent,
  SubagentSpawnedEvent,
  SubagentReturnedEvent,
  UsageUpdatedEvent,
  StreamPingEvent,
  UserPromptEvent,
  TeamCreatedEvent,
  TeamMemberStartedEvent,
  TeamMemberResultEvent,
  TeamDeletedEvent,
  MonitorStartedEvent,
  MonitorEventEvent,
  MonitorStoppedEvent,
]);

export type AgentEvent = z.infer<typeof AgentEvent>;
export type AgentEventType = AgentEvent["type"];

/**
 * Type guard: `isAgentEvent(x, "tool.called")` narrows x to ToolCalledEvent.
 */
export function isAgentEvent<T extends AgentEventType>(
  event: AgentEvent,
  type: T,
): event is Extract<AgentEvent, { type: T }> {
  return event.type === type;
}

/**
 * Parse an unknown value into a validated AgentEvent. Throws ZodError on invalid input —
 * callers that need graceful handling should use `AgentEvent.safeParse` directly.
 */
export function parseAgentEvent(input: unknown): AgentEvent {
  return AgentEvent.parse(input);
}
