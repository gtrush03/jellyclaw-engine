import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AgentEvent } from "../events.js";
import { createLogger } from "../logger.js";
import { SessionPaths } from "../session/index.js";
import { createRunManager } from "./run-manager.js";
import type { BufferedEvent } from "./types.js";

const logger = createLogger({ level: "silent" });

function syntheticIterator(sid: string, count: number, delayMs = 0): AsyncIterable<AgentEvent> {
  return (async function* () {
    for (let i = 0; i < count; i++) {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      yield {
        type: "agent.message",
        session_id: sid,
        ts: Date.now(),
        seq: i,
        delta: `delta-${i}`,
        final: i === count - 1,
      };
    }
  })();
}

function cancellableIterator(sid: string, signal: AbortSignal): AsyncIterable<AgentEvent> {
  return (async function* () {
    let i = 0;
    while (!signal.aborted) {
      await new Promise((r) => setTimeout(r, 5));
      yield {
        type: "agent.message",
        session_id: sid,
        ts: Date.now(),
        seq: i,
        delta: `d${i}`,
        final: false,
      };
      i++;
      if (i > 200) return; // safety
    }
  })();
}

describe("RunManager", () => {
  let home: string;
  let paths: SessionPaths;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "jellyclaw-rm-"));
    paths = new SessionPaths({ home });
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("create + iterate + snapshot", async () => {
    const rm_ = createRunManager({
      logger,
      paths,
      runFactory: ({ sessionId }) => syntheticIterator(sessionId, 3),
    });
    const entry = await rm_.create({ prompt: "hi" });
    expect(entry.runId).toBeDefined();
    expect(entry.sessionId).toBeDefined();

    // Wait for done
    await new Promise<void>((resolve) => entry.emitter.once("done", () => resolve()));

    const snap = rm_.snapshot();
    expect(snap.totalRuns).toBe(1);
    expect(snap.completedRuns).toBe(1);
    expect(snap.activeRuns).toBe(0);

    const fetched = rm_.get(entry.runId);
    expect(fetched?.buffer.length).toBe(3);
    expect(fetched?.status).toBe("completed");
  });

  it("subscribers receive events via emitter in order", async () => {
    const rm_ = createRunManager({
      logger,
      paths,
      runFactory: ({ sessionId }) => syntheticIterator(sessionId, 5, 1),
    });
    const received: BufferedEvent[] = [];
    const entry = await rm_.create({ prompt: "hi" });
    entry.emitter.on("event", (e: BufferedEvent) => received.push(e));

    await new Promise<void>((resolve) => entry.emitter.once("done", () => resolve()));
    // buffer already has early events pushed synchronously before listener attached,
    // so we only verify that tail events arrived in order (ids monotonic).
    for (let i = 1; i < received.length; i++) {
      const prev = received[i - 1];
      const cur = received[i];
      if (!prev || !cur) continue;
      expect(cur.id).toBeGreaterThan(prev.id);
    }
  });

  it("cancel aborts a running run", async () => {
    const rm_ = createRunManager({
      logger,
      paths,
      runFactory: ({ sessionId, signal }) => cancellableIterator(sessionId, signal),
    });
    const entry = await rm_.create({ prompt: "long" });
    await new Promise((r) => setTimeout(r, 20));
    expect(rm_.cancel(entry.runId)).toBe(true);
    await new Promise<void>((resolve) => entry.emitter.once("done", () => resolve()));
    expect(rm_.get(entry.runId)?.status).toBe("cancelled");
  });

  it("steer injects a synthetic event while running", async () => {
    const rm_ = createRunManager({
      logger,
      paths,
      runFactory: ({ sessionId, signal }) => cancellableIterator(sessionId, signal),
    });
    const entry = await rm_.create({ prompt: "x" });
    await new Promise((r) => setTimeout(r, 15));
    const ok = rm_.steer(entry.runId, "please focus");
    expect(ok).toBe(true);
    rm_.cancel(entry.runId);
    await new Promise<void>((resolve) => entry.emitter.once("done", () => resolve()));
    const found = entry.buffer.find(
      (b) => b.event.type === "agent.message" && b.event.delta.startsWith("[steer]"),
    );
    expect(found).toBeDefined();
  });

  it("steer returns false for unknown run", () => {
    const rm_ = createRunManager({ logger, paths, runFactory: () => syntheticIterator("x", 0) });
    expect(rm_.steer("nope", "hi")).toBe(false);
  });

  it("ring buffer evicts old events past cap", async () => {
    const rm_ = createRunManager({
      logger,
      paths,
      ringBufferCap: 4,
      runFactory: ({ sessionId }) => syntheticIterator(sessionId, 10),
    });
    const entry = await rm_.create({ prompt: "x" });
    await new Promise<void>((resolve) => entry.emitter.once("done", () => resolve()));
    const fetched = rm_.get(entry.runId);
    expect(fetched?.buffer.length).toBe(4);
    // floor should be 6 (ids 0-5 evicted, 6-9 retained)
    expect(fetched?.buffer[0]?.id).toBe(6);
    expect(fetched?.buffer[3]?.id).toBe(9);
  });

  it("shutdown aborts active runs and resolves within grace", async () => {
    const rm_ = createRunManager({
      logger,
      paths,
      runFactory: ({ sessionId, signal }) => cancellableIterator(sessionId, signal),
    });
    await rm_.create({ prompt: "a" });
    await rm_.create({ prompt: "b" });
    await new Promise((r) => setTimeout(r, 10));
    const start = Date.now();
    await rm_.shutdown(500);
    expect(Date.now() - start).toBeLessThan(500);
    expect(rm_.snapshot().activeRuns).toBe(0);
  });
});
