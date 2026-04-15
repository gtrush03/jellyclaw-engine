/**
 * Tests for the StreamableHTTP MCP client (Phase 07 Prompt 02).
 *
 * Uses the real `test/fixtures/mcp/http-echo.ts` fixture — no SDK
 * mocking. Each test stops the client and closes the fixture in
 * `afterEach` so zombie HTTP servers never outlive the test file.
 *
 * OAuth-auth scenarios live in `oauth.test.ts`; this file stays
 * focused on the transport + lifecycle contract.
 */

import { pino } from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startHttpEcho } from "../../../test/fixtures/mcp/http-echo.js";
import { createHttpMcpClient } from "./client-http.js";
import { type HttpMcpServerConfig, type McpClient, McpNotReadyError } from "./types.js";

const silentLogger = pino({ level: "silent" });

function baseConfig(
  url: string,
  overrides: Partial<HttpMcpServerConfig> = {},
): HttpMcpServerConfig {
  return {
    transport: "http",
    name: "http-echo",
    url,
    ...overrides,
  } satisfies HttpMcpServerConfig;
}

describe("createHttpMcpClient", () => {
  let client: McpClient | null = null;
  let fixture: Awaited<ReturnType<typeof startHttpEcho>> | null = null;

  beforeEach(() => {
    client = null;
    fixture = null;
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
    if (fixture) {
      try {
        await fixture.close();
      } catch {
        // ignore — test teardown.
      }
      fixture = null;
    }
  });

  it("connects, lists tools, and namespaces them under mcp__<server>__<tool>", async () => {
    fixture = await startHttpEcho();
    client = createHttpMcpClient(baseConfig(fixture.url), { logger: silentLogger });
    await client.start();

    expect(client.status).toBe("ready");
    expect(client.tools.map((t) => t.namespacedName)).toContain("mcp__http-echo__echo");
  });

  it("callTool returns the expected structured + text content", async () => {
    fixture = await startHttpEcho();
    client = createHttpMcpClient(baseConfig(fixture.url), { logger: silentLogger });
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

  it("stop() is idempotent and transitions status to closed", async () => {
    fixture = await startHttpEcho();
    client = createHttpMcpClient(baseConfig(fixture.url), { logger: silentLogger });
    await client.start();

    await client.stop();
    expect(client.status).toBe("closed");
    await expect(client.stop()).resolves.toBeUndefined();
    expect(client.status).toBe("closed");
  });

  it("callTool before start rejects with McpNotReadyError", async () => {
    fixture = await startHttpEcho();
    client = createHttpMcpClient(baseConfig(fixture.url), { logger: silentLogger });

    await expect(client.callTool("echo", { msg: "x" })).rejects.toBeInstanceOf(McpNotReadyError);
  });

  it("connect timeout rejects and leaves status as dead", async () => {
    client = createHttpMcpClient(baseConfig("http://127.0.0.1:1/mcp", { connectTimeoutMs: 200 }), {
      logger: silentLogger,
    });

    const started = Date.now();
    await expect(client.start()).rejects.toThrow();
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(2_000);
    expect(client.status).toBe("dead");
  }, 5_000);

  it("unreachable host: rejection message mentions the server name", async () => {
    client = createHttpMcpClient(
      baseConfig("http://127.0.0.1:1/mcp", {
        name: "bogus-server",
        connectTimeoutMs: 200,
      }),
      { logger: silentLogger },
    );

    await expect(client.start()).rejects.toThrow(/bogus-server/);
    expect(client.status).toBe("dead");
  }, 5_000);
});
