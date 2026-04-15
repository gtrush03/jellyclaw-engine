/**
 * Test-only in-memory hook recorder.
 *
 * Phase 08 replaces this with a real hook engine that runs `PreToolUse` /
 * `PostToolUse` hooks around every tool call. Until then, this harness
 * exists purely so Phase 06 Prompt 03 regression tests can assert the
 * "hooks fire inside subagents with the CHILD's session id" invariant
 * (upstream OpenCode #5894) against the in-process dispatcher.
 *
 * Do NOT import this module outside tests. It is a stub recorder — not
 * the engine's hook surface.
 */

import type { Event } from "@jellyclaw/shared";

export interface HookRecord {
  readonly event: "PreToolUse" | "PostToolUse";
  readonly toolName: string;
  readonly toolUseId: string;
  readonly sessionId: string;
  readonly parentSessionId: string | undefined;
  readonly subagentPath: readonly string[];
  readonly input?: unknown;
  readonly result?: unknown;
  readonly ts: number;
}

export interface HookRecorderOptions {
  readonly parentSessionId: string;
}

export class HookRecorder {
  readonly #records: HookRecord[] = [];
  readonly #inFlight = new Map<string, string>();
  readonly #parentSessionId: string;

  constructor(opts: HookRecorderOptions) {
    this.#parentSessionId = opts.parentSessionId;
  }

  get records(): readonly HookRecord[] {
    return this.#records;
  }

  onEvent(event: Event): void {
    if (event.type === "tool.call.start") {
      this.#inFlight.set(event.tool_use_id, event.name);
      const record: HookRecord = {
        event: "PreToolUse",
        toolName: event.name,
        toolUseId: event.tool_use_id,
        sessionId: event.session_id,
        parentSessionId: this.#parentSessionId,
        subagentPath: [...event.subagent_path],
        input: event.input,
        ts: event.ts,
      };
      this.#records.push(record);
      return;
    }
    if (event.type === "tool.call.end") {
      const toolName = this.#inFlight.get(event.tool_use_id) ?? "<unknown>";
      this.#inFlight.delete(event.tool_use_id);
      const result = event.error !== undefined ? { error: event.error } : event.result;
      const record: HookRecord = {
        event: "PostToolUse",
        toolName,
        toolUseId: event.tool_use_id,
        sessionId: event.session_id,
        parentSessionId: this.#parentSessionId,
        subagentPath: [],
        result,
        ts: event.ts,
      };
      this.#records.push(record);
    }
  }

  reset(): void {
    this.#records.length = 0;
    this.#inFlight.clear();
  }

  preToolUses(): HookRecord[] {
    return this.#records.filter((r) => r.event === "PreToolUse");
  }

  postToolUses(): HookRecord[] {
    return this.#records.filter((r) => r.event === "PostToolUse");
  }
}
