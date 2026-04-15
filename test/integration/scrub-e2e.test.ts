/**
 * Integration: secret scrubber end-to-end.
 *
 * Proves that when a tool handler returns a payload containing a
 * secret, every downstream observer (event-stream emitter, hook
 * payload, session writer) receives the SCRUBBED payload, not the raw
 * secret. The Phase 10 CLI will wire `applyScrub` into the real
 * tool-result pipeline; this test pins the contract now so that
 * wiring can't regress silently.
 *
 * Design: instead of booting the full engine (not yet bootable), we
 * simulate the pipeline here — handler → scrub → three observers —
 * and assert each observer sees only the redaction marker.
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyScrub, builtInPatterns } from "../../engine/src/security/index.js";

const PATTERNS = builtInPatterns();

// Synthetic pipeline: a handler returns a payload; we scrub once and
// fan it out to the three observer surfaces.
interface Observers {
  eventStream: unknown[];
  hookPayloads: unknown[];
  sessionLogPath: string;
}

function dispatch(rawResult: unknown, observers: Observers): { hits: number } {
  const { value, hits } = applyScrub(rawResult, PATTERNS);
  observers.eventStream.push(value);
  observers.hookPayloads.push({ event: "PostToolUse", result: value });
  const logLine = `${JSON.stringify({ role: "tool", content: value })}\n`;
  const existing = (() => {
    try {
      return readFileSync(observers.sessionLogPath, "utf8");
    } catch {
      return "";
    }
  })();
  writeFileSync(observers.sessionLogPath, existing + logLine);
  return { hits };
}

describe("scrub-e2e", () => {
  it("scrubs a GitHub PAT before the event stream, hooks, and session log see it", () => {
    const tmp = mkdtempSync(join(tmpdir(), "jc-scrub-e2e-"));
    const observers: Observers = {
      eventStream: [],
      hookPayloads: [],
      sessionLogPath: join(tmp, "session.jsonl"),
    };

    const pat = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const rawResult = {
      status: "ok",
      message: `here is the token: ${pat}`,
      nested: { token: pat },
    };

    const { hits } = dispatch(rawResult, observers);
    expect(hits).toBeGreaterThanOrEqual(2);

    const eventJson = JSON.stringify(observers.eventStream);
    const hookJson = JSON.stringify(observers.hookPayloads);
    const sessionText = readFileSync(observers.sessionLogPath, "utf8");

    for (const text of [eventJson, hookJson, sessionText]) {
      expect(text).not.toContain(pat);
      expect(text).toContain("[REDACTED:github_pat_legacy]");
    }
  });

  it("scrubs multiple distinct secret types in one result", () => {
    const tmp = mkdtempSync(join(tmpdir(), "jc-scrub-e2e-"));
    const observers: Observers = {
      eventStream: [],
      hookPayloads: [],
      sessionLogPath: join(tmp, "session.jsonl"),
    };

    const raw = {
      message: [
        "anth=sk-ant-aaaaaaaaaaaaaaaaaaaaaa",
        "aws=AKIAABCDEFGHIJKLMNOP",
        "bearer=Authorization: Bearer eyJabcdefghij.eyJklmnopqrst.uvwxyzABCDEFG",
      ].join(" "),
    };

    const { hits } = dispatch(raw, observers);
    expect(hits).toBeGreaterThanOrEqual(3);

    const eventJson = JSON.stringify(observers.eventStream);
    expect(eventJson).toContain("[REDACTED:anthropic_api_key]");
    expect(eventJson).toContain("[REDACTED:aws_access_key_id]");
    expect(eventJson).toContain("[REDACTED:authorization_bearer]");
    expect(eventJson).not.toMatch(/sk-ant-a{10,}/);
    expect(eventJson).not.toMatch(/AKIA[A-Z0-9]{10,}/);
  });

  it("passes non-secret payloads through unchanged (no false positives on short strings)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "jc-scrub-e2e-"));
    const observers: Observers = {
      eventStream: [],
      hookPayloads: [],
      sessionLogPath: join(tmp, "session.jsonl"),
    };

    const raw = { greeting: "hello world", count: 42, flag: true };
    const { hits } = dispatch(raw, observers);
    expect(hits).toBe(0);
    expect(observers.eventStream[0]).toEqual(raw);
  });
});
