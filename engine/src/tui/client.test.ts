/**
 * Phase 99 — jellyclaw HTTP client tests.
 *
 * Covers:
 *   1. health()                    — GET /v1/health + bearer token
 *   2. createRun()                 — POST /v1/runs
 *   3. events()                    — SSE parse of 3 event frames + terminal done
 *   4. events() reconnect          — Last-Event-Id carried on retry; onReconnect fires
 *   5. cancel()                    — POST /v1/runs/:id/cancel
 *   6. structural: cli/tui.ts has been scrubbed of vendored-TUI references
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentEvent } from "../events.js";
import { createClient } from "./client.js";

const BASE = "http://test.local";
const TOKEN = "testtoken";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sseResponse(frames: readonly string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(encoder.encode(f));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function sseFrame(id: number, event: AgentEvent): string {
  return `id: ${id}\nevent: event\ndata: ${JSON.stringify(event)}\n\n`;
}

function doneFrame(): string {
  return `id: done\nevent: done\ndata: {"status":"completed","sessionId":"s1"}\n\n`;
}

function makeEvent(seq: number, session = "s1"): AgentEvent {
  return {
    type: "agent.message",
    session_id: session,
    ts: 1700000000000 + seq,
    seq,
    delta: `hello-${seq}`,
    final: false,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("jellyclaw client", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("health() GETs /v1/health with bearer token", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(jsonResponse({ ok: true, version: "0.0.1", uptime_ms: 42, active_runs: 0 })),
    ) as unknown as typeof fetch;

    const client = createClient({ baseUrl: BASE, token: TOKEN, fetch: fetchMock });
    const res = await client.health();

    expect(res.ok).toBe(true);
    expect(res.version).toBe("0.0.1");

    const [url, init] = (fetchMock as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0] as [string, RequestInit];
    expect(url).toBe("http://test.local/v1/health");
    expect(init?.method).toBe("GET");
    const headers = init?.headers as Record<string, string>;
    expect(headers?.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("createRun() POSTs /v1/runs with JSON body + bearer token", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ runId: "r1", sessionId: "s1" }, 201),
    ) as unknown as typeof fetch;

    const client = createClient({ baseUrl: BASE, token: TOKEN, fetch: fetchMock });
    const res = await client.createRun({ prompt: "hello world" });

    expect(res).toEqual({ runId: "r1", sessionId: "s1" });

    const [url, init] = (fetchMock as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0] as [string, RequestInit];
    expect(url).toBe("http://test.local/v1/runs");
    expect(init?.method).toBe("POST");
    const headers = init?.headers as Record<string, string>;
    expect(headers?.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(headers?.["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init?.body as string)).toEqual({ prompt: "hello world" });
  });

  it("events() yields AgentEvents from SSE frames and stops on done", async () => {
    const frames = [
      sseFrame(1, makeEvent(1)),
      sseFrame(2, makeEvent(2)),
      sseFrame(3, makeEvent(3)),
      doneFrame(),
    ];
    const fetchMock = vi.fn(async () => sseResponse(frames)) as unknown as typeof fetch;

    const client = createClient({ baseUrl: BASE, token: TOKEN, fetch: fetchMock });
    const collected: AgentEvent[] = [];
    for await (const ev of client.events("r1")) {
      collected.push(ev);
    }

    expect(collected).toHaveLength(3);
    expect(collected[0]?.seq).toBe(1);
    expect(collected[2]?.seq).toBe(3);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("events() reconnects on mid-stream failure and carries Last-Event-Id", async () => {
    vi.useFakeTimers();

    // First response: one event, then the stream errors on the next pull.
    const firstStream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        controller.enqueue(enc.encode(sseFrame(7, makeEvent(1))));
      },
      pull(controller) {
        // First pull gives the buffered chunk; second pull (after the client
        // consumed it) raises the transient failure.
        controller.error(new Error("network-kaboom"));
      },
    });
    const firstResponse = new Response(firstStream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });

    // Second response: remaining events + done.
    const secondResponse = sseResponse([
      sseFrame(8, makeEvent(2)),
      sseFrame(9, makeEvent(3)),
      doneFrame(),
    ]);

    let call = 0;
    const capturedHeaders: Array<Record<string, string>> = [];
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      capturedHeaders.push((init?.headers as Record<string, string>) ?? {});
      call += 1;
      return Promise.resolve(call === 1 ? firstResponse : secondResponse);
    }) as unknown as typeof fetch;

    const reconnects: Array<{ attempt: number; delayMs: number }> = [];
    // Replace setTimeout with one that immediately resolves — the iterator
    // schedules the reconnect delay via opts.setTimeout.
    const schedule = (fn: () => void, _ms: number): unknown => {
      queueMicrotask(fn);
      return 0;
    };

    const client = createClient({
      baseUrl: BASE,
      token: TOKEN,
      fetch: fetchMock,
      setTimeout: schedule,
      onReconnect: (attempt, delayMs) => reconnects.push({ attempt, delayMs }),
    });

    const collected: AgentEvent[] = [];
    for await (const ev of client.events("r1")) {
      collected.push(ev);
    }

    expect(collected).toHaveLength(3);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(reconnects[0]).toEqual({ attempt: 1, delayMs: 200 });
    // Second fetch must have carried the last event id from the first stream.
    expect(capturedHeaders[1]?.["Last-Event-Id"]).toBe("7");
  });

  it("cancel(runId) POSTs /v1/runs/:id/cancel", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}, 202)) as unknown as typeof fetch;

    const client = createClient({ baseUrl: BASE, token: TOKEN, fetch: fetchMock });
    await client.cancel("r1");

    const [url, init] = (fetchMock as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0] as [string, RequestInit];
    expect(url).toBe("http://test.local/v1/runs/r1/cancel");
    expect(init?.method).toBe("POST");
    const headers = init?.headers as Record<string, string>;
    expect(headers?.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("cli/tui.ts is free of vendored-TUI substrings (Agent A contract)", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const tuiPath = resolve(here, "..", "cli", "tui.ts");
    const source = readFileSync(tuiPath, "utf8");
    expect(source).not.toContain("void spawnServer");
    expect(source).not.toContain("_vendored");
    expect(source).not.toContain("spawnStockTui");
  });
});
