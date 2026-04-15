import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "./db.js";
import { openDb } from "./db.js";
import { SessionPaths } from "./paths.js";
import type { UpsertSessionInput } from "./writer.js";
import { SessionWriter } from "./writer.js";

function makeSession(id = "sess-1"): UpsertSessionInput {
  return {
    id,
    projectHash: "abcdef012345",
    cwd: "/tmp/project",
    model: "claude-opus-4",
    createdAt: 1_700_000_000_000,
    lastTurnAt: 1_700_000_000_000,
    parentSessionId: null,
    status: "active",
    summary: null,
  };
}

describe("SessionWriter", () => {
  let home: string;
  let db: Db;
  let writer: SessionWriter;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "jellyclaw-writer-"));
    db = await openDb({ paths: new SessionPaths({ home }) });
    writer = new SessionWriter(db);
  });

  afterEach(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("upsertSession inserts once, then updates last_turn_at without duplicating", async () => {
    await writer.upsertSession(makeSession());
    await writer.upsertSession({
      ...makeSession(),
      lastTurnAt: 1_700_000_999_999,
      status: "ended",
      summary: "hello",
    });

    const rows = db.raw.prepare("SELECT id, last_turn_at, status, summary FROM sessions").all() as {
      id: string;
      last_turn_at: number;
      status: string;
      summary: string | null;
    }[];

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "sess-1",
      last_turn_at: 1_700_000_999_999,
      status: "ended",
      summary: "hello",
    });
  });

  it("serializes concurrent appendMessage calls and preserves order", async () => {
    await writer.upsertSession(makeSession());

    const N = 50;
    const ids = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        writer.appendMessage({
          sessionId: "sess-1",
          turnIndex: i,
          role: i % 2 === 0 ? "user" : "assistant",
          content: `message ${i}`,
          ts: 1_700_000_000_000 + i,
        }),
      ),
    );

    expect(new Set(ids).size).toBe(N);

    const count = db.raw
      .prepare("SELECT COUNT(*) AS c FROM messages WHERE session_id = ?")
      .get("sess-1") as { c: number };
    expect(count.c).toBe(N);

    // IDs are monotonic in enqueue order → turn_index ordered by id matches submission order.
    const rows = db.raw
      .prepare("SELECT turn_index FROM messages WHERE session_id = ? ORDER BY id ASC")
      .all("sess-1") as { turn_index: number }[];
    expect(rows.map((r) => r.turn_index)).toEqual(Array.from({ length: N }, (_, i) => i));
  });

  it("appendToolCall start-then-finish merges into one row", async () => {
    await writer.upsertSession(makeSession());

    await writer.appendToolCall({
      sessionId: "sess-1",
      callId: "tool_use_01",
      toolName: "bash",
      inputJson: '{"cmd":"ls"}',
      resultJson: null,
      durationMs: null,
      startedAt: 1_700_000_000_000,
      finishedAt: null,
    });

    await writer.appendToolCall({
      sessionId: "sess-1",
      callId: "tool_use_01",
      toolName: "bash",
      inputJson: '{"cmd":"ls"}',
      resultJson: '{"stdout":"ok"}',
      durationMs: 42,
      startedAt: 1_700_000_000_000,
      finishedAt: 1_700_000_000_042,
    });

    const rows = db.raw
      .prepare(
        "SELECT call_id, result_json, duration_ms, finished_at FROM tool_calls WHERE session_id = ?",
      )
      .all("sess-1") as {
      call_id: string;
      result_json: string | null;
      duration_ms: number | null;
      finished_at: number | null;
    }[];

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      call_id: "tool_use_01",
      result_json: '{"stdout":"ok"}',
      duration_ms: 42,
      finished_at: 1_700_000_000_042,
    });
  });

  it("appendToolCall truncates result_json > 1 MB with bytes marker", async () => {
    await writer.upsertSession(makeSession());

    const oversize = "x".repeat(1_000_001);
    await writer.appendToolCall({
      sessionId: "sess-1",
      callId: "tool_use_big",
      toolName: "bash",
      inputJson: "{}",
      resultJson: oversize,
      durationMs: 1,
      startedAt: 1,
      finishedAt: 2,
    });

    const row = db.raw
      .prepare("SELECT result_json FROM tool_calls WHERE call_id = ?")
      .get("tool_use_big") as { result_json: string };

    const parsed = JSON.parse(row.result_json) as { truncated: boolean; bytes: number };
    expect(parsed.truncated).toBe(true);
    expect(parsed.bytes).toBe(Buffer.byteLength(oversize, "utf8"));
  });

  it("updateUsage rollback leaves tokens + cost unchanged on transaction error", async () => {
    await writer.upsertSession(makeSession());

    // Seed baseline values.
    await writer.updateUsage({
      sessionId: "sess-1",
      inputTokens: 100,
      outputTokens: 200,
      cacheCreation: 0,
      cacheRead: 0,
      usdCents: 5,
    });

    // Invalid int: better-sqlite3 throws on non-integer numeric binding when
    // using SQLITE_INTEGER column affinity would fail. Use a non-bindable
    // value to force mid-transaction failure. A symbol is not bindable.
    await expect(
      writer.updateUsage({
        sessionId: "sess-1",
        inputTokens: 999,
        outputTokens: 999,
        cacheCreation: 0,
        cacheRead: 0,
        // Cast to force better-sqlite3 to reject the bind mid-tx. cost row
        // is the second statement; tokens would have committed without the
        // surrounding transaction.
        usdCents: Number.NaN as unknown as number,
      }),
    ).rejects.toBeDefined();

    const tokens = db.raw
      .prepare("SELECT input_tokens, output_tokens FROM tokens WHERE session_id = ?")
      .get("sess-1") as { input_tokens: number; output_tokens: number };
    const cost = db.raw
      .prepare("SELECT usd_cents FROM cost WHERE session_id = ?")
      .get("sess-1") as { usd_cents: number };

    expect(tokens).toEqual({ input_tokens: 100, output_tokens: 200 });
    expect(cost).toEqual({ usd_cents: 5 });
  });

  it("writer queue survives a failed task and continues processing", async () => {
    await writer.upsertSession(makeSession());

    // Failing task: violate FK by inserting a message against missing session.
    await expect(
      writer.appendMessage({
        sessionId: "does-not-exist",
        turnIndex: 0,
        role: "user",
        content: "x",
        ts: 1,
      }),
    ).rejects.toBeDefined();

    // Queue should still work after a failure.
    const id = await writer.appendMessage({
      sessionId: "sess-1",
      turnIndex: 0,
      role: "user",
      content: "still works",
      ts: 1,
    });
    expect(id).toBeGreaterThan(0);
  });
});
