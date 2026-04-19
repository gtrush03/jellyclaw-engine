// prompt-parser.mjs — read a phase-99b prompt file, split frontmatter + body.
// The frontmatter is YAML; gray-matter handles it. We do just enough
// shape-checking to fail loudly on missing required fields.

import { readFileSync } from "node:fs";
import matter from "gray-matter";

const REQUIRED = ["id", "tier", "title", "scope", "tests"];

export function parsePrompt(filePath) {
  const raw = readFileSync(filePath, "utf8");
  const parsed = matter(raw);
  const data = parsed.data || {};
  const missing = REQUIRED.filter((k) => data[k] === undefined);
  if (missing.length) {
    throw new Error(
      `prompt at ${filePath} is missing required frontmatter fields: ${missing.join(", ")}`,
    );
  }
  if (!Array.isArray(data.scope) || data.scope.length === 0) {
    throw new Error(`prompt at ${filePath} has empty scope[]`);
  }
  if (!Array.isArray(data.tests)) {
    throw new Error(`prompt at ${filePath} has non-array tests`);
  }
  return {
    id: String(data.id),
    tier: Number(data.tier),
    title: String(data.title),
    scope: data.scope.map(String),
    depends_on_fix: Array.isArray(data.depends_on_fix) ? data.depends_on_fix.map(String) : [],
    tests: data.tests,
    human_gate: Boolean(data.human_gate),
    max_turns: Number(data.max_turns ?? 25),
    max_cost_usd: Number(data.max_cost_usd ?? 10),
    max_retries: Number(data.max_retries ?? 5),
    estimated_duration_min: Number(data.estimated_duration_min ?? 0),
    body: parsed.content,
    rawFrontmatter: data,
    filePath,
  };
}
