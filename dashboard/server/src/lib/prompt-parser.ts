import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { PROMPTS_DIR, STARTUP_TEMPLATE, COMPLETION_TEMPLATE, assertInsideRepo } from "./paths.js";
import type { PromptSummary } from "../types.js";

/**
 * Autobuild-rig frontmatter field: a test definition the rig will run
 * after completion-detection. `kind` is a discriminator; kind-specific
 * fields pass through via the index signature.
 */
export interface PromptTest {
  name: string;
  kind: "jellyclaw-run" | "smoke-suite" | "http-roundtrip" | "shell";
  description?: string;
  [k: string]: unknown;
}

/**
 * Metadata scraped from the top of a prompt markdown file.
 * These live as `**Key:** value` lines above the session-startup block.
 * Autobuild-rig fields (tier, tests, …) come from YAML frontmatter — they're
 * all optional so prompts in the old format continue to parse.
 */
export interface ParsedPrompt {
  id: string;
  phase: string;
  subPrompt: string;
  title: string;
  whenToRun: string | null;
  duration: string | null;
  newSession: string | null;
  model: string | null;
  filePath: string;
  /** Full raw file content */
  raw: string;
  /** The task body — between the SESSION STARTUP and SESSION CLOSEOUT markers, markers stripped */
  body: string;
  // ---------- optional autobuild-rig frontmatter ----------
  tier?: 0 | 1 | 2 | 3 | 4;
  scope?: string[];
  depends_on_fix?: string[];
  tests?: PromptTest[];
  human_gate?: boolean;
  max_turns?: number;
  max_cost_usd?: number;
  max_retries?: number;
  estimated_duration_min?: number;
}

const STARTUP_BEGIN = "<!-- BEGIN SESSION STARTUP -->";
const STARTUP_END = "<!-- END SESSION STARTUP -->";
const CLOSEOUT_BEGIN = "<!-- BEGIN SESSION CLOSEOUT -->";
const CLOSEOUT_END = "<!-- END SESSION CLOSEOUT -->";

function extractMetaLine(raw: string, key: string): string | null {
  // Matches e.g. **When to run:** value
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`\\*\\*${escaped}:?\\*\\*\\s*(.+?)\\s*$`, "mi");
  const m = raw.match(re);
  return m ? m[1].trim() : null;
}

function extractTitle(raw: string): string {
  // First H1
  const m = raw.match(/^#\s+(.+?)\s*$/m);
  return m ? m[1].trim() : "(untitled prompt)";
}

/**
 * The prompt "body" is everything outside the STARTUP/CLOSEOUT blocks.
 * We keep the task content. We strip the STARTUP block entirely (that is what
 * the assembled prompt replaces with the template). Same for CLOSEOUT.
 */
function extractBody(raw: string): string {
  let out = raw;
  const sIdx = out.indexOf(STARTUP_BEGIN);
  const sEnd = out.indexOf(STARTUP_END);
  if (sIdx >= 0 && sEnd > sIdx) {
    out = out.slice(0, sIdx) + out.slice(sEnd + STARTUP_END.length);
  }
  const cIdx = out.indexOf(CLOSEOUT_BEGIN);
  const cEnd = out.indexOf(CLOSEOUT_END);
  if (cIdx >= 0 && cEnd > cIdx) {
    out = out.slice(0, cIdx) + out.slice(cEnd + CLOSEOUT_END.length);
  }
  return out.trim();
}

const VALID_TIERS = new Set([0, 1, 2, 3, 4]);
const VALID_TEST_KINDS = new Set(["jellyclaw-run", "smoke-suite", "http-roundtrip", "shell"]);

function asOptionalNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (!Number.isNaN(n)) return n;
  }
  return undefined;
}

function asOptionalBoolean(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  return undefined;
}

function asOptionalStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === "string");
  return out.length === v.length ? out : undefined;
}

