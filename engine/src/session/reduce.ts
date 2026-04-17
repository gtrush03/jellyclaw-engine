/**
 * Phase 09.02 — pure event reducer.
 *
 * `reduceEvents` takes the event sequence produced by `replayJsonl` and
 * deterministically folds it into an `EngineState`. Zero filesystem access,
 * zero `Date.now()` calls — timestamps are taken from event `ts` values so
 * tests are dead-simple and replay is reproducible.
 *
 * Rules are documented inline. Unknown event shapes cannot appear: the
 * replay layer has already validated through `AgentEvent.safeParse`, so the
 * reducer trusts the discriminated union.
 */

import type { AgentEvent } from "../events.js";
import { projectHash as computeProjectHash } from "./paths.js";
import {
  type CumulativeUsage,
  EMPTY_USAGE,
  type EngineState,
  type ReplayedMessage,
  type ReplayedPermissionDecision,
  type ReplayedToolCall,
} from "./types.js";

interface PendingPermission {
  readonly requestId: string;
  readonly toolName: string;
}

interface AssistantBuffer {
  content: string;
  firstSeq: number;
  firstTs: number;
  started: boolean;
}

function emptyBuffer(): AssistantBuffer {
  return { content: "", firstSeq: -1, firstTs: 0, started: false };
}

function bumpSeqTs(state: { lastSeq: number; lastTs: number }, ev: AgentEvent): void {
  if (ev.seq > state.lastSeq) state.lastSeq = ev.seq;
  if (ev.ts > state.lastTs) state.lastTs = ev.ts;
}

function takeLatestUsage(
  _prev: CumulativeUsage,
  ev: Extract<AgentEvent, { type: "usage.updated" }>,
): CumulativeUsage {
  const costCents = ev.cost_usd === undefined ? 0 : Math.round(ev.cost_usd * 100);
  return {
    inputTokens: ev.input_tokens,
    outputTokens: ev.output_tokens,
    cacheReadTokens: ev.cache_read_tokens,
    cacheWriteTokens: ev.cache_write_tokens,
    costUsdCents: costCents,
  };
}

export function reduceEvents(
  events: readonly AgentEvent[],
  options: { truncatedTail: boolean },
): EngineState {
  let sessionId = "";
  let projectHashValue: string | null = null;
  let cwd: string | null = null;
  let model: string | null = null;
  let provider: "anthropic" | "openrouter" | null = null;

  const messages: ReplayedMessage[] = [];
  const toolCalls: ReplayedToolCall[] = [];
  const permissions: ReplayedPermissionDecision[] = [];
  let usage: CumulativeUsage = EMPTY_USAGE;
  let turns = 0;
  let ended = false;

  const scalar = { lastSeq: -1, lastTs: 0 };

  let buffer = emptyBuffer();
  const pendingPermissions = new Map<string, PendingPermission>();

  for (const ev of events) {
    bumpSeqTs(scalar, ev);

    switch (ev.type) {
      case "session.started": {
        sessionId = ev.session_id;
        cwd = ev.cwd;
        model = ev.model;
        provider = ev.provider;
        projectHashValue = computeProjectHash(ev.cwd);
        messages.push({
          role: "user",
          content: ev.wish,
          firstSeq: ev.seq,
          firstTs: ev.ts,
        });
        break;
      }

      case "agent.message": {
        if (!buffer.started) {
          buffer = {
            content: ev.delta,
            firstSeq: ev.seq,
            firstTs: ev.ts,
            started: true,
          };
        } else {
          buffer.content += ev.delta;
        }
        if (ev.final) {
          messages.push({
            role: "assistant",
            content: buffer.content,
            firstSeq: buffer.firstSeq,
            firstTs: buffer.firstTs,
          });
          buffer = emptyBuffer();
        }
        break;
      }

      case "agent.thinking": {
        // Thinking is transient: not reconstructed into messages. Tracked via
        // lastSeq/lastTs above.
        break;
      }

      case "tool.called": {
        toolCalls.push({
          toolId: ev.tool_id,
          toolName: ev.tool_name,
          input: ev.input,
          result: null,
          error: null,
          durationMs: null,
          startedAt: ev.ts,
          finishedAt: null,
          startSeq: ev.seq,
        });
        break;
      }

      case "tool.result": {
        // Reverse-scan for the most recent unresolved entry with matching id.
        let matched = false;
        for (let i = toolCalls.length - 1; i >= 0; i--) {
          const tc = toolCalls[i];
          if (tc && tc.toolId === ev.tool_id && tc.result === null && tc.error === null) {
            toolCalls[i] = {
              ...tc,
              result: ev.output,
              durationMs: ev.duration_ms,
              finishedAt: ev.ts,
            };
            matched = true;
            break;
          }
        }
        if (!matched) {
          // Forward-compat: log-and-skip rather than throw; events beyond our
          // understanding may arrive in future phases.
        }
        break;
      }

      case "tool.error": {
        let matched = false;
        for (let i = toolCalls.length - 1; i >= 0; i--) {
          const tc = toolCalls[i];
          if (tc && tc.toolId === ev.tool_id && tc.result === null && tc.error === null) {
            toolCalls[i] = {
              ...tc,
              error: { code: ev.code, message: ev.message },
              finishedAt: ev.ts,
            };
            matched = true;
            break;
          }
        }
        if (!matched) {
          // see tool.result comment
        }
        break;
      }

      case "permission.requested": {
        pendingPermissions.set(ev.request_id, {
          requestId: ev.request_id,
          toolName: ev.tool_name,
        });
        break;
      }

      case "permission.granted": {
        const pending = pendingPermissions.get(ev.request_id);
        pendingPermissions.delete(ev.request_id);
        permissions.push({
          requestId: ev.request_id,
          toolName: pending?.toolName ?? "",
          outcome: "granted",
          grantedBy: ev.granted_by,
          scope: ev.scope,
          ts: ev.ts,
        });
        break;
      }

      case "permission.denied": {
        const pending = pendingPermissions.get(ev.request_id);
        pendingPermissions.delete(ev.request_id);
        permissions.push({
          requestId: ev.request_id,
          toolName: pending?.toolName ?? "",
          outcome: "denied",
          deniedBy: ev.denied_by,
          ts: ev.ts,
        });
        break;
      }

      case "subagent.spawned":
      case "subagent.returned": {
        // Subagent lifecycle events belong to the subagent's own session, not
        // this one. We tracked seq/ts above; nothing else to do.
        break;
      }

      case "usage.updated": {
        usage = takeLatestUsage(usage, ev);
        break;
      }

      case "session.completed": {
        turns += 1;
        ended = true;
        break;
      }

      case "session.error": {
        // Error events do NOT mark the session as ended — engine may recover.
        break;
      }

      case "stream.ping": {
        break;
      }
    }
  }

  // Crash mid-message: flush whatever we have so the caller sees the partial
  // assistant output rather than silently dropping it.
  if (buffer.started && buffer.content.length > 0) {
    messages.push({
      role: "assistant",
      content: buffer.content,
      firstSeq: buffer.firstSeq,
      firstTs: buffer.firstTs,
    });
  }

  return {
    sessionId,
    projectHash: projectHashValue,
    cwd,
    model,
    provider,
    messages,
    toolCalls,
    permissions,
    usage,
    lastSeq: scalar.lastSeq,
    lastTs: scalar.lastTs,
    turns,
    truncatedTail: options.truncatedTail,
    ended,
  };
}
