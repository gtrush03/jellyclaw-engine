/**
 * Skill file parser. Reads a file, splits frontmatter from body using
 * `gray-matter`, validates the frontmatter with Zod, and caps the body
 * size. Never returns partial data — throws `SkillLoadError` on any
 * failure so the registry can decide how to cope.
 */

import { readFileSync, statSync } from "node:fs";
import matter from "gray-matter";
import {
  SKILL_BODY_MAX_BYTES,
  type Skill,
  SkillFrontmatter,
  SkillLoadError,
  type SkillSource,
} from "./types.js";

export interface ParseSkillOptions {
  readonly path: string;
  readonly source: SkillSource;
  /** Optional name override (from the containing dir). If set, must match frontmatter. */
  readonly expectedName?: string;
}

export function parseSkillFile(opts: ParseSkillOptions): Skill {
  const { path, source, expectedName } = opts;

  let raw: string;
  let mtimeMs: number;
  try {
    raw = readFileSync(path, "utf8");
    mtimeMs = statSync(path).mtimeMs;
  } catch (err) {
    throw new SkillLoadError(path, "unreadable", err);
  }

  let parsed: ReturnType<typeof matter>;
  try {
    parsed = matter(raw);
  } catch (err) {
    throw new SkillLoadError(path, "malformed YAML frontmatter", err);
  }

  const frontmatterResult = SkillFrontmatter.safeParse(parsed.data);
  if (!frontmatterResult.success) {
    throw new SkillLoadError(
      path,
      `invalid frontmatter: ${frontmatterResult.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ")}`,
    );
  }
  const frontmatter = frontmatterResult.data;

  if (expectedName !== undefined && expectedName !== frontmatter.name) {
    throw new SkillLoadError(
      path,
      `frontmatter name '${frontmatter.name}' does not match containing dir '${expectedName}'`,
    );
  }

  const body = parsed.content;
  const bodyBytes = Buffer.byteLength(body, "utf8");
  if (bodyBytes > SKILL_BODY_MAX_BYTES) {
    throw new SkillLoadError(
      path,
      `body is ${bodyBytes} bytes, exceeds cap of ${SKILL_BODY_MAX_BYTES} bytes`,
    );
  }

  return {
    name: frontmatter.name,
    frontmatter,
    body,
    path,
    source,
    mtimeMs,
  };
}
