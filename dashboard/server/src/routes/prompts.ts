import fs from "node:fs/promises";
import { Hono } from "hono";
import { z } from "zod";
import {
  parseAllPrompts,
  parsePromptFile,
  assemblePrompt,
  toSummary,
} from "../lib/prompt-parser.js";
import { parseCompletionLog } from "../lib/log-parser.js";
import { PROMPTS_DIR, assertInsideRepo } from "../lib/paths.js";
import path from "node:path";
import type { PhaseStatus } from "../types.js";

export const promptRoutes = new Hono();

const IdParam = z
  .string()
  .min(1)
  .max(128)
  .regex(/^phase-[a-z0-9][a-z0-9.\-]*\/[a-z0-9][a-z0-9.\-]*$/i, {
    message: "id must look like 'phase-01/02-implement', 'phase-10.5/01-implement', or 'phase-99b-unfucking-v2/T0-01-slug'",
  });

function deriveStatus(
  phase: string,
  phaseStatus: Record<string, PhaseStatus>,
): PhaseStatus {
  return phaseStatus[phase] ?? "not-started";
}

function idToPath(id: string): string {
  // id is "phase-NN/slug" — becomes "<PROMPTS_DIR>/phase-NN/slug.md"
  const unsafe = path.join(PROMPTS_DIR, `${id}.md`);
  return assertInsideRepo(unsafe);
}

promptRoutes.get("/prompts", async (c) => {
  try {
    const [prompts, clog] = await Promise.all([
      parseAllPrompts(),
      parseCompletionLog(),
    ]);
    const summaries = prompts.map((p) =>
      toSummary(p, deriveStatus(p.phase, clog.phaseStatus)),
    );
    return c.json({ prompts: summaries, count: summaries.length });
  } catch (err) {
    console.error("[GET /api/prompts] failed:", err);
    return c.json({ error: "failed to list prompts" }, 500);
  }
});

promptRoutes.get("/prompts/:phase/:slug", async (c) => {
  const id = `${c.req.param("phase")}/${c.req.param("slug")}`;
  const parsed = IdParam.safeParse(id);
  if (!parsed.success) {
    return c.json({ error: "invalid id", issues: parsed.error.issues }, 400);
  }
  let absPath: string;
  try {
    absPath = idToPath(parsed.data);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }

  try {
    const [{ assembled, parsed: p }, clog] = await Promise.all([
      assemblePrompt(absPath),
      parseCompletionLog(),
    ]);
    const summary = toSummary(p, deriveStatus(p.phase, clog.phaseStatus));
    return c.json({ ...summary, assembled });
  } catch (err) {
    const msg = (err as NodeJS.ErrnoException).code === "ENOENT"
      ? "prompt not found"
      : (err as Error).message;
    const statusCode: 404 | 500 =
      (err as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 500;
    console.error(`[GET /api/prompts/${id}] failed:`, err);
    return c.json({ error: msg }, statusCode);
  }
});

promptRoutes.get("/prompts/:phase/:slug/raw", async (c) => {
  const id = `${c.req.param("phase")}/${c.req.param("slug")}`;
  const parsed = IdParam.safeParse(id);
  if (!parsed.success) {
    return c.json({ error: "invalid id", issues: parsed.error.issues }, 400);
  }
  let absPath: string;
  try {
    absPath = idToPath(parsed.data);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }

  try {
    const p = await parsePromptFile(absPath);
    return c.json({ id: p.id, filePath: p.filePath, raw: p.raw });
  } catch (err) {
    const statusCode: 404 | 500 =
      (err as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 500;
    console.error(`[GET /api/prompts/${id}/raw] failed:`, err);
    return c.json(
      {
        error:
          statusCode === 404 ? "prompt not found" : (err as Error).message,
      },
      statusCode,
    );
  }
});

// Surface fs access explicitly — helps callers know the server is alive.
promptRoutes.get("/prompts-health", async (c) => {
  try {
    await fs.access(PROMPTS_DIR);
    return c.json({ ok: true, dir: PROMPTS_DIR });
  } catch {
    return c.json({ ok: false, dir: PROMPTS_DIR }, 500);
  }
});
