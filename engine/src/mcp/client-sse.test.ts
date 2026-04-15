/**
 * Tests for the SSE MCP client (Phase 07 Prompt 02, legacy transport).
 *
 * Uses an inline SSE-MCP fixture built on the SDK's
 * `SSEServerTransport`. Kept in this file (≤80 lines) because SSE is
 * the deprecated transport and not worth a dedicated fixture module.
 *
 * Each test stops the client + closes the fixture in `afterEach` so no
 * sockets outlive the test file.
 */

import {
  createServer,
  type Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { pino } from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createSseMcpClient } from "./client-sse.js";
import {
  type McpClient,
  type McpClientEvent,
  McpNotReadyError,
  type SseMcpServerConfig,
} from "./types.js";

// ---------------------------------------------------------------------------
// SDK-transport tracking for disconnect simulation
// ---------------------------------------------------------------------------
// The SDK's `SSEClientTransport.onclose` only fires from its own `close()` —
// it never surfaces server-side stream drops. That means
// `Client.onclose` (which our implementation listens on to trigger
// reconnect) can't be reached through normal network misbehavior against a
// live fixture. To exercise the reconnect contract we monkey-patch the
// transport constructor once, capture every instance the client creates,
// and later call `close()` on it ourselves to simulate an unexpected
// disconnect. The client's reconnect logic is entirely downstream of this
// signal, so this still tests real code.

const liveTransports = new Set<SSEClientTransport>();
const originalStart = SSEClientTransport.prototype.start;
SSEClientTransport.prototype.start = function patchedStart(
  this: SSEClientTransport,
): Promise<void> {
  liveTransports.add(this);
  return originalStart.call(this);
};

async function simulateUnexpectedClose(): Promise<void> {
  // Close the most recently started transport — this fires its `onclose`,
  // which propagates through the SDK `Client` and into our reconnect path.
  const last = Array.from(liveTransports).pop();
  if (!last) throw new Error("no live transport to close");
  liveTransports.delete(last);
  await last.close();
}

// ---------------------------------------------------------------------------
// Inline SSE-MCP fixture
// ---------------------------------------------------------------------------

interface SseEchoHandle {
  readonly url: string;
  close(): Promise<void>;
}

