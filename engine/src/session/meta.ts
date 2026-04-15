/**
 * Phase 09.02 — `.meta.json` sidecar reader/writer.
 *
 * Writes go through a per-call unique `<final>.<randomHex>.tmp` path, then an
 * atomic `rename()` into place. Stale `.tmp` files from earlier crashes are
 * left alone (a retry with the same random suffix is astronomically unlikely,
 * and cleanup is not our responsibility — the CLI housekeeping pass owns it).
 *
 * We intentionally do NOT fsync the parent directory after rename. The design
 * tolerates meta lagging the JSONL by one turn on crash; readers that detect a
 * stale meta re-derive from the JSONL.
 */

import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { z } from "zod";

import type { SessionPaths } from "./paths.js";
import type { SessionMeta } from "./types.js";

// ---------------------------------------------------------------------------
// Zod schema — mirrors SessionMeta exactly, validates version == 1.
// ---------------------------------------------------------------------------

const CumulativeUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  costUsdCents: z.number().nonnegative(),
});

const SessionMetaSchema = z.object({
  version: z.literal(1),
  sessionId: z.string().min(1),
  projectHash: z.string().min(1),
  cwd: z.string(),
  model: z.string().nullable(),
  provider: z.enum(["anthropic", "openrouter"]).nullable(),
  createdAt: z.number().int().nonnegative(),
  lastTurnAt: z.number().int().nonnegative(),
  parentSessionId: z.string().nullable(),
  status: z.enum(["active", "ended", "archived"]),
  summary: z.string().nullable(),
  turns: z.number().int().nonnegative(),
  usage: CumulativeUsageSchema,
});

// ---------------------------------------------------------------------------
// writeSessionMeta
// ---------------------------------------------------------------------------

export async function writeSessionMeta(paths: SessionPaths, meta: SessionMeta): Promise<void> {
  const finalPath = paths.sessionMeta(meta.projectHash, meta.sessionId);
  const dir = dirname(finalPath);
  await mkdir(dir, { recursive: true });

  const suffix = randomBytes(8).toString("hex");
  const tmpPath = `${finalPath}.${suffix}.tmp`;

  // writeFile defaults to "w" — creates or truncates. No append race because
  // the suffix is unique per call.
  await writeFile(tmpPath, JSON.stringify(meta, null, 2), "utf8");
  await rename(tmpPath, finalPath);
}

// ---------------------------------------------------------------------------
// readSessionMeta
// ---------------------------------------------------------------------------

export async function readSessionMeta(
  paths: SessionPaths,
  projectHash: string,
  sessionId: string,
): Promise<SessionMeta | null> {
  const path = paths.sessionMeta(projectHash, sessionId);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`session meta at ${path} is not valid JSON: ${(err as Error).message}`);
  }

  const result = SessionMetaSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`session meta at ${path} failed schema validation: ${result.error.message}`);
  }
  return result.data;
}
