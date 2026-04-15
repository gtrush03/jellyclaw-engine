/**
 * Phase 09.02 — `sessions continue` resolver.
 *
 * Finds the most-recently-touched session for a given cwd (via project hash)
 * and delegates to `resumeSession` to rehydrate it.
 */

import type { Logger } from "pino";

import type { Db } from "./db.js";
import { projectHash as computeProjectHash, type SessionPaths } from "./paths.js";
import { resumeSession } from "./resume.js";
import {
  type EngineState,
  NoSessionForProjectError,
  type ResumeOptions,
  type SessionListRow,
} from "./types.js";

interface LatestRow {
  id: string;
  project_hash: string;
  cwd: string;
  model: string | null;
  status: "active" | "ended" | "archived";
  created_at: number;
  last_turn_at: number;
  summary: string | null;
}

export async function findLatestForProject(
  db: Db,
  projectHashStr: string,
): Promise<SessionListRow | null> {
  // better-sqlite3 is synchronous; the single `await` below lets the function
  // be genuinely async (biome's `useAwait` + future-proofing for when we
  // move to an async driver).
  await Promise.resolve();

  const row = db.raw
    .prepare(
      `SELECT id, project_hash, cwd, model, status, created_at, last_turn_at, summary
         FROM sessions
        WHERE project_hash = ?
        ORDER BY last_turn_at DESC
        LIMIT 1`,
    )
    .get(projectHashStr) as LatestRow | undefined;

  if (!row) return null;

  return {
    id: row.id,
    projectHash: row.project_hash,
    cwd: row.cwd,
    model: row.model,
    status: row.status,
    createdAt: row.created_at,
    lastTurnAt: row.last_turn_at,
    summary: row.summary,
  };
}

export interface ContinueInputs {
  readonly paths: SessionPaths;
  readonly db: Db;
  /** Caller passes `process.cwd()`; we hash it. */
  readonly cwd: string;
  readonly resumeOptions?: ResumeOptions;
  readonly logger?: Logger;
}

export async function continueSession(inputs: ContinueInputs): Promise<EngineState> {
  const hash = computeProjectHash(inputs.cwd);
  const latest = await findLatestForProject(inputs.db, hash);
  if (!latest) throw new NoSessionForProjectError(hash);

  return resumeSession({
    sessionId: latest.id,
    paths: inputs.paths,
    projectHash: latest.projectHash,
    db: inputs.db,
    ...(inputs.resumeOptions ? { resumeOptions: inputs.resumeOptions } : {}),
    ...(inputs.logger ? { logger: inputs.logger } : {}),
  });
}
