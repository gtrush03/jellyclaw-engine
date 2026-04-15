/**
 * Subagent file parser. Reads a file, splits frontmatter from body using
 * `gray-matter`, validates the frontmatter with Zod, caps the body size,
 * and trims the body into a non-empty system prompt. Never returns
 * partial data — throws `AgentLoadError` on any failure so the registry
 * can decide how to cope.
 */

import { readFileSync, statSync } from "node:fs";
import matter from "gray-matter";
import {
  AGENT_BODY_MAX_BYTES,
  type Agent,
  AgentFrontmatter,
  AgentLoadError,
  type AgentSource,
} from "./types.js";

export interface ParseAgentOptions {
  readonly path: string;
  readonly source: AgentSource;
  /** Optional name override (from the containing dir or file). If set, must match frontmatter. */
  readonly expectedName?: string;
}

export function parseAgentFile(opts: ParseAgentOptions): Agent {
  const { path, source, expectedName } = opts;

  let raw: string;
  let mtimeMs: number;
  try {
    raw = readFileSync(path, "utf8");
    mtimeMs = statSync(path).mtimeMs;
  } catch (err) {
    throw new AgentLoadError(path, "unreadable", err);
  }

  let parsed: ReturnType<typeof matter>;
  try {
    parsed = matter(raw);
  } catch (err) {
    throw new AgentLoadError(path, "malformed YAML frontmatter", err);
  }

  const frontmatterResult = AgentFrontmatter.safeParse(parsed.data);
  if (!frontmatterResult.success) {
    throw new AgentLoadError(
      path,
      `invalid frontmatter: ${frontmatterResult.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ")}`,
    );
  }
  const frontmatter = frontmatterResult.data;

  if (expectedName !== undefined && expectedName !== frontmatter.name) {
    throw new AgentLoadError(
      path,
      `frontmatter name '${frontmatter.name}' does not match expected '${expectedName}'`,
    );
  }

  const body = parsed.content;
  const bodyBytes = Buffer.byteLength(body, "utf8");
  if (bodyBytes > AGENT_BODY_MAX_BYTES) {
    throw new AgentLoadError(
      path,
      `body is ${bodyBytes} bytes, exceeds cap of ${AGENT_BODY_MAX_BYTES} bytes`,
    );
  }

  const prompt = body.trim();
  if (prompt.length === 0) {
    throw new AgentLoadError(path, "empty body");
  }

  return {
    name: frontmatter.name,
    frontmatter,
    prompt,
    path,
    source,
    mtimeMs,
  };
}
