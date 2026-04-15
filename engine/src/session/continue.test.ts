import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AgentEvent } from "../events.js";
import { continueSession, findLatestForProject } from "./continue.js";
import type { Db } from "./db.js";
import { openDb } from "./db.js";
import { projectHash, SessionPaths } from "./paths.js";
import { NoSessionForProjectError } from "./types.js";
import { SessionWriter, type UpsertSessionInput } from "./writer.js";

function mkSession(
  input: Partial<UpsertSessionInput> & { id: string; projectHash: string; lastTurnAt: number },
): UpsertSessionInput {
  return {
    cwd: input.cwd ?? "/tmp/project",
    model: input.model ?? null,
    createdAt: input.createdAt ?? 1,
    parentSessionId: input.parentSessionId ?? null,
    status: input.status ?? "active",
    summary: input.summary ?? null,
    ...input,
  };
}

function writeJsonl(path: string, events: readonly AgentEvent[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${events.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8");
}

describe("findLatestForProject / continueSession", () => {
  let home: string;
  let paths: SessionPaths;
  let db: Db;
  let writer: SessionWriter;

  const cwdA = "/tmp/project-A";
  const cwdB = "/tmp/project-B";
  const hashA = projectHash(cwdA);
  const hashB = projectHash(cwdB);

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "jellyclaw-continue-"));
    paths = new SessionPaths({ home });
    db = await openDb({ paths });
    writer = new SessionWriter(db);
  });

  afterEach(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("findLatestForProject returns newest session for project A", async () => {
    await writer.upsertSession(
      mkSession({ id: "a-old", projectHash: hashA, cwd: cwdA, lastTurnAt: 1000 }),
    );
    await writer.upsertSession(
      mkSession({ id: "a-new", projectHash: hashA, cwd: cwdA, lastTurnAt: 2000 }),
    );
    await writer.upsertSession(
      mkSession({ id: "b-1", projectHash: hashB, cwd: cwdB, lastTurnAt: 9000 }),
    );

    const latest = await findLatestForProject(db, hashA);
    expect(latest?.id).toBe("a-new");
    expect(latest?.lastTurnAt).toBe(2000);
  });

  it("findLatestForProject returns null when no sessions for project", async () => {
    const latest = await findLatestForProject(db, "nopehash00000");
    expect(latest).toBeNull();
  });

  it("continueSession rehydrates the latest session for cwd", async () => {
    const sessionId = "a-new";
    await writer.upsertSession(
      mkSession({ id: "a-old", projectHash: hashA, cwd: cwdA, lastTurnAt: 100 }),
    );
    await writer.upsertSession(
      mkSession({ id: sessionId, projectHash: hashA, cwd: cwdA, lastTurnAt: 200 }),
    );

    const events: AgentEvent[] = [
      {
        type: "session.started",
        session_id: sessionId,
        seq: 0,
        ts: 1,
        wish: "continue me",
        agent: "default",
        model: "m",
        provider: "anthropic",
        cwd: cwdA,
      },
      { type: "agent.message", session_id: sessionId, seq: 1, ts: 2, delta: "back", final: true },
    ];
    writeJsonl(paths.sessionLog(hashA, sessionId), events);

    const state = await continueSession({ paths, db, cwd: cwdA });
    expect(state.sessionId).toBe(sessionId);
    expect(state.messages).toHaveLength(2);
  });

  it("continueSession throws NoSessionForProjectError when cwd has no sessions", async () => {
    await expect(
      continueSession({ paths, db, cwd: "/tmp/unknown-project" }),
    ).rejects.toBeInstanceOf(NoSessionForProjectError);
  });
});
