/**
 * Registry tests for SSE transport. Uses mock clients (injected via
 * `clientFactory`) to exercise the sse config path without network.
 */

import { pino } from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { McpRegistry } from "./registry.js";
import {
  type McpCallToolResult,
  type McpClient,
  type McpClientEvent,
  type McpClientListener,
  McpNotReadyError,
  namespaceTool,
  type SseMcpServerConfig,
} from "./types.js";

const silentLogger = pino({ level: "silent" });

/**
 * Minimal scriptable mock client for sse transport tests.
 */
class MockSseClient implements McpClient {
  readonly server: string;
  #status: McpClient["status"] = "connecting";
  #tools: McpTool[] = [];
  readonly #listeners = new Set<McpClientListener>();
  startBehavior: "succeed" | "reject" | "deadEvent" = "succeed";
  stopCalls = 0;
  callToolImpl: (name: string, input: unknown) => Promise<McpCallToolResult> = async () => ({
    isError: false,
    content: [{ type: "text", text: "ok" }],
  });

  constructor(server: string, tools: readonly string[] = []) {
    this.server = server;
    this.#tools = tools.map((t) => ({
      name: t,
      namespacedName: namespaceTool(server, t),
      description: undefined,
      inputSchema: {},
      server,
    }));
  }

  get status() {
    return this.#status;
  }
  get tools(): readonly McpTool[] {
    return this.#tools;
  }

  start(): Promise<void> {
    if (this.startBehavior === "reject") {
      return Promise.reject(new Error(`mock ${this.server}: start rejected`));
    }
    if (this.startBehavior === "deadEvent") {
      this.#status = "dead";
      this.#emit({ type: "mcp.dead", server: this.server, reason: "mock" });
      return Promise.reject(new Error(`mock ${this.server}: start rejected with dead`));
    }
    this.#status = "ready";
    this.#emit({
      type: "mcp.connected",
      server: this.server,
      toolCount: this.#tools.length,
    });
    return Promise.resolve();
  }

  callTool(name: string, input: unknown): Promise<McpCallToolResult> {
    if (this.#status !== "ready") {
      return Promise.reject(new McpNotReadyError(this.server, this.#status));
    }
    return this.callToolImpl(name, input);
  }

  stop(): Promise<void> {
    this.stopCalls++;
    this.#status = "closed";
    return Promise.resolve();
  }

  subscribe(listener: McpClientListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  markDead(reason = "simulated"): void {
    this.#status = "dead";
    this.#emit({ type: "mcp.dead", server: this.server, reason });
  }

  #emit(event: McpClientEvent): void {
    for (const l of [...this.#listeners]) {
      try {
        l(event);
      } catch {
        /* listener errors are the client's responsibility to isolate */
      }
    }
  }
}

describe("McpRegistry + sse transport", () => {
  let registry: McpRegistry;
  const createdClients: MockSseClient[] = [];

  beforeEach(() => {
    createdClients.length = 0;
  });

  afterEach(async () => {
    await registry.stop();
  });

  it("composes an sse config into listTools", async () => {
    const fakeClient = new MockSseClient("legacy-api", ["get_data"]);
    registry = new McpRegistry({
      logger: silentLogger,
      clientFactory: () => fakeClient,
    });
    const cfg: SseMcpServerConfig = {
      transport: "sse",
      name: "legacy-api",
      url: "https://example.com/mcp/sse",
      headers: { "X-Api-Key": "secret-key-123" },
    };
    await registry.start([cfg]);
    expect(registry.listTools()).toHaveLength(1);
    expect(registry.listTools()[0]?.namespacedName).toBe("mcp__legacy-api__get_data");
    await registry.stop();
  });

  it("factory receives X-Api-Key header verbatim (case-sensitive spread check)", async () => {
    let received: McpServerConfig | null = null;
    registry = new McpRegistry({
      logger: silentLogger,
      clientFactory: (cfg) => {
        received = cfg;
        return new MockSseClient("legacy-api", []);
      },
    });
    await registry.start([
      {
        transport: "sse",
        name: "legacy-api",
        url: "https://example.com/mcp/sse",
        headers: { "X-Api-Key": "MySecretApiKey" },
      },
    ]);
    expect(received).not.toBeNull();
    expect(received?.transport).toBe("sse");
    const sseCfg = received as SseMcpServerConfig;
    expect(sseCfg.headers?.["X-Api-Key"]).toBe("MySecretApiKey");
    await registry.stop();
  });

  it("dead sse client is scheduled for retry", async () => {
    registry = new McpRegistry({
      logger: silentLogger,
      retryIntervalMs: 25,
      clientFactory: (config) => {
        const client = new MockSseClient(config.name, ["fetch"]);
        createdClients.push(client);
        return client;
      },
    });
    await registry.start([
      {
        transport: "sse",
        name: "legacy-api",
        url: "https://example.com/mcp/sse",
        headers: { Authorization: "Bearer test" },
      },
    ]);
    expect(createdClients).toHaveLength(1);
    const first = createdClients[0];
    if (!first) throw new Error("expected mock client");
    first.markDead("network failure");

    // Retry interval is 25ms; wait a bit and expect a fresh client.
    await new Promise((r) => setTimeout(r, 80));
    expect(createdClients.length).toBeGreaterThan(1);
    const latest = createdClients.at(-1);
    if (!latest) throw new Error("expected rebuilt mock client");
    expect(latest.status).toBe("ready");
    expect(registry.snapshot().live).toEqual(["legacy-api"]);
  });
});
