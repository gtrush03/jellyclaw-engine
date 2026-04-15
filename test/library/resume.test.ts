/**
 * Phase 10.03 — resume / continueLatest semantics.
 *
 * Contract:
 *   - Turn 1 runs on a fresh engine, dispose.
 *   - New `createEngine`; `engine.resume(sessionId)` returns a handle.
 *   - The resumed handle's `.sessionId` equals the one passed in; `.id` is
 *     fresh (a new run id against the same session).
 *   - `engine.continueLatest()` on a cwd with prior sessions returns the
 *     newest; on a fresh cwd throws `NoSessionsForProjectError`.
 *
 * Uses an isolated `JELLYCLAW_HOME` per test to keep session stores
 * hermetic. Mirrors the fixture pattern in
 * `engine/src/session/resume.test.ts`.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@jellyclaw/engine";

import { createEngine, NoSessionsForProjectError } from "@jellyclaw/engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

function makeMockProvider(): unknown {
  return {
    name: "mock",
    async *stream(): AsyncGenerator<AgentEvent, void, void> {
      /* unused */
    },
  };
}

interface EngineSurface {
  run(input: { prompt: string; sessionId?: string }): AsyncIterable<AgentEvent> & {
    id: string;
    sessionId: string;
  };
  resume(sessionId: string): AsyncIterable<AgentEvent> & { id: string; sessionId: string };
  continueLatest(): AsyncIterable<AgentEvent> & { id: string; sessionId: string };
  dispose(): Promise<void>;
}

async function drain(iter: AsyncIterable<AgentEvent>, budgetMs = 3_000): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  const deadline = Date.now() + budgetMs;
  for await (const ev of iter) {
    out.push(ev);
    if (Date.now() > deadline) throw new Error("drain timed out");
    if (ev.type === "session.completed" || ev.type === "session.error") break;
  }
  return out;
}

describe("library: resume + continueLatest", () => {
  let home: string;
  let cwd: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "jellyclaw-lib-resume-"));
    cwd = await mkdtemp(join(tmpdir(), "jellyclaw-lib-cwd-"));
    // Isolate session store per test.
    process.env.JELLYCLAW_HOME = home;
  });

  afterEach(async () => {
    delete process.env.JELLYCLAW_HOME;
    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  });

  it("turn 1 on a fresh engine captures a sessionId that later resumes", async () => {
    const engine1 = (await createEngine({
      cwd,
      providerOverride: makeMockProvider(),
    } as unknown as { cwd: string; providerOverride: unknown })) as unknown as EngineSurface;

    const h1 = engine1.run({ prompt: "turn one" });
    const sessionId = h1.sessionId;
    expect(sessionId.length).toBeGreaterThan(0);
    await drain(h1);
    await engine1.dispose();

    // Fresh engine against the same cwd / session store.
    const engine2 = (await createEngine({
      cwd,
      providerOverride: makeMockProvider(),
    } as unknown as { cwd: string; providerOverride: unknown })) as unknown as EngineSurface;

    const h2 = engine2.resume(sessionId);
    expect(h2.sessionId).toBe(sessionId);
    expect(h2.id.length).toBeGreaterThan(0);
    // The run id for the resumed turn must differ from turn 1's run id.
    expect(h2.id).not.toBe(h1.id);

    await drain(h2);
    await engine2.dispose();
  });

  it("two turns on engine1 → dispose → recreate → resume 3rd turn, messages preserved", async () => {
    // Spec: 2 turns on engine1 → dispose → recreate → resume(sessionId)
    // → 3rd turn → prior-turn messages remain persisted on disk.
    const engine1 = (await createEngine({
      cwd,
      providerOverride: makeMockProvider(),
    } as unknown as { cwd: string; providerOverride: unknown })) as unknown as EngineSurface;

    const h1 = engine1.run({ prompt: "turn one" });
    const sessionId = h1.sessionId;
    const t1 = await drain(h1);
    expect(t1.length).toBeGreaterThan(0);

    const h2 = engine1.run({ prompt: "turn two", sessionId });
    expect(h2.sessionId).toBe(sessionId);
    const t2 = await drain(h2);
    expect(t2.length).toBeGreaterThan(0);
    await engine1.dispose();

    // Verify the JSONL transcript survives on-disk across dispose. We peek at
    // the raw file to prove turn 1 + turn 2 were persisted (cross-instance
    // visibility — the core contract of resume).
    const { readFileSync, existsSync } = await import("node:fs");
    const { join: pathJoin } = await import("node:path");
    const { createHash } = await import("node:crypto");
    const projectHash = createHash("sha1").update(cwd).digest("hex").slice(0, 12);
    const jsonlPath = pathJoin(home, ".jellyclaw", "sessions", projectHash, `${sessionId}.jsonl`);
    expect(existsSync(jsonlPath)).toBe(true);
    const contents = readFileSync(jsonlPath, "utf8");
    // Multiple `session.started` records prove ≥ 2 turns were appended.
    const startedCount = (contents.match(/"type":"session.started"/g) ?? []).length;
    expect(startedCount).toBeGreaterThanOrEqual(2);

    // Fresh engine against the same cwd / session store → resume 3rd turn.
    const engine2 = (await createEngine({
      cwd,
      providerOverride: makeMockProvider(),
    } as unknown as { cwd: string; providerOverride: unknown })) as unknown as EngineSurface;

    const h3 = engine2.resume(sessionId);
    expect(h3.sessionId).toBe(sessionId);
    expect(h3.id).not.toBe(h1.id);
    expect(h3.id).not.toBe(h2.id);

    const t3 = await drain(h3);
    expect(t3.length).toBeGreaterThan(0);
    await engine2.dispose();

    // After 3rd turn the transcript must still contain all prior starts.
    const contentsAfter = readFileSync(jsonlPath, "utf8");
    const startedCountAfter = (contentsAfter.match(/"type":"session.started"/g) ?? []).length;
    expect(startedCountAfter).toBeGreaterThanOrEqual(3);
  });

  it("continueLatest() on a cwd with prior sessions returns the newest", async () => {
    const engine1 = (await createEngine({
      cwd,
      providerOverride: makeMockProvider(),
    } as unknown as { cwd: string; providerOverride: unknown })) as unknown as EngineSurface;

    const h1 = engine1.run({ prompt: "first" });
    const sid1 = h1.sessionId;
    await drain(h1);
    await engine1.dispose();

    // Second engine, same cwd — continueLatest should pick up sid1.
    const engine2 = (await createEngine({
      cwd,
      providerOverride: makeMockProvider(),
    } as unknown as { cwd: string; providerOverride: unknown })) as unknown as EngineSurface;

    const h2 = engine2.continueLatest();
    expect(h2.sessionId).toBe(sid1);
    await drain(h2);
    await engine2.dispose();
  });

  it("continueLatest() on a fresh cwd throws NoSessionsForProjectError", async () => {
    const engine = (await createEngine({
      cwd,
      providerOverride: makeMockProvider(),
    } as unknown as { cwd: string; providerOverride: unknown })) as unknown as EngineSurface;

    expect(() => engine.continueLatest()).toThrow(NoSessionsForProjectError);
    await engine.dispose();
  });

  it("NoSessionsForProjectError has a stable name", async () => {
    const engine = (await createEngine({
      cwd,
      providerOverride: makeMockProvider(),
    } as unknown as { cwd: string; providerOverride: unknown })) as unknown as EngineSurface;

    try {
      engine.continueLatest();
      throw new Error("expected continueLatest() to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).name).toBe("NoSessionsForProjectError");
    } finally {
      await engine.dispose();
    }
  });
});
