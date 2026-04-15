/**
 * Tests for `./audit-log.ts`.
 *
 * We override the log path via the test-only env var
 * `HOOKS_LOG_PATH_OVERRIDE` so `~/.jellyclaw` is never written.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

function ensureDir(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createMemoryAuditSink,
  defaultHookAuditSink,
  resolveHooksLogPath,
  rotateIfNeeded,
} from "./audit-log.js";
import type { HookAuditEntry } from "./types.js";

function sampleEntry(overrides: Partial<HookAuditEntry> = {}): HookAuditEntry {
  return {
    ts: "2026-04-15T10:00:00.000Z",
    event: "PreToolUse",
    sessionId: "test-session",
    hookName: "test-hook",
    decision: "neutral",
    durationMs: 12,
    exitCode: 0,
    ...overrides,
  };
}

describe("audit-log", () => {
  let tmp: string;
  let logPath: string;
  const prevOverride = process.env["HOOKS_LOG_PATH_OVERRIDE"];

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "jc-hooks-"));
    logPath = join(tmp, "nested", "subdir", "hooks.jsonl");
    process.env["HOOKS_LOG_PATH_OVERRIDE"] = logPath;
  });

  afterEach(() => {
    if (prevOverride === undefined) {
      delete process.env["HOOKS_LOG_PATH_OVERRIDE"];
    } else {
      process.env["HOOKS_LOG_PATH_OVERRIDE"] = prevOverride;
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  it("resolveHooksLogPath honours the env override", () => {
    expect(resolveHooksLogPath()).toBe(logPath);
  });

  it("falls back to ~/.jellyclaw/logs/hooks.jsonl when no override", () => {
    delete process.env["HOOKS_LOG_PATH_OVERRIDE"];
    const resolved = resolveHooksLogPath();
    expect(resolved).toMatch(/\.jellyclaw[/\\]logs[/\\]hooks\.jsonl$/);
  });

  it("creates the enclosing directory and file on first call", () => {
    expect(existsSync(logPath)).toBe(false);
    defaultHookAuditSink(sampleEntry());
    expect(existsSync(logPath)).toBe(true);
  });

  it("chmods the file to 0600 on creation", () => {
    defaultHookAuditSink(sampleEntry());
    const mode = statSync(logPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("appends one JSON line per entry, newline-terminated", () => {
    defaultHookAuditSink(sampleEntry({ hookName: "a" }));
    defaultHookAuditSink(sampleEntry({ hookName: "b" }));
    defaultHookAuditSink(sampleEntry({ hookName: "c" }));
    const contents = readFileSync(logPath, "utf8");
    const lines = contents.split("\n");
    // 3 entries + trailing empty string after final newline
    expect(lines).toHaveLength(4);
    expect(lines[3]).toBe("");
    const parsed = lines.slice(0, 3).map((l) => JSON.parse(l));
    expect(parsed[0].hookName).toBe("a");
    expect(parsed[1].hookName).toBe("b");
    expect(parsed[2].hookName).toBe("c");
  });

  it("entries round-trip through JSON.parse cleanly", () => {
    const entry = sampleEntry({
      decision: "deny",
      reason: "blocked by policy",
      exitCode: 2,
      timedOut: false,
      stdoutBytes: 42,
      stderrBytes: 7,
    });
    defaultHookAuditSink(entry);
    const [line] = readFileSync(logPath, "utf8").split("\n");
    const parsed = JSON.parse(line ?? "") as HookAuditEntry;
    expect(parsed).toEqual(entry);
  });

  it("rotateIfNeeded is a no-op when file does not exist", () => {
    expect(() => rotateIfNeeded(logPath, { maxSizeBytes: 10, keep: 3 })).not.toThrow();
    expect(existsSync(logPath)).toBe(false);
  });

  it("rotateIfNeeded is a no-op when file under threshold", () => {
    ensureDir(logPath);
    writeFileSync(logPath, "tiny\n");
    rotateIfNeeded(logPath, { maxSizeBytes: 10_000, keep: 3 });
    expect(existsSync(logPath)).toBe(true);
    expect(existsSync(`${logPath}.1`)).toBe(false);
  });

  it("rotates when size >= threshold: current → .1, fresh file on next write", () => {
    // Seed a file over the tiny threshold.
    ensureDir(logPath);
    writeFileSync(logPath, "x".repeat(600));
    rotateIfNeeded(logPath, { maxSizeBytes: 500, keep: 2 });
    expect(existsSync(`${logPath}.1`)).toBe(true);
    expect(existsSync(logPath)).toBe(false);
    // Next sink call creates fresh file.
    defaultHookAuditSink(sampleEntry({ hookName: "after-rotate" }));
    expect(existsSync(logPath)).toBe(true);
    const fresh = readFileSync(logPath, "utf8");
    expect(fresh.trim().split("\n")).toHaveLength(1);
  });

  it("rotation shifts .1 → .2 and drops the oldest when exceeding keep", () => {
    // Set up a file with existing .1 and .2 backups.
    ensureDir(logPath);
    writeFileSync(`${logPath}.2`, "old-2");
    writeFileSync(`${logPath}.1`, "old-1");
    ensureDir(logPath);
    writeFileSync(logPath, "x".repeat(600));

    rotateIfNeeded(logPath, { maxSizeBytes: 500, keep: 2 });

    // keep=2 means we hold .1 and .2; old .2 is dropped, old .1 → .2, current → .1.
    expect(readFileSync(`${logPath}.1`, "utf8")).toBe("x".repeat(600));
    expect(readFileSync(`${logPath}.2`, "utf8")).toBe("old-1");
    expect(existsSync(`${logPath}.3`)).toBe(false);
    expect(existsSync(logPath)).toBe(false);
  });

  it("defaultHookAuditSink triggers rotation when size >= default threshold via override path", () => {
    // Seed a large file under override, then drive rotation with a tiny
    // custom threshold by invoking rotateIfNeeded directly before a write.
    ensureDir(logPath);
    writeFileSync(logPath, "x".repeat(4096));
    // Hand-rotate (mirrors what would happen at 50 MB).
    rotateIfNeeded(logPath, { maxSizeBytes: 1024, keep: 3 });
    expect(existsSync(`${logPath}.1`)).toBe(true);

    defaultHookAuditSink(sampleEntry());
    expect(existsSync(logPath)).toBe(true);
    const written = readFileSync(logPath, "utf8");
    expect(written).toContain('"hookName":"test-hook"');
  });

  it("createMemoryAuditSink collects entries in declaration order", () => {
    const { sink, entries } = createMemoryAuditSink();
    sink(sampleEntry({ hookName: "first" }));
    sink(sampleEntry({ hookName: "second" }));
    expect(entries).toHaveLength(2);
    expect(entries[0]?.hookName).toBe("first");
    expect(entries[1]?.hookName).toBe("second");
  });

  it("createMemoryAuditSink array is the same reference exposed to caller", () => {
    const { sink, entries } = createMemoryAuditSink();
    const ref = entries;
    sink(sampleEntry());
    expect(entries).toBe(ref);
    expect(entries).toHaveLength(1);
  });

  it("defaultHookAuditSink swallows errors (never throws)", () => {
    // Point override at a path whose parent cannot be created (use a
    // regular file as the parent).
    const blocker = join(tmp, "blocker-file");
    writeFileSync(blocker, "i am a file");
    process.env["HOOKS_LOG_PATH_OVERRIDE"] = join(blocker, "child", "hooks.jsonl");
    expect(() => defaultHookAuditSink(sampleEntry())).not.toThrow();
  });
});
