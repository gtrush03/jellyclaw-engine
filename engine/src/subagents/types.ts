/**
 * Subagent dispatch surface.
 *
 * The Task tool delegates here. Phase 04 ships only a stub
 * (`engine/src/subagents/stub.ts`) that always errors. Phase 06 lands the
 * real subagent engine: it spawns a child OpenCode session bound to a
 * named agent (e.g. `general-purpose`, `Explore`), pumps its events
 * through the same emitter as the parent, and returns a structured
 * summary on completion.
 */

export interface SubagentDispatchInput {
  /** Agent role to spawn (e.g. "general-purpose", "Explore"). */
  readonly subagent_type: string;
  /** Short label for the dispatch — surfaced in events / UI. */
  readonly description: string;
  /** Full-fat prompt the subagent sees as user input. */
  readonly prompt: string;
}

export interface SubagentUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_creation_input_tokens?: number;
  readonly cache_read_input_tokens?: number;
  readonly cost_usd?: number;
}

export interface SubagentResult {
  /** Final assistant message text from the subagent. */
  readonly summary: string;
  /** Whether the subagent terminated successfully. */
  readonly status: "success" | "error" | "cancelled" | "max_turns";
  /** Token usage roll-up. */
  readonly usage: SubagentUsage;
}

export interface SubagentService {
  dispatch(input: SubagentDispatchInput): Promise<SubagentResult>;
}