function asOptionalTier(v: unknown): 0 | 1 | 2 | 3 | 4 | undefined {
  const n = asOptionalNumber(v);
  if (n === undefined) return undefined;
  if (!VALID_TIERS.has(n)) return undefined;
  return n as 0 | 1 | 2 | 3 | 4;
}

function asOptionalTests(v: unknown): PromptTest[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: PromptTest[] = [];
  for (const entry of v) {
    if (!entry || typeof entry !== "object") continue;
    const obj = entry as Record<string, unknown>;
    const name = obj.name;
    const kind = obj.kind;
    if (typeof name !== "string" || typeof kind !== "string") continue;
    if (!VALID_TEST_KINDS.has(kind)) continue;
    const { name: _n, kind: _k, description, ...rest } = obj;
    const test: PromptTest = {
      name,
      kind: kind as PromptTest["kind"],
      ...rest,
    };
    if (typeof description === "string") test.description = description;
    out.push(test);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Given an absolute path to a prompt file (must be under PROMPTS_DIR), parse it.
 */
export async function parsePromptFile(absPath: string): Promise<ParsedPrompt> {
  assertInsideRepo(absPath);
  const raw = await fs.readFile(absPath, "utf8");
  // gray-matter is tolerant: if the file has no frontmatter it returns content=raw.
  const parsed = matter(raw);
  const content = parsed.content;
  const data = (parsed.data ?? {}) as Record<string, unknown>;

  const rel = path.relative(PROMPTS_DIR, absPath);
  // rel = "phase-01/02-implement.md"
  const parts = rel.split(path.sep);
  const phaseDir = parts[0] ?? "";
  const file = parts[parts.length - 1] ?? "";
  const phase = phaseDir.replace(/^phase-/, "");
  const subPrompt = file.replace(/\.md$/i, "");
  const id = `${phaseDir}/${subPrompt}`;

  // Base prompt shape — old format compatibility, all new fields optional.
  const out: ParsedPrompt = {
    id,
    phase,
    subPrompt,
    title: extractTitle(content),
    whenToRun: extractMetaLine(content, "When to run"),
    duration: extractMetaLine(content, "Estimated duration"),
    newSession: extractMetaLine(content, "New session?"),
    model: extractMetaLine(content, "Model"),
    filePath: absPath,
    raw,
    body: extractBody(content),
  };

  // Merge optional autobuild-rig frontmatter. Skip any field that doesn't
  // validate — never let malformed YAML wedge the entire prompt list.
  const tier = asOptionalTier(data.tier);
  if (tier !== undefined) out.tier = tier;
  const scope = asOptionalStringArray(data.scope);
  if (scope) out.scope = scope;
  const dependsOnFix = asOptionalStringArray(data.depends_on_fix);
  if (dependsOnFix) out.depends_on_fix = dependsOnFix;
  const tests = asOptionalTests(data.tests);
  if (tests) out.tests = tests;
  const humanGate = asOptionalBoolean(data.human_gate);
  if (humanGate !== undefined) out.human_gate = humanGate;
  const maxTurns = asOptionalNumber(data.max_turns);
  if (maxTurns !== undefined) out.max_turns = maxTurns;
  const maxCostUsd = asOptionalNumber(data.max_cost_usd);
  if (maxCostUsd !== undefined) out.max_cost_usd = maxCostUsd;
  const maxRetries = asOptionalNumber(data.max_retries);
  if (maxRetries !== undefined) out.max_retries = maxRetries;
  const estDur = asOptionalNumber(data.estimated_duration_min);
  if (estDur !== undefined) out.estimated_duration_min = estDur;

  return out;
}

/**
 * Walks PROMPTS_DIR for every `phase-NN/*.md`. Skips:
 * - `session-starters/`
 * - any README / DEPENDENCY-GRAPH files
 * Returns absolute paths.
 */
export async function listPromptFiles(): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(PROMPTS_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith("phase-")) continue;
    const dir = path.join(PROMPTS_DIR, entry.name);
    let children: import("node:fs").Dirent[];
    try {
      children = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children) {
      if (!child.isFile()) continue;
      if (!child.name.endsWith(".md")) continue;
      const upper = child.name.toUpperCase();
      if (upper === "README.MD" || upper.startsWith("DEPENDENCY")) continue;
      out.push(path.join(dir, child.name));
    }
  }
  out.sort();
  return out;
}

