import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "./db.js";
import { openDb } from "./db.js";
import { searchMessages } from "./fts.js";
import { SessionPaths } from "./paths.js";
import type { UpsertSessionInput } from "./writer.js";
import { SessionWriter } from "./writer.js";

function makeSession(id = "sess-fts"): UpsertSessionInput {
  return {
    id,
    projectHash: "abcdef012345",
    cwd: "/tmp/project",
    model: null,
    createdAt: 1,
    lastTurnAt: 1,
    parentSessionId: null,
    status: "active",
    summary: null,
  };
}

describe("fts.searchMessages", () => {
  let home: string;
  let db: Db;
  let writer: SessionWriter;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "jellyclaw-fts-"));
    db = await openDb({ paths: new SessionPaths({ home }) });
    writer = new SessionWriter(db);
    await writer.upsertSession(makeSession());
  });

  afterEach(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("finds messages and returns highlighted snippet", async () => {
    await writer.appendMessage({
      sessionId: "sess-fts",
      turnIndex: 0,
      role: "user",
      content: "how do I fix this auth bug please",
      ts: 10,
    });
    await writer.appendMessage({
      sessionId: "sess-fts",
      turnIndex: 1,
      role: "assistant",
      content: "the weather is nice today",
      ts: 20,
    });
    await writer.appendMessage({
      sessionId: "sess-fts",
      turnIndex: 2,
      role: "user",
      content: "unrelated text about cats",
      ts: 30,
    });

    const hits = searchMessages(db, { query: "auth bug" });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.content).toContain("auth bug");
    expect(hits[0]?.role).toBe("user");
    expect(hits[0]?.snippet).toMatch(/<b>auth<\/b>/);
  });

  it("reflects updates via messages_au trigger", async () => {
    const id = await writer.appendMessage({
      sessionId: "sess-fts",
      turnIndex: 0,
      role: "user",
      content: "original content about widgets",
      ts: 1,
    });

    expect(searchMessages(db, { query: "widgets" })).toHaveLength(1);

    db.raw
      .prepare("UPDATE messages SET content = ? WHERE id = ?")
      .run("rewritten now mentions gizmos", id);

    expect(searchMessages(db, { query: "widgets" })).toHaveLength(0);
    expect(searchMessages(db, { query: "gizmos" })).toHaveLength(1);
  });

  it("reflects deletes via messages_ad trigger", async () => {
    const id = await writer.appendMessage({
      sessionId: "sess-fts",
      turnIndex: 0,
      role: "user",
      content: "temporary message to delete",
      ts: 1,
    });
    expect(searchMessages(db, { query: "temporary" })).toHaveLength(1);

    db.raw.prepare("DELETE FROM messages WHERE id = ?").run(id);

    expect(searchMessages(db, { query: "temporary" })).toHaveLength(0);
  });

  it("filters by sessionId (returns empty for unknown session)", async () => {
    await writer.appendMessage({
      sessionId: "sess-fts",
      turnIndex: 0,
      role: "user",
      content: "some findable content here",
      ts: 1,
    });

    expect(searchMessages(db, { query: "findable", sessionId: "nonexistent" })).toHaveLength(0);
    expect(searchMessages(db, { query: "findable", sessionId: "sess-fts" })).toHaveLength(1);
  });

  it("filters by role", async () => {
    await writer.appendMessage({
      sessionId: "sess-fts",
      turnIndex: 0,
      role: "user",
      content: "apples are red",
      ts: 1,
    });
    await writer.appendMessage({
      sessionId: "sess-fts",
      turnIndex: 1,
      role: "assistant",
      content: "apples are also green sometimes",
      ts: 2,
    });

    const userHits = searchMessages(db, { query: "apples", role: "user" });
    expect(userHits).toHaveLength(1);
    expect(userHits[0]?.role).toBe("user");

    const asstHits = searchMessages(db, { query: "apples", role: "assistant" });
    expect(asstHits).toHaveLength(1);
    expect(asstHits[0]?.role).toBe("assistant");
  });

  it("sanitizes fts5 metacharacters without throwing", async () => {
    await writer.appendMessage({
      sessionId: "sess-fts",
      turnIndex: 0,
      role: "user",
      content: "regular content with the word safe in it",
      ts: 1,
    });

    // These previously-dangerous queries must not throw SqliteError.
    expect(() => searchMessages(db, { query: '"*:(' })).not.toThrow();
    expect(() => searchMessages(db, { query: "safe*" })).not.toThrow();
    expect(() => searchMessages(db, { query: '"safe"' })).not.toThrow();
    expect(() => searchMessages(db, { query: "" })).not.toThrow();
    expect(searchMessages(db, { query: "" })).toEqual([]);
    expect(searchMessages(db, { query: "safe*" }).length).toBe(1);
  });

  it("respects and caps the limit option", async () => {
    for (let i = 0; i < 5; i++) {
      await writer.appendMessage({
        sessionId: "sess-fts",
        turnIndex: i,
        role: "user",
        content: `repeat word token number ${i}`,
        ts: i,
      });
    }
    expect(searchMessages(db, { query: "repeat", limit: 3 })).toHaveLength(3);
    // Over-max is capped at 100; with 5 rows we still get all 5.
    expect(searchMessages(db, { query: "repeat", limit: 1_000 })).toHaveLength(5);
  });
});
