import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AgentEvent } from "../events.js";
import { createLogger } from "../logger.js";
import { parseLastEventId, streamRunEvents } from "./sse.js";
import type { BufferedEvent, RunEntry } from "./types.js";

const logger = createLogger({ level: "silent" });

interface FakeStreamFrame {
  readonly id?: string;
  readonly event?: string;
  readonly data: string;
}

function makeFakeStream(): {
  stream: { writeSSE: (m: FakeStreamFrame) => Promise<void> };
  frames: FakeStreamFrame[];
} {
  const frames: FakeStreamFrame[] = [];
  return {
    stream: {
      writeSSE: (m: FakeStreamFrame) => {
        frames.push(m);
        return Promise.resolve();
      },
    },
    frames,
  };
}

function mkEvent(sid: string, seq: number): AgentEvent {
  return {
    type: "agent.message",
    session_id: sid,
    ts: Date.now(),
    seq,
    delta: `d${seq}`,
    final: false,
  };
}

function mkRun(buffer: BufferedEvent[], status: "running" | "completed" = "running"): RunEntry {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);
  return {
    runId: "r1",
    sessionId: "s1",
    status,
    buffer,
    emitter,
    abortController: new AbortController(),
    completedAt: status === "completed" ? Date.now() : null,
    createdAt: Date.now() - 100,
  };
}

describe("parseLastEventId", () => {
  it("returns null for undefined", () => expect(parseLastEventId(undefined)).toBeNull());
  it("returns null for non-numeric", () => expect(parseLastEventId("done")).toBeNull());
  it("parses numeric", () => expect(parseLastEventId("42")).toBe(42));
  it("rejects negative", () => expect(parseLastEventId("-1")).toBeNull());
});

describe("streamRunEvents", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "jellyclaw-sse-"));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("flushes buffered events then emits done for a terminal run", async () => {
    const buffer: BufferedEvent[] = [
      { id: 0, event: mkEvent("s1", 0) },
      { id: 1, event: mkEvent("s1", 1) },
      { id: 2, event: mkEvent("s1", 2) },
    ];
    const run = mkRun(buffer, "completed");
    const { stream, frames } = makeFakeStream();

    await streamRunEvents({
      run,
      sessionLogPath: join(home, "missing.jsonl"),
      lastEventId: null,
      signal: new AbortController().signal,
      // biome-ignore lint/suspicious/noExplicitAny: test fake
      stream: stream as any,
      logger,
    });

    expect(frames.length).toBe(4); // 3 events + done
    expect(frames[0]?.id).toBe("0");
    expect(frames[3]?.event).toBe("done");
  });

  it("skips events at or below lastEventId", async () => {
    const buffer: BufferedEvent[] = [
      { id: 0, event: mkEvent("s1", 0) },
      { id: 1, event: mkEvent("s1", 1) },
      { id: 2, event: mkEvent("s1", 2) },
    ];
    const run = mkRun(buffer, "completed");
    const { stream, frames } = makeFakeStream();

    await streamRunEvents({
      run,
      sessionLogPath: join(home, "missing.jsonl"),
      lastEventId: 1,
      signal: new AbortController().signal,
      // biome-ignore lint/suspicious/noExplicitAny: test fake
      stream: stream as any,
      logger,
    });

    // Only id=2 plus done
    expect(frames.length).toBe(2);
    expect(frames[0]?.id).toBe("2");
    expect(frames[1]?.event).toBe("done");
  });

  it("live subscriber receives emitter events and terminal done", async () => {
    const buffer: BufferedEvent[] = [];
    const run = mkRun(buffer, "running");
    const { stream, frames } = makeFakeStream();

    const done = streamRunEvents({
      run,
      sessionLogPath: join(home, "missing.jsonl"),
      lastEventId: null,
      signal: new AbortController().signal,
      // biome-ignore lint/suspicious/noExplicitAny: test fake
      stream: stream as any,
      logger,
    });

    // Emit two events then done
    await new Promise((r) => setTimeout(r, 5));
    run.emitter.emit("event", { id: 0, event: mkEvent("s1", 0) });
    run.emitter.emit("event", { id: 1, event: mkEvent("s1", 1) });
    await new Promise((r) => setTimeout(r, 5));
    run.emitter.emit("done", { status: "completed", sessionId: "s1" });

    await done;
    expect(frames.length).toBe(3);
    expect(frames[2]?.event).toBe("done");
  });

  it("falls back to JSONL replay when lastEventId is below buffer floor", async () => {
    // Write a real JSONL transcript with 4 events (indices 0..3), then
    // simulate a buffer whose floor is 10 so any lastEventId < 10 must
    // replay from disk.
    const { writeFile, mkdir } = await import("node:fs/promises");
    const logDir = join(home, "proj");
    await mkdir(logDir, { recursive: true });
    const logPath = join(logDir, "s1.jsonl");
    const lines = [0, 1, 2, 3].map((seq) => JSON.stringify(mkEvent("s1", seq))).join("\n");
    await writeFile(logPath, `${lines}\n`);

    const buffer: BufferedEvent[] = [
      { id: 10, event: mkEvent("s1", 10) },
      { id: 11, event: mkEvent("s1", 11) },
      { id: 12, event: mkEvent("s1", 12) },
    ];
    const run = mkRun(buffer, "completed");
    const { stream, frames } = makeFakeStream();

    await streamRunEvents({
      run,
      sessionLogPath: logPath,
      lastEventId: 2,
      signal: new AbortController().signal,
      // biome-ignore lint/suspicious/noExplicitAny: test fake
      stream: stream as any,
      logger,
    });

    // Replay indices > 2 emit id=3, then buffer emits 10,11,12, then done.
    const ids = frames.map((f) => f.id);
    expect(ids).toContain("3");
    expect(ids).toContain("10");
    expect(ids).toContain("11");
    expect(ids).toContain("12");
    expect(frames.at(-1)?.event).toBe("done");
  });
});
