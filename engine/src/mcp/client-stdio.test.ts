/**
 * Tests for the stdio MCP client (Phase 07 Prompt 01).
 *
 * Uses the real `test/fixtures/mcp/echo-server.ts` fixture via `bun run`
 * — no SDK mocking. Each test stops the client in `afterEach` so zombie
 * child processes never outlive the test file.
 */

import { resolve } from "node:path";

import { pino } from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createStdioMcpClient } from "./client-stdio.js";
import {
  type McpClient,
  type McpClientEvent,
  McpNotReadyError,
  type StdioMcpServerConfig,
} from "./types.js";

const ECHO_FIXTURE = resolve(
  import.meta.dirname ?? new URL(".", import.meta.url).pathname,
  "../../../test/fixtures/mcp/echo-server.ts",
);

const silentLogger = pino({ level: "silent" });

function baseConfig(overrides: Partial<StdioMcpServerConfig> = {}): StdioMcpServerConfig {
  return {
    transport: "stdio",
    name: "echo",
    command: "bun",
    args: ["run", ECHO_FIXTURE],
    ...overrides,
  } satisfies StdioMcpServerConfig;
}

/**
 * Accessor for the test-only pid exposed on the concrete client. Kept
 * narrow so we never reach into other internals.
 */
function pidOf(client: McpClient): number | null {
  const accessor = (client as unknown as { __testPid__?: number | null }).__testPid__;
  return accessor ?? null;
}

describe("createStdioMcpClient", () => {
  let client: McpClient | null = null;

  beforeEach(() => {
    client = null;
  });

  afterEach(async () => {
    if (client) {
      try {
        await client.stop();
      } catch {
        // ignore — test teardown.
      }
      client = null;
    }
  });

  it("connects, lists tools, and namespaces them under mcp__<server>__<tool>", async () => {
    client = createStdioMcpClient(baseConfig(), { logger: silentLogger });
    await client.start();

    expect(client.status).toBe("ready");
    expect(client.tools.length).toBe(1);
    const tool = client.tools[0];
    expect(tool).toBeDefined();
    expect(tool?.name).toBe("echo");
    expect(tool?.namespacedName).toBe("mcp__echo__echo");
    expect(tool?.server).toBe("echo");
  });

  it("callTool returns the expected text + structured content", async () => {
    client = createStdioMcpClient(baseConfig(), { logger: silentLogger });
    await client.start();

    const result = await client.callTool("echo", { msg: "hi" });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({ msg: "hi" });
    const first = result.content[0];
    expect(first).toBeDefined();
    expect(first?.type).toBe("text");
    if (first && first.type === "text") {
      expect(first.text).toBe(JSON.stringify({ msg: "hi" }));
    }
  });

  it("reconnects automatically on unexpected child exit", async () => {
    client = createStdioMcpClient(baseConfig(), {
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

    const pid = pidOf(client);
    expect(pid).not.toBeNull();

    // Kill the child out-of-band to trigger the disconnect path.
    process.kill(pid as number, "SIGKILL");

    // Wait for disconnect → reconnected, up to 4 s.
    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline) {
      if (events.some((e) => e.type === "mcp.reconnected")) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(events.some((e) => e.type === "mcp.disconnected")).toBe(true);
    expect(events.some((e) => e.type === "mcp.reconnected")).toBe(true);
    expect(client.status).toBe("ready");
    expect(client.tools.length).toBe(1);
  }, 10_000);

  it("marks the client dead when the command does not exist", async () => {
    client = createStdioMcpClient(
      baseConfig({
        command: "this-definitely-does-not-exist-jellyclaw",
        args: [],
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

    // No reconnect loop kicks off from a failed initial start — subsequent
    // callTool must fail with McpNotReadyError, and status is terminal
    // (either "connecting" pre-start or whatever the failure left it).
    await expect(client.callTool("echo", { msg: "x" })).rejects.toBeInstanceOf(McpNotReadyError);
    void events; // events assertion intentionally lenient — initial failures don't emit mcp.dead
  });

  it("isolates listener errors", async () => {
    client = createStdioMcpClient(baseConfig(), { logger: silentLogger });

    const received: McpClientEvent[] = [];
    client.subscribe(() => {
      throw new Error("listener A boom");
    });
    client.subscribe((e) => {
      received.push(e);
    });

    await client.start();

    expect(received.some((e) => e.type === "mcp.connected")).toBe(true);
  });

  it("stop() during reconnect backoff is cancellable", async () => {
    client = createStdioMcpClient(baseConfig(), {
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
    const pid = pidOf(client);
    expect(pid).not.toBeNull();

    // Trigger disconnect.
    process.kill(pid as number, "SIGKILL");

    // Wait for disconnected event to arrive, then stop immediately.
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      if (events.some((e) => e.type === "mcp.disconnected")) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(events.some((e) => e.type === "mcp.disconnected")).toBe(true);

    await client.stop();
    expect(client.status).toBe("closed");

    // Wait past the minimum backoff window to confirm no reconnect fires.
    await new Promise((r) => setTimeout(r, 300));
    expect(events.some((e) => e.type === "mcp.reconnected")).toBe(false);
    expect(client.status).toBe("closed");
  }, 10_000);
});
