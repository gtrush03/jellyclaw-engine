/**
 * Tests for `meta.ts` — atomic write, read, validation, crash safety.
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readSessionMeta, writeSessionMeta } from "./meta.js";
import { SessionPaths } from "./paths.js";
import { EMPTY_USAGE, type SessionMeta } from "./types.js";

const SESSION_ID = "sess-meta-01";
const PROJECT_HASH = "deadbeef1234";

function mkMeta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    version: 1,
    sessionId: SESSION_ID,
    projectHash: PROJECT_HASH,
    cwd: "/tmp/proj",
    model: "claude-sonnet",
    provider: "anthropic",
    createdAt: 1_700_000_000_000,
    lastTurnAt: 1_700_000_100_000,
    parentSessionId: null,
    status: "active",
    summary: "hello world",
    turns: 2,
    usage: EMPTY_USAGE,
    ...overrides,
  };
}

describe("session meta", () => {
  let tmpDir: string;
  let paths: SessionPaths;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "jellyclaw-meta-"));
    paths = new SessionPaths({ home: tmpDir });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("round-trips via write → read", async () => {
    const meta = mkMeta();
    await writeSessionMeta(paths, meta);
    const loaded = await readSessionMeta(paths, PROJECT_HASH, SESSION_ID);
    expect(loaded).toEqual(meta);
  });

  it("returns null on ENOENT", async () => {
    const loaded = await readSessionMeta(paths, PROJECT_HASH, "missing");
    expect(loaded).toBeNull();
  });

  it("throws on invalid JSON", async () => {
    const dir = paths.projectDir(PROJECT_HASH);
    mkdirSync(dir, { recursive: true });
    writeFileSync(paths.sessionMeta(PROJECT_HASH, SESSION_ID), "{not json", "utf8");
    await expect(readSessionMeta(paths, PROJECT_HASH, SESSION_ID)).rejects.toThrow(
      /not valid JSON/,
    );
  });

  it("throws on version != 1", async () => {
    const dir = paths.projectDir(PROJECT_HASH);
    mkdirSync(dir, { recursive: true });
    const bad = { ...mkMeta(), version: 2 };
    writeFileSync(paths.sessionMeta(PROJECT_HASH, SESSION_ID), JSON.stringify(bad), "utf8");
    await expect(readSessionMeta(paths, PROJECT_HASH, SESSION_ID)).rejects.toThrow(
      /schema validation/,
    );
  });

  it("atomic rename survives a pre-existing stale .tmp", async () => {
    const finalPath = paths.sessionMeta(PROJECT_HASH, SESSION_ID);
    const dir = paths.projectDir(PROJECT_HASH);
    mkdirSync(dir, { recursive: true });

    // Plant a stale .tmp file with an unrelated suffix. New writer uses a
    // unique random suffix so it must not collide.
    const stalePath = `${finalPath}.stalestale.tmp`;
    writeFileSync(stalePath, "stale content", "utf8");

    await writeSessionMeta(paths, mkMeta());
    const loaded = await readSessionMeta(paths, PROJECT_HASH, SESSION_ID);
    expect(loaded).not.toBeNull();

    // Stale .tmp remains (we intentionally do not clean up — documented choice).
    const entries = readdirSync(dir);
    expect(entries).toContain(`${SESSION_ID}.meta.json.stalestale.tmp`);
  });

  it("tight-loop writes always leave a valid SessionMeta on disk", async () => {
    for (let i = 0; i < 10; i++) {
      await writeSessionMeta(paths, mkMeta({ turns: i }));
      const raw = readFileSync(paths.sessionMeta(PROJECT_HASH, SESSION_ID), "utf8");
      // No torn writes — valid JSON every time.
      const parsed = JSON.parse(raw) as SessionMeta;
      expect(parsed.turns).toBe(i);
    }
  });
});
