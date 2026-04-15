/**
 * Phase 99-06 — additional client coverage.
 *
 * The base reconnect-with-Last-Event-Id case lives in
 * `engine/src/tui/client.test.ts`. This suite layers on a 5xx → 200 retry
 * pattern (server-issued transient failure rather than mid-stream chunk
 * error) and covers the new `resolvePermission` method.
 */

import { describe, expect, it, vi } from "vitest";

import type { AgentEvent } from "../../src/events.js";
import { createClient } from "../../src/tui/client.js";

const BASE = "http://test.local";
const TOKEN = "tok";

function sseResponse(frames: readonly string[]): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (const f of frames) c.enqueue(enc.encode(f));
      c.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function frame(id: number, ev: AgentEvent): string {
  return `id: ${id}\nevent: event\ndata: ${JSON.stringify(ev)}\n\n`;
}

function done(): string {
  return `id: done\nevent: done\ndata: {}\n\n`;
}

function makeEvent(seq: number): AgentEvent {
  return {
    type: "agent.message",
    session_id: "s1",
    ts: 1700000000000 + seq,
    seq,
    delta: `chunk-${seq}`,
    final: false,
  };
}

describe("client extras", () => {
  it("events() retries on initial 5xx and carries Last-Event-Id when set", async () => {
    let call = 0;
    const captured: Array<Record<string, string>> = [];
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      captured.push((init?.headers as Record<string, string>) ?? {});
      call += 1;
      if (call === 1) {
        return Promise.resolve(
          new Response("upstream blip", {
            status: 503,
            headers: { "content-type": "text/plain" },
          }),
        );
      }
      return Promise.resolve(sseResponse([frame(1, makeEvent(1)), frame(2, makeEvent(2)), done()]));
    }) as unknown as typeof fetch;

    const schedule = (fn: () => void): unknown => {
      queueMicrotask(fn);
      return 0;
    };

    const reconnects: Array<{ attempt: number; delayMs: number }> = [];
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

    expect(collected).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(reconnects[0]?.attempt).toBe(1);
    // First call had no Last-Event-Id (we hadn't seen one yet); second call
    // also has no Last-Event-Id because the 5xx never delivered an event id.
    expect(captured[0]?.["Last-Event-Id"]).toBeUndefined();
    expect(captured[1]?.["Last-Event-Id"]).toBeUndefined();
  });

  it("resolvePermission() POSTs /v1/permissions/:id with {granted}", async () => {
    const fetchMock = vi.fn(
      async () => new Response(null, { status: 204 }),
    ) as unknown as typeof fetch;
    const client = createClient({ baseUrl: BASE, token: TOKEN, fetch: fetchMock });
    await client.resolvePermission("req-42", true);

    const [url, init] = (fetchMock as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0] as [string, RequestInit];
    expect(url).toBe("http://test.local/v1/permissions/req-42");
    expect(init?.method).toBe("POST");
    const headers = init?.headers as Record<string, string>;
    expect(headers?.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(headers?.["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init?.body as string)).toEqual({ granted: true });
  });

  it("resolvePermission() with granted:false posts the expected body", async () => {
    const fetchMock = vi.fn(
      async () => new Response(null, { status: 204 }),
    ) as unknown as typeof fetch;
    const client = createClient({ baseUrl: BASE, token: TOKEN, fetch: fetchMock });
    await client.resolvePermission("req-99", false);

    const [, init] = (fetchMock as unknown as { mock: { calls: unknown[][] } }).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(JSON.parse(init?.body as string)).toEqual({ granted: false });
  });
});
