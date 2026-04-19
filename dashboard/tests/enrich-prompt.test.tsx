/**
 * Conflict-resolution tests for `enrichPrompt`.
 *
 * The helper merges a prompt's disk state (`COMPLETION-LOG.md`-derived status)
 * with its live run record. Four rules must hold — each covered below:
 *
 *   1. log says DONE                                   → DONE wins
 *   2. run says running + log missing                  → RUNNING wins
 *   3. run says complete + log missing for < graceMs   → FINALIZING
 *   4. neither running nor done                        → PENDING
 *
 * (Plus a handful of adjacent cases: REVIEW/FAILED/ESCALATED pass-through and
 * the FINALIZING → DONE transition once the grace window elapses.)
 */
import { describe, it, expect } from "vitest";
import { enrichPrompt } from "../src/lib/enrich-prompt";
import type { Prompt, RunRecord } from "../src/types";

const BASE_PROMPT: Prompt = {
  id: "phase-99b-unfucking-v2/01-typecheck",
  phase: 99,
  subPrompt: "01-typecheck",
  title: "T0 · typecheck gate",
  whenToRun: "",
  duration: "",
  newSession: false,
  model: "claude-sonnet-4.6",
  filePath: "/repo/prompts/phase-99b-unfucking-v2/01-typecheck.md",
  status: "not-started",
  tier: 0,
};

function makeRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    status: "working",
    tier: 0,
    session_id: "sess-1",
    tmux_session: "jc-01",
    branch: "autobuild/01-typecheck",
    started_at: "2026-04-17T10:00:00.000Z",
    updated_at: "2026-04-17T10:05:00.000Z",
    ended_at: null,
    attempt: 1,
    max_retries: 5,
    turns_used: 4,
    cost_usd: 0.42,
    self_check: null,
    log_path: "/var/runs/sess-1.log",
    events_path: "/var/runs/sess-1.events",
    tests: { total: 0, passed: 0, failed: 0, pending: 0 },
    commit_sha: null,
    last_error: null,
    last_retry_reason: null,
    needs_review: false,
    retry_history: [],
    ...overrides,
  };
}

describe("enrichPrompt — conflict resolution", () => {
  it("case 1: COMPLETION-LOG says DONE → DONE wins even if a run is still active", () => {
    const prompt: Prompt = { ...BASE_PROMPT, status: "complete" };
    const run = makeRun({ status: "working" }); // rig thinks it's still going
    const result = enrichPrompt(prompt, run);
    expect(result.state).toBe("DONE");
    expect(result.run).toBe(run);
  });

  it("case 2: run says running + log missing → RUNNING wins", () => {
    const prompt: Prompt = { ...BASE_PROMPT, status: "not-started" };
    const run = makeRun({ status: "working" });
    const result = enrichPrompt(prompt, run);
    expect(result.state).toBe("RUNNING");
  });

  it("case 2b: any in-flight status maps to RUNNING", () => {
    const prompt: Prompt = { ...BASE_PROMPT, status: "not-started" };
    for (const s of [
      "queued",
      "spawning",
      "prompting",
      "completion_detected",
      "testing",
      "retrying",
    ] as const) {
      const result = enrichPrompt(prompt, makeRun({ status: s }));
      expect(result.state).toBe("RUNNING");
    }
  });

  it("case 3: run says complete + log missing within grace window → FINALIZING", () => {
    const prompt: Prompt = { ...BASE_PROMPT, status: "not-started" };
    const updatedAt = "2026-04-17T10:05:00.000Z";
    const run = makeRun({ status: "complete", updated_at: updatedAt });
    // now = 5s after updated_at → inside the default 10s grace window.
    const now = Date.parse(updatedAt) + 5_000;
    const result = enrichPrompt(prompt, run, { now });
    expect(result.state).toBe("FINALIZING");
  });

  it("case 3b: FINALIZING → DONE once the grace window elapses", () => {
    const prompt: Prompt = { ...BASE_PROMPT, status: "not-started" };
    const updatedAt = "2026-04-17T10:05:00.000Z";
    const run = makeRun({ status: "complete", updated_at: updatedAt });
    // now = 30s after updated_at → outside the 10s grace window.
    const now = Date.parse(updatedAt) + 30_000;
    const result = enrichPrompt(prompt, run, { now });
    expect(result.state).toBe("DONE");
  });

  it("case 4: neither running nor done → PENDING", () => {
    const prompt: Prompt = { ...BASE_PROMPT, status: "not-started" };
    const result = enrichPrompt(prompt, null);
    expect(result.state).toBe("PENDING");
    expect(result.run).toBeNull();
  });

  it("REVIEW flag trumps machine status (except DONE)", () => {
    const prompt: Prompt = { ...BASE_PROMPT, status: "not-started" };
    const run = makeRun({ needs_review: true, status: "testing" });
    expect(enrichPrompt(prompt, run).state).toBe("REVIEW");

    // But DONE still wins — review gate is useless after the fact.
    const donePrompt: Prompt = { ...BASE_PROMPT, status: "complete" };
    expect(enrichPrompt(donePrompt, run).state).toBe("DONE");
  });

  it("failed and escalated bubble up as their own states", () => {
    const prompt: Prompt = { ...BASE_PROMPT, status: "not-started" };
    expect(enrichPrompt(prompt, makeRun({ status: "failed" })).state).toBe("FAILED");
    expect(enrichPrompt(prompt, makeRun({ status: "escalated" })).state).toBe("ESCALATED");
  });

  it("COMPLETION-LOG says in-progress but no run → PENDING (run is missing)", () => {
    // Edge case: the log claims in-progress but we have no run object. We
    // don't fabricate a RUNNING state out of thin air — PENDING is the safer
    // default because the rig hasn't acknowledged ownership.
    const prompt: Prompt = { ...BASE_PROMPT, status: "in-progress" };
    const result = enrichPrompt(prompt, null);
    expect(result.state).toBe("PENDING");
  });

  it("COMPLETION-LOG says in-progress + a stalled non-terminal run → RUNNING", () => {
    // If both sides agree something is in motion we honor the run record.
    const prompt: Prompt = { ...BASE_PROMPT, status: "in-progress" };
    // `queued` isn't strictly in-flight but it counts as non-terminal work.
    const result = enrichPrompt(prompt, makeRun({ status: "queued" }));
    expect(result.state).toBe("RUNNING");
  });
});