export async function parseAllPrompts(): Promise<ParsedPrompt[]> {
  const files = await listPromptFiles();
  const results = await Promise.all(
    files.map(async (f) => {
      try {
        return await parsePromptFile(f);
      } catch (err) {
        console.error(`[prompt-parser] failed to parse ${f}:`, err);
        return null;
      }
    }),
  );
  return results.filter((p): p is ParsedPrompt => p !== null);
}

export function toSummary(p: ParsedPrompt, status: PromptSummary["status"]): PromptSummary {
  const base: PromptSummary = {
    id: p.id,
    phase: p.phase,
    subPrompt: p.subPrompt,
    title: p.title,
    whenToRun: p.whenToRun,
    duration: p.duration,
    newSession: p.newSession,
    model: p.model,
    filePath: p.filePath,
    status,
  };
  if (p.tier !== undefined) base.tier = p.tier;
  if (p.scope !== undefined) base.scope = p.scope;
  if (p.depends_on_fix !== undefined) base.depends_on_fix = p.depends_on_fix;
  if (p.tests !== undefined) base.tests = p.tests;
  if (p.human_gate !== undefined) base.human_gate = p.human_gate;
  if (p.max_turns !== undefined) base.max_turns = p.max_turns;
  if (p.max_cost_usd !== undefined) base.max_cost_usd = p.max_cost_usd;
  if (p.max_retries !== undefined) base.max_retries = p.max_retries;
  if (p.estimated_duration_min !== undefined)
    base.estimated_duration_min = p.estimated_duration_min;
  return base;
}

/**
 * Read the two session-starter templates once and cache in-memory.
 * Re-read on each call to stay reactive to edits; templates are tiny.
 */
async function readTemplates(): Promise<{ startup: string; closeout: string }> {
  const [startup, closeout] = await Promise.all([
    fs.readFile(STARTUP_TEMPLATE, "utf8"),
    fs.readFile(COMPLETION_TEMPLATE, "utf8"),
  ]);
  return { startup, closeout };
}

function substitute(
  text: string,
  subs: { NN: string; phaseName: string; subPrompt: string },
): string {
  return text
    .replace(/<NN>/g, subs.NN)
    .replace(/<phase-name>/g, subs.phaseName)
    .replace(/<sub-prompt>/g, subs.subPrompt);
}

/**
 * Extract the phase display name from the prompt's H1.
 * Format: "# Phase NN — <Phase name> — Prompt XX: <subtitle>"
 */
export function extractPhaseName(title: string): string {
  const m = title.match(/Phase\s+\d+\s+[—-]\s+(.+?)\s+[—-]\s+Prompt/i);
  if (m) return m[1].trim();
  // Fallback: second segment after em-dash
  const parts = title
    .split(/[—-]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length >= 2) return parts[1];
  return title;
}

/**
 * Assemble a copy-pasteable prompt: startup template + task body + closeout template,
 * with `<NN>`, `<phase-name>`, `<sub-prompt>` substituted throughout.
 */
export async function assemblePrompt(absPath: string): Promise<{
  assembled: string;
  parsed: ParsedPrompt;
}> {
  const parsed = await parsePromptFile(absPath);
  const { startup, closeout } = await readTemplates();
  const phaseName = extractPhaseName(parsed.title);
  const subs = {
    NN: parsed.phase,
    phaseName,
    subPrompt: parsed.subPrompt,
  };
  const assembled = [
    substitute(startup, subs),
    "",
    "---",
    "",
    substitute(parsed.body, subs),
    "",
    "---",
    "",
    substitute(closeout, subs),
  ].join("\n");
  return { assembled, parsed };
}
