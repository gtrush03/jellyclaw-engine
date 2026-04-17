/**
 * Skill types + Zod schemas for frontmatter validation.
 *
 * A skill is a markdown file with YAML frontmatter. It lives under one of
 * four search roots (user → project → legacy-user → legacy) and is loaded
 * into an in-memory registry at engine boot. This module defines only shapes
 * and errors; discovery/parsing/registry live in sibling modules.
 */

import { z } from "zod";

/**
 * Which search root a skill was loaded from. First-wins across sources.
 * - user: ~/.jellyclaw/skills (jellyclaw user-scoped)
 * - project: ./.jellyclaw/skills (jellyclaw project-scoped)
 * - legacy-user: ~/.claude/skills (Claude Code user-scoped)
 * - legacy: ./.claude/skills (Claude Code project-scoped)
 */
export type SkillSource = "user" | "project" | "legacy-user" | "legacy";

/** Frontmatter contract, validated at parse time. */
export const SkillFrontmatter = z.object({
  name: z.string().regex(/^[a-z0-9-]+$/, "name must be kebab-case [a-z0-9-]+"),
  description: z.string().min(1).max(1536),
  trigger: z.string().optional(),
  allowed_tools: z.array(z.string()).optional(),
});
export type SkillFrontmatter = z.infer<typeof SkillFrontmatter>;

/** Maximum skill body size in bytes (utf-8). Enforced at parse time. */
export const SKILL_BODY_MAX_BYTES = 8 * 1024;

/** A fully-loaded skill, ready to index. */
export interface Skill {
  readonly name: string;
  readonly frontmatter: SkillFrontmatter;
  readonly body: string;
  readonly path: string;
  readonly source: SkillSource;
  readonly mtimeMs: number;
}

/** A skill file discovered on disk, before parse. */
export interface SkillFile {
  readonly name: string;
  readonly path: string;
  readonly source: SkillSource;
}

/**
 * Thrown when a single skill fails to load. The caller (registry) catches
 * this per-file so one bad skill does not abort the whole engine.
 */
export class SkillLoadError extends Error {
  override readonly name = "SkillLoadError";
  constructor(
    readonly path: string,
    readonly reason: string,
    readonly cause_?: unknown,
  ) {
    super(`Failed to load skill '${path}': ${reason}`);
  }
}
