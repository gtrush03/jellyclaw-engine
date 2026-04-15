/**
 * Subagent event factories (Phase 06 Prompt 02).
 *
 * `subagent.progress` is intentionally NOT emitted — the 15-variant protocol
 * has only `subagent.start` + `subagent.end`. Progress is carried by the
 * interleaved `tool.call.start` / `tool.call.end` events the child forwards
 * via `SessionRunArgs.onEvent`.
 *
 * The factories here build the raw shape only. Callers that want runtime
 * validation should pipe the returned object through
 * `SubagentStartEvent.parse()` / `SubagentEndEvent.parse()` from
 * `@jellyclaw/shared` — we keep the factories cheap (no Zod on the hot
 * path).
 */

import type { SubagentEndEvent, SubagentStartEvent, Usage } from "@jellyclaw/shared";

export interface MakeSubagentStartEventArgs {
  readonly sessionId: string;
  readonly agentName: string;
  readonly parentId: string;
  readonly allowedTools: readonly string[];
  readonly ts: number;
}

export function makeSubagentStartEvent(args: MakeSubagentStartEventArgs): SubagentStartEvent {
  return {
    type: "subagent.start",
    session_id: args.sessionId,
    agent_name: args.agentName,
    parent_id: args.parentId,
    allowed_tools: [...args.allowedTools],
    ts: args.ts,
  };
}

export interface MakeSubagentEndEventArgs {
  readonly sessionId: string;
  readonly summary: string;
  readonly usage: Usage;
  readonly ts: number;
}

export function makeSubagentEndEvent(args: MakeSubagentEndEventArgs): SubagentEndEvent {
  return {
    type: "subagent.end",
    session_id: args.sessionId,
    summary: args.summary,
    usage: args.usage,
    ts: args.ts,
  };
}
