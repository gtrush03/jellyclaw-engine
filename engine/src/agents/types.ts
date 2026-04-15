/**
 * Subagent types + Zod schemas for frontmatter validation.
 *
 * A subagent is a markdown file with YAML frontmatter (mirroring Claude
 * Code's agent file format). It lives under one of three search roots
 * (user → project → legacy) and is loaded into an in-memory registry at
 * engine boot. This module defines only shapes and errors; discovery,
 * parsing, and the registry live in sibling modules.
 *
 * NOTE: Only definition + discovery + registry land in Phase 06 Prompt 01.
 * Dispatch (running a subagent) lives in Prompt 02; hook-propagation
 * verification lives in Prompt 03.
 */

import { z } from "zod";

/** Which search root a subagent was loaded from. First-wins across sources. */
export type AgentSource = "user" | "project" | "legacy";

/**
 * Allowed tool-name syntax at load time. Built-in tool names are
 * PascalCase; MCP tools use the `mcp__<server>__<tool>` convention. This
 * is a *syntactic* check only — existence of the tool is verified at
 * dispatch time.
 */
const TOOL_NAME_RE =
  /^(Bash|Read|Write|Edit|Grep|Glob|Task|WebFetch|WebSearch|TodoWrite|NotebookEdit|mcp__[a-z0-9_-]+__[a-z0-9_-]+)$/;

/**
 * Frontmatter contract, validated at parse time.
 *
 * Mirrors Claude Code's subagent file format. The body (system prompt)
 * is stored separately on the loaded `Agent` object, not in the
 * frontmatter.
 *
 * `.strict()` rejects unknown keys so typos surface as load errors
 * rather than silently degrading behavior.
 */
export const AgentFrontmatter = z
  .object({
    name: z.string().regex(/^[a-z0-9-]+$/, "name must be kebab-case [a-z0-9-]+"),
    description: z.string().min(1).max(1024),
    mode: z.enum(["subagent", "primary"]).default("subagent"),
    model: z.string().min(1).optional(),
    tools: z
      .array(
        z
          .string()
          .regex(
            TOOL_NAME_RE,
            "tool name must be a built-in (PascalCase) or `mcp__<server>__<tool>`",
          ),
      )
      .optional(),
    skills: z.array(z.string().regex(/^[a-z0-9-]+$/)).optional(),
    max_turns: z.number().int().positive().max(100).default(20),
    max_tokens: z.number().int().positive().default(100_000),
  })
  .strict();
export type AgentFrontmatter = z.infer<typeof AgentFrontmatter>;

/** Maximum subagent body size in bytes (utf-8). Enforced at parse time. */
export const AGENT_BODY_MAX_BYTES = 16 * 1024;

/** A fully-loaded subagent, ready to index. */
export interface Agent {
  readonly name: string;
  readonly frontmatter: AgentFrontmatter;
  /** System prompt. Trimmed. Non-empty. */
  readonly prompt: string;
  readonly path: string;
  readonly source: AgentSource;
  readonly mtimeMs: number;
}

/** A subagent file discovered on disk, before parse. */
export interface AgentFile {
  readonly name: string;
  readonly path: string;
  readonly source: AgentSource;
}

/**
 * Thrown when a single subagent file fails to load. The caller
 * (registry) catches this per-file so one bad agent does not abort the
 * whole engine.
 */
export class AgentLoadError extends Error {
  override readonly name = "AgentLoadError";
  constructor(
    readonly path: string,
    readonly reason: string,
    readonly cause_?: unknown,
  ) {
    super(`Failed to load agent '${path}': ${reason}`);
  }
}
