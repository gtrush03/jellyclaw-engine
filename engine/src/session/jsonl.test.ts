/**
 * Tests for `jsonl.ts` — append, concurrency, reopening, rotation, close.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AgentEvent } from "../events.js";
import { openJsonl } from "./jsonl.js";
import { SessionPaths } from "./paths.js";

const SESSION_ID = "sess-test-01";
const PROJECT_HASH = "abc123abc123";

function mkEvent(seq: number, delta = "hi"): AgentEvent {
  return {
    type: "agent.message",
    session_id: SESSION_ID,
    ts: 1_700_000_000_000 + seq,
    seq,
    delta,
    final: false,
  };
}

describe("openJsonl", () => {
  let tmpDir: string;
  let paths: SessionPaths;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "jellyclaw-jsonl-"));
    paths = new SessionPaths({ home: tmpDir });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes events and flushTurn succeeds", async () => {
    const w = await openJsonl({
      sessionId: SESSION_ID,
      projectHash: PROJECT_HASH,
      paths,
    });
    for (let i = 0; i < 5; i++) {
      await w.write(mkEvent(i));
    }
    await w.flushTurn();
    await w.close();

    const contents = readFileSync(w.path, "utf8");
    const lines = contents.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(5);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("serialises concurrent writes without interleaving", async () => {
    const w = await openJsonl({
      sessionId: SESSION_ID,
      projectHash: PROJECT_HASH,
      paths,
    });
    await Promise.all(Array.from({ length: 50 }, (_, i) => w.write(mkEvent(i, `d${i}`))));
    await w.close();

    const contents = readFileSync(w.path, "utf8");
    const lines = contents.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(50);
    for (const line of lines) {
      const parsed = JSON.parse(line) as AgentEvent;
      expect(parsed.type).toBe("agent.message");
    }
  });

  it("initialises byte counter from fstat on reopen", async () => {
    const w1 = await openJsonl({
      sessionId: SESSION_ID,
      projectHash: PROJECT_HASH,
      paths,
    });
    for (let i = 0; i < 3; i++) {
      await w1.write(mkEvent(i));
    }
    await w1.close();

    const w2 = await openJsonl({
      sessionId: SESSION_ID,
      projectHash: PROJECT_HASH,
      paths,
    });
    await w2.write(mkEvent(3));
    await w2.close();

    const contents = readFileSync(w2.path, "utf8");
    const lines = contents.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(4);
  });

  it("rotates when bytesWritten crosses threshold", async () => {
    const w = await openJsonl({
      sessionId: SESSION_ID,
      projectHash: PROJECT_HASH,
      paths,
      rotateBytes: 200,
    });
    // Each event ~120 bytes serialised; 5 events guarantee crossing 200 bytes.
    for (let i = 0; i < 5; i++) {
      await w.write(mkEvent(i, "padding".repeat(10)));
    }
    await w.flushTurn();
    await w.maybeRotate();
    await w.write(mkEvent(100, "post-rotate"));
    await w.close();

    const dir = paths.projectDir(PROJECT_HASH);
    const entries = readdirSync(dir);
    expect(entries).toContain(`${SESSION_ID}.jsonl`);
    expect(entries).toContain(`${SESSION_ID}.jsonl.1`);

    const fresh = readFileSync(w.path, "utf8");
    const freshLines = fresh.split("\n").filter((l) => l.length > 0);
    expect(freshLines).toHaveLength(1);
  });

  it("gzips beyond .3 on repeated rotations", async () => {
    const w = await openJsonl({
      sessionId: SESSION_ID,
      projectHash: PROJECT_HASH,
      paths,
      rotateBytes: 100,
    });
    // Drive 5 rotations.
    for (let r = 0; r < 5; r++) {
      for (let i = 0; i < 3; i++) {
        await w.write(mkEvent(r * 10 + i, "x".repeat(60)));
      }
      await w.flushTurn();
      await w.maybeRotate();
    }
    await w.close();

    const dir = paths.projectDir(PROJECT_HASH);
    const entries = readdirSync(dir).sort();
    // Expect at least one .gz file present.
    const gzFiles = entries.filter((e) => e.endsWith(".gz"));
    expect(gzFiles.length).toBeGreaterThan(0);

    // Verify gzip magic bytes on one gz file.
    const gzPath = join(dir, gzFiles[0] as string);
    const buf = readFileSync(gzPath);
    expect(buf[0]).toBe(0x1f);
    expect(buf[1]).toBe(0x8b);
  });

  it("maybeRotate below threshold is a no-op", async () => {
    const w = await openJsonl({
      sessionId: SESSION_ID,
      projectHash: PROJECT_HASH,
      paths,
      rotateBytes: 1_000_000,
    });
    await w.write(mkEvent(0));
    const sizeBefore = statSync(w.path).size;
    await w.maybeRotate();
    const sizeAfter = statSync(w.path).size;
    expect(sizeAfter).toBe(sizeBefore);

    const dir = paths.projectDir(PROJECT_HASH);
    const entries = readdirSync(dir);
    expect(entries).not.toContain(`${SESSION_ID}.jsonl.1`);
    await w.close();
  });

  it("close is idempotent and post-close writes throw", async () => {
    const w = await openJsonl({
      sessionId: SESSION_ID,
      projectHash: PROJECT_HASH,
      paths,
    });
    await w.write(mkEvent(0));
    await w.close();
    await w.close(); // second close must not throw
    await expect(w.write(mkEvent(1))).rejects.toThrow(/closed/);
  });
});