async function startSseEcho(): Promise<SseEchoHandle> {
  const transports = new Map<string, SSEServerTransport>();

  const httpServer: HttpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "/";
    try {
      if (req.method === "GET" && url.startsWith("/sse")) {
        const transport = new SSEServerTransport("/messages", res);
        const mcp = new Server(
          { name: "sse-echo-server", version: "0.0.1" },
          { capabilities: { tools: {} } },
        );
        mcp.setRequestHandler(ListToolsRequestSchema, () =>
          Promise.resolve({
            tools: [
              {
                name: "echo",
                description: "Echoes its {msg} argument.",
                inputSchema: {
                  type: "object",
                  properties: { msg: { type: "string" } },
                  required: ["msg"],
                  additionalProperties: false,
                },
              },
            ],
          }),
        );
        mcp.setRequestHandler(CallToolRequestSchema, (r) => {
          const msg = (r.params.arguments as { msg?: unknown } | undefined)?.msg;
          if (typeof msg !== "string") {
            return Promise.resolve({
              isError: true,
              content: [{ type: "text", text: "missing 'msg'" }],
            });
          }
          return Promise.resolve({
            content: [{ type: "text", text: JSON.stringify({ msg }) }],
            structuredContent: { msg },
          });
        });
        await mcp.connect(transport as unknown as Parameters<typeof mcp.connect>[0]);
        transports.set(transport.sessionId, transport);
        transport.onclose = () => transports.delete(transport.sessionId);
        return;
      }
      if (req.method === "POST" && url.startsWith("/messages")) {
        const sid = new URL(url, "http://localhost").searchParams.get("sessionId") ?? "";
        const t = transports.get(sid);
        if (!t) {
          res.statusCode = 404;
          res.end();
          return;
        }
        await t.handlePostMessage(req, res);
        return;
      }
      res.statusCode = 404;
      res.end();
    } catch (err) {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end(String((err as Error).message ?? err));
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", () => {
      httpServer.removeListener("error", reject);
      resolve();
    });
  });
  const addr = httpServer.address() as AddressInfo;
  const base = `http://127.0.0.1:${addr.port}`;

  return {
    url: `${base}/sse`,
    async close() {
      for (const t of transports.values()) {
        await t.close().catch(() => {
          /* ignore */
        });
      }
      transports.clear();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const silentLogger = pino({ level: "silent" });

function baseConfig(url: string, overrides: Partial<SseMcpServerConfig> = {}): SseMcpServerConfig {
  return {
    transport: "sse",
    name: "sse-echo",
    url,
    ...overrides,
  } satisfies SseMcpServerConfig;
}

describe("createSseMcpClient", () => {
  let client: McpClient | null = null;
  let fixture: SseEchoHandle | null = null;

  beforeEach(() => {
    client = null;
    fixture = null;
  });

  afterEach(async () => {
    if (client) {
      try {
        await client.stop();
      } catch {
        // ignore — teardown.
      }
      client = null;
    }
    if (fixture) {
      try {
        await fixture.close();
      } catch {
        // ignore — teardown.
      }
      fixture = null;
    }
  });

  it("connects, lists tools, and namespaces them under mcp__<server>__<tool>", async () => {
    fixture = await startSseEcho();
    client = createSseMcpClient(baseConfig(fixture.url), { logger: silentLogger });
    await client.start();

    expect(client.status).toBe("ready");
    expect(client.tools.map((t) => t.namespacedName)).toContain("mcp__sse-echo__echo");
  });

  it("callTool round-trips text + structured content", async () => {
    fixture = await startSseEcho();
    client = createSseMcpClient(baseConfig(fixture.url), { logger: silentLogger });
    await client.start();

    const result = await client.callTool("echo", { msg: "hi" });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({ msg: "hi" });
    const first = result.content[0];
    expect(first).toBeDefined();
    if (first && first.type === "text") {
      expect(first.text).toContain("hi");
    }
  });

  it("reconnects on unexpected stream close", async () => {
    fixture = await startSseEcho();
    client = createSseMcpClient(baseConfig(fixture.url), {
      logger: silentLogger,
      reconnectSchedule: [50, 100, 200],
      maxReconnectAttempts: 5,
    });

    const events: McpClientEvent[] = [];
    client.subscribe((e) => {
      events.push(e);
    });

    await client.start();
    expect(client.status).toBe("ready");

    // See header note on `simulateUnexpectedClose` — the SDK won't
    // surface server-side SSE drops, so we force the signal that the
    // reconnect path is built to react to.
    await simulateUnexpectedClose();

    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      if (events.some((e) => e.type === "mcp.reconnected")) break;
      await new Promise((r) => setTimeout(r, 25));
    }

    expect(events.some((e) => e.type === "mcp.disconnected")).toBe(true);
    expect(events.some((e) => e.type === "mcp.reconnected")).toBe(true);
    expect(client.status).toBe("ready");
  }, 10_000);

  it("stop() during backoff cancels the pending reconnect", async () => {
    fixture = await startSseEcho();
    client = createSseMcpClient(baseConfig(fixture.url), {
      logger: silentLogger,
      // Long backoff so we can stop() during the sleep.
      reconnectSchedule: [2_000, 2_000],
      maxReconnectAttempts: 3,
    });

    const events: McpClientEvent[] = [];
    client.subscribe((e) => {
      events.push(e);
    });

    await client.start();
    // See caveat in the reconnect test above.
    await simulateUnexpectedClose();

    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      if (events.some((e) => e.type === "mcp.disconnected")) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(events.some((e) => e.type === "mcp.disconnected")).toBe(true);

    await client.stop();
    expect(client.status).toBe("closed");

    await new Promise((r) => setTimeout(r, 300));
    expect(events.some((e) => e.type === "mcp.reconnected")).toBe(false);
    expect(client.status).toBe("closed");
  }, 10_000);

  it("bogus URL ends up dead after exhausting retries", async () => {
    client = createSseMcpClient(
      baseConfig("http://127.0.0.1:1/sse", {
        name: "bogus-sse",
        connectTimeoutMs: 100,
      }),
      {
        logger: silentLogger,
        reconnectSchedule: [10, 10],
        maxReconnectAttempts: 2,
      },
    );

    const events: McpClientEvent[] = [];
    client.subscribe((e) => {
      events.push(e);
    });

    await expect(client.start()).rejects.toThrow();
    // After initial failure, status is terminal ("dead") and mcp.dead emitted.
    expect(client.status).toBe("dead");
    expect(events.some((e) => e.type === "mcp.dead")).toBe(true);
  }, 5_000);

  it("callTool before start rejects with McpNotReadyError", async () => {
    fixture = await startSseEcho();
    client = createSseMcpClient(baseConfig(fixture.url), { logger: silentLogger });
    await expect(client.callTool("echo", { msg: "x" })).rejects.toBeInstanceOf(McpNotReadyError);
  });
});
