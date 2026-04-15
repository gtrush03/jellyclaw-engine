import fs from "node:fs/promises";
import path from "node:path";
import { Hono } from "hono";
import matter from "gray-matter";
import { z } from "zod";
import { PHASES_DIR, assertInsideRepo } from "../lib/paths.js";
import { parseAllPrompts, toSummary } from "../lib/prompt-parser.js";
import { parseCompletionLog } from "../lib/log-parser.js";
import type {
  PhaseDetail,
  PhaseStatus,
  PhaseSummary,
  PromptSummary,
} from "../types.js";

export const phaseRoutes = new Hono();

const PhaseParam = z.string().regex(/^\d{1,2}(?:\.\d+)?$/, {
  message: "phase must be a 1-2 digit number, optionally with a decimal suffix (e.g. 10.5)",
});

interface LoadedPhase {
  phase: string; // zero-padded
  name: string;
  duration: string;
  depends_on: number[];
  blocks: number[];
  body: string;
  filePath: string;
}

async function listPhaseFiles(): Promise<string[]> {
  const entries = await fs.readdir(PHASES_DIR, { withFileTypes: true });
  return entries
    .filter(
      (e) =>
        e.isFile() &&
        e.name.startsWith("PHASE-") &&
        e.name.endsWith(".md") &&
        e.name.toUpperCase() !== "PHASES-README.MD" &&
        e.name.toUpperCase() !== "README.MD",
    )
    .map((e) => path.join(PHASES_DIR, e.name))
    .sort();
}

function asNumberArray(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => Number(x)).filter((n) => !Number.isNaN(n));
}

async function loadPhase(absPath: string): Promise<LoadedPhase | null> {
  assertInsideRepo(absPath);
  try {
    const raw = await fs.readFile(absPath, "utf8");
    const parsed = matter(raw);
    const data = parsed.data as Record<string, unknown>;
    const phaseNum = Number(data.phase);
    if (Number.isNaN(phaseNum)) return null;
    return {
      phase: String(phaseNum).padStart(2, "0"),
      name: typeof data.name === "string" ? data.name : "",
      duration: typeof data.duration === "string" ? data.duration : "",
      depends_on: asNumberArray(data.depends_on),
      blocks: asNumberArray(data.blocks),
      body: parsed.content,
      filePath: absPath,
    };
  } catch (err) {
    console.error(`[phases] failed to load ${absPath}:`, err);
    return null;
  }
}

async function loadAllPhases(): Promise<LoadedPhase[]> {
  const files = await listPhaseFiles();
  const results = await Promise.all(files.map(loadPhase));
  return results
    .filter((p): p is LoadedPhase => p !== null)
    .sort((a, b) => a.phase.localeCompare(b.phase));
}

function summarize(
  p: LoadedPhase,
  promptsForPhase: PromptSummary[],
  phaseStatus: Record<string, PhaseStatus>,
): PhaseSummary {
  const completed = promptsForPhase.filter((pp) => pp.status === "complete").length;
  return {
    phase: p.phase,
    name: p.name,
    duration: p.duration,
    depends_on: p.depends_on,
    blocks: p.blocks,
    promptCount: promptsForPhase.length,
    promptsCompleted: completed,
    status: phaseStatus[p.phase] ?? "not-started",
  };
}

phaseRoutes.get("/phases", async (c) => {
  try {
    const [phases, prompts, clog] = await Promise.all([
      loadAllPhases(),
      parseAllPrompts(),
      parseCompletionLog(),
    ]);
    const byPhase = new Map<string, PromptSummary[]>();
    for (const p of prompts) {
      const summary = toSummary(
        p,
        clog.phaseStatus[p.phase] ?? "not-started",
      );
      const list = byPhase.get(p.phase) ?? [];
      list.push(summary);
      byPhase.set(p.phase, list);
    }
    const summaries = phases.map((ph) =>
      summarize(ph, byPhase.get(ph.phase) ?? [], clog.phaseStatus),
    );
    return c.json({ phases: summaries, count: summaries.length });
  } catch (err) {
    console.error("[GET /api/phases] failed:", err);
    return c.json({ error: "failed to load phases" }, 500);
  }
});

phaseRoutes.get("/phases/:phase", async (c) => {
  const parsed = PhaseParam.safeParse(c.req.param("phase"));
  if (!parsed.success) {
    return c.json({ error: "invalid phase", issues: parsed.error.issues }, 400);
  }
  const num = parsed.data.padStart(2, "0");
  try {
    const [phases, prompts, clog] = await Promise.all([
      loadAllPhases(),
      parseAllPrompts(),
      parseCompletionLog(),
    ]);
    const found = phases.find((p) => p.phase === num);
    if (!found) return c.json({ error: "phase not found" }, 404);
    const promptsForPhase = prompts
      .filter((p) => p.phase === num)
      .map((p) => toSummary(p, clog.phaseStatus[p.phase] ?? "not-started"));
    const detail: PhaseDetail = {
      ...summarize(found, promptsForPhase, clog.phaseStatus),
      body: found.body,
      prompts: promptsForPhase,
    };
    return c.json(detail);
  } catch (err) {
    console.error(`[GET /api/phases/${num}] failed:`, err);
    return c.json({ error: "failed to load phase" }, 500);
  }
});
