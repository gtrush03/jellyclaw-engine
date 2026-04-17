/**
 * Build a progressive-disclosure skill injection block for the system prompt.
 *
 * The engine advertises available skills to the model via a compact, byte-capped
 * block of `skill:<name> — <description>` lines. Skills are sorted by source
 * priority (user > project > legacy), then alphabetically, then greedily packed
 * under a byte cap. Skills that don't fit are dropped and logged once.
 */

import type { Logger } from "../logger.js";
import type { Skill, SkillSource } from "./types.js";

export interface BuildInjectionOptions {
  skills: Skill[];
  logger?: Logger;
  /** total byte cap on the rendered block (utf-8). Default: 1536. */
  maxBytes?: number;
}

export interface InjectionResult {
  /** The rendered block (empty string if no skills). */
  block: string;
  /** Names of skills that fit under the cap, in emission order. */
  included: string[];
  /** Names of skills dropped due to cap, in source+alpha order. */
  dropped: string[];
}

export const DEFAULT_INJECTION_MAX_BYTES = 1536;

const HEADER = "# Available skills (invoke by name via the Skill tool):\n";

const SOURCE_PRIORITY: Record<SkillSource, number> = {
  user: 0,
  project: 1,
  "legacy-user": 2,
  legacy: 3,
};

function compareSkills(a: Skill, b: Skill): number {
  const pa = SOURCE_PRIORITY[a.source];
  const pb = SOURCE_PRIORITY[b.source];
  if (pa !== pb) return pa - pb;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function renderLine(skill: Skill): string {
  return `- skill:${skill.name} — ${skill.frontmatter.description}\n`;
}

export function buildSkillInjection(opts: BuildInjectionOptions): InjectionResult {
  const maxBytes = opts.maxBytes ?? DEFAULT_INJECTION_MAX_BYTES;
  const sorted = [...opts.skills].sort(compareSkills);

  if (sorted.length === 0) {
    return { block: "", included: [], dropped: [] };
  }

  const included: string[] = [];
  const dropped: string[] = [];

  const headerBytes = Buffer.byteLength(HEADER, "utf8");
  if (headerBytes > maxBytes) {
    for (const s of sorted) dropped.push(s.name);
    opts.logger?.warn(
      { dropped, maxBytes },
      "skill injection exceeded cap; lowest-priority skills dropped",
    );
    return { block: "", included, dropped };
  }

  let block = HEADER;
  for (const skill of sorted) {
    const line = renderLine(skill);
    const candidate = block + line;
    if (Buffer.byteLength(candidate, "utf8") <= maxBytes) {
      block = candidate;
      included.push(skill.name);
    } else {
      dropped.push(skill.name);
    }
  }

  if (included.length === 0) {
    // Nothing fit — do not emit a header-only block.
    if (dropped.length > 0) {
      opts.logger?.warn(
        { dropped, maxBytes },
        "skill injection exceeded cap; lowest-priority skills dropped",
      );
    }
    return { block: "", included, dropped };
  }

  if (dropped.length > 0) {
    opts.logger?.warn(
      { dropped, maxBytes },
      "skill injection exceeded cap; lowest-priority skills dropped",
    );
  }

  return { block, included, dropped };
}
