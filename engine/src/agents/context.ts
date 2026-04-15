/**
 * Pure subagent context builder (Phase 06 Prompt 02).
 *
 * Given a loaded `Agent`, the caller's `ParentContext`, and dispatch
 * `DispatchConfig`, produce the fully-resolved `SubagentContext` handed
 * to `SessionRunner.run()`. No I/O, no side effects — every branch is
 * unit-testable.
 *
 * Rules enforced here:
 *   - Depth guard: child depth = parent.depth + 1, must be <= maxDepth.
 *   - Tool intersection: agent-requested tools ∩ parent.allowedTools,
 *     preserving the agent's requested order and de-duplicating.
 *     When the agent omits `tools`, it inherits parent.allowedTools.
 *   - Empty intersection is an error (NoUsableToolsError).
 *   - Model fallback: agent.frontmatter.model ?? parent.model.
 *   - systemPrompt: `${claudeMd}\n\n${agent.prompt}` if claudeMd is
 *     present and non-empty; otherwise just agent.prompt.
 */

import {
  type DispatchConfig,
  NoUsableToolsError,
  type ParentContext,
  type SubagentContext,
  SubagentDepthExceededError,
} from "./dispatch-types.js";
import type { Agent } from "./types.js";

export interface BuildSubagentContextArgs {
  readonly agent: Agent;
  readonly parent: ParentContext;
  readonly description: string;
  readonly prompt: string;
  readonly config: DispatchConfig;
  readonly subagentSessionId: string;
}

export function buildSubagentContext(args: BuildSubagentContextArgs): SubagentContext {
  const { agent, parent, description, prompt, config, subagentSessionId } = args;

  // 1. Depth guard.
  const depth = parent.depth + 1;
  if (depth > config.maxDepth) {
    throw new SubagentDepthExceededError(depth, config.maxDepth);
  }

  // 2. Requested tool set (agent override or parent inheritance).
  const requested: readonly string[] = agent.frontmatter.tools ?? parent.allowedTools;

  // 3. Intersect with parent cap, preserving request order, de-duplicating.
  const parentSet = new Set(parent.allowedTools);
  const seen = new Set<string>();
  const allowedTools: string[] = [];
  for (const tool of requested) {
    if (parentSet.has(tool) && !seen.has(tool)) {
      seen.add(tool);
      allowedTools.push(tool);
    }
  }
  if (allowedTools.length === 0) {
    throw new NoUsableToolsError(agent.name, requested, parent.allowedTools);
  }

  // 4-7. Resolve model, skills, turn/token limits.
  const model = agent.frontmatter.model ?? parent.model;
  const skills: readonly string[] = agent.frontmatter.skills ?? [];
  const maxTurns = agent.frontmatter.max_turns;
  const maxTokens = agent.frontmatter.max_tokens;

  // 8. System prompt = optional CLAUDE.md prefix + agent body.
  const claudeMd = parent.claudeMd;
  const systemPrompt =
    claudeMd !== undefined && claudeMd.length > 0 ? `${claudeMd}\n\n${agent.prompt}` : agent.prompt;

  // 9. Build the isolated context.
  return {
    subagentSessionId,
    parentSessionId: parent.sessionId,
    agentName: agent.name,
    description,
    prompt,
    systemPrompt,
    model,
    allowedTools,
    skills,
    maxTurns,
    maxTokens,
    depth,
  };
}
