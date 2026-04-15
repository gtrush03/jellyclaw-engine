/**
 * Tests for `replay.ts` — valid streams, truncation, corruption, perf smoke.
 */

import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AgentEvent } from "../events.js";
import { replayJsonl } from "./replay.js";
import { JsonlCorruptError } from "./types.js";

const SESSION_ID = "sess-replay-01";

function mkEvent(seq: number): AgentEvent {
  return {
    type: "agent.message",
    session_id: SESSION_ID,
    ts: 1_700_000_000_000 + seq,
    seq,
    delta: `d${seq}`,
    final: false,
  };
}

describe("replayJsonl", () => {
  let tmpDir: string;
  let logPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "jellyclaw-replay-"));
    logPath = join(tmpDir, `${SESSION_ID}.jsonl`);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeLines(lines: string[], trailingNewline = true): void {
    const content = lines.join("\n") + (trailingNewline ? "\n" : "");
    writeFileSync(logPath, content, "utf8");
  }

  it("reads 20 well-formed events", async () => {
    const events = Array.from({ length: 20 }, (_, i) => mkEvent(i));
    writeLines(events.map((e) => JSON.stringify(e)));
    const result = await replayJsonl(logPath);
    expect(result.events).toHaveLength(20);
    expect(result.truncatedTail).toBe(false);
    expect(result.linesRead).toBe(20);
  });

  it("drops a truncated final line (no trailing newline)", async () => {
    const valid = [mkEvent(0), mkEvent(1)];
    const lines = valid.map((e) => JSON.stringify(e));
    // Half-serialised final line, NO trailing newline.
    writeLines([...lines, '{"type":"agent.messa'], false);
    const result = await replayJsonl(logPath);
    expect(result.events).toHaveLength(2);
    expect(result.truncatedTail).toBe(true);
  });

  it("throws JsonlCorruptError on mid-file parse failure", async () => {
    writeLines([JSON.stringify(mkEvent(0)), "{this is garbage}", JSON.stringify(mkEvent(1))]);
    await expect(replayJsonl(logPath)).rejects.toBeInstanceOf(JsonlCorruptError);
    try {
      await replayJsonl(logPath);
    } catch (err) {
      expect((err as JsonlCorruptError).lineNumber).toBe(2);
    }
  });

  it("throws on schema failure mid-file", async () => {
    const bad = { ...mkEvent(0), type: "not.a.real.event.type" };
    writeLines([JSON.stringify(mkEvent(0)), JSON.stringify(bad), JSON.stringify(mkEvent(1))]);
    await expect(replayJsonl(logPath)).rejects.toBeInstanceOf(JsonlCorruptError);
  });

  it("treats schema failure at tail (no newline) as truncated", async () => {
    const bad = { ...mkEvent(5), type: "not.a.real.event.type" };
    const lines = [JSON.stringify(mkEvent(0)), JSON.stringify(bad)];
    writeLines(lines, false);
    const result = await replayJsonl(logPath);
    expect(result.truncatedTail).toBe(true);
    expect(result.events).toHaveLength(1);
  });

  it("returns empty result on ENOENT", async () => {
    const result = await replayJsonl(join(tmpDir, "does-not-exist.jsonl"));
    expect(result.events).toHaveLength(0);
    expect(result.truncatedTail).toBe(false);
    expect(result.linesRead).toBe(0);
    expect(result.bytesRead).toBe(0);
  });

  it("skips empty lines silently", async () => {
    writeLines([
      JSON.stringify(mkEvent(0)),
      "",
      JSON.stringify(mkEvent(1)),
      "",
      JSON.stringify(mkEvent(2)),
    ]);
    const result = await replayJsonl(logPath);
    expect(result.events).toHaveLength(3);
    expect(result.truncatedTail).toBe(false);
  });

  it("10k events perf smoke", async () => {
    const N = 10_000;
    // Use appendFileSync to avoid a giant in-memory array copy.
    mkdirSync(tmpDir, { recursive: true });
    for (let i = 0; i < N; i++) {
      appendFileSync(logPath, `${JSON.stringify(mkEvent(i))}\n`);
    }
    const start = Date.now();
    const result = await replayJsonl(logPath);
    const elapsed = Date.now() - start;
    expect(result.events).toHaveLength(N);
    expect(result.truncatedTail).toBe(false);
    // Informational: should complete comfortably on a dev laptop.
    expect(elapsed).toBeLessThan(5000);
  });
});
