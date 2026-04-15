import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import {
  PROMPTS_DIR,
  STARTUP_TEMPLATE,
  COMPLETION_TEMPLATE,
  assertInsideRepo,
} from "./paths.js";
import type { PromptSummary } from "../types.js";

/**
 * Metadata scraped from the top of a prompt markdown file.
 * These live as `**Key:** value` lines above the session-startup block.
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

/**
 * Given an absolute path to a prompt file (must be under PROMPTS_DIR), parse it.
 */
export async function parsePromptFile(absPath: string): Promise<ParsedPrompt> {
  assertInsideRepo(absPath);
  const raw = await fs.readFile(absPath, "utf8");
  // gray-matter is tolerant: if the file has no frontmatter it returns content=raw.
  const parsed = matter(raw);
  const content = parsed.content;

  const rel = path.relative(PROMPTS_DIR, absPath);
  // rel = "phase-01/02-implement.md"
  const parts = rel.split(path.sep);
  const phaseDir = parts[0] ?? "";
  const file = parts[parts.length - 1] ?? "";
  const phase = phaseDir.replace(/^phase-/, "");
  const subPrompt = file.replace(/\.md$/i, "");
  const id = `${phaseDir}/${subPrompt}`;

  return {
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

export function toSummary(
  p: ParsedPrompt,
  status: PromptSummary["status"],
): PromptSummary {
  return {
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
  const parts = title.split(/[—-]/).map((s) => s.trim()).filter(Boolean);
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
