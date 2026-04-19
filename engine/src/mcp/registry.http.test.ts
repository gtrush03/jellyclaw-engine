/**
 * Registry tests for HTTP transport. Uses mock clients (injected via
 * `clientFactory`) to exercise the http config path without network.
 */

import { pino } from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { McpRegistry } from "./registry.js";
import {
  type HttpMcpServerConfig,
  type McpCallToolResult,
  type McpClient,
  type McpClientEvent,
  type McpClientListener,
  McpNotReadyError,
  type McpServerConfig,
  namespaceTool,
} from "./types.js";

const silentLogger = pino({ level: "silent" });

/**
 * Minimal scriptable mock client for http transport tests.
 */
class MockHttpClient implements McpClient {
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

describe("McpRegistry + http transport", () => {
  let registry: McpRegistry;
  const createdClients: MockHttpClient[] = [];

  beforeEach(() => {
    createdClients.length = 0;
  });

  afterEach(async () => {
    await registry.stop();
  });

  it("composes an http config into listTools", async () => {
    const fakeClient = new MockHttpClient("exa", ["web_search_exa"]);
    registry = new McpRegistry({
      logger: silentLogger,
      clientFactory: () => fakeClient,
    });
    const cfg: HttpMcpServerConfig = {
      transport: "http",
      name: "exa",
      url: "https://mcp.exa.ai/mcp",
      headers: { Authorization: "Bearer test-key" },
    };
    await registry.start([cfg]);
    expect(registry.listTools()).toHaveLength(1);
    expect(registry.listTools()[0]?.namespacedName).toBe("mcp__exa__web_search_exa");
    await registry.stop();
  });

  it("auth header placement — the factory receives the full config", async () => {
    let received: McpServerConfig | null = null;
    registry = new McpRegistry({
      logger: silentLogger,
      clientFactory: (cfg) => {
        received = cfg;
        return new MockHttpClient("exa", []);
      },
    });
    await registry.start([
      {
        transport: "http",
        name: "exa",
        url: "https://mcp.exa.ai/mcp",
        headers: { Authorization: "Bearer sekret" },
      },
    ]);
    expect(received).not.toBeNull();
    expect(received?.transport).toBe("http");
    const httpCfg = received as HttpMcpServerConfig;
    expect(httpCfg.headers?.Authorization).toBe("Bearer sekret");
    await registry.stop();
  });

  it("empty config array results in empty listTools", async () => {
    registry = new McpRegistry({
      logger: silentLogger,
      clientFactory: () => new MockHttpClient("never"),
    });
    await registry.start([]);
    expect(registry.listTools()).toHaveLength(0);
  });

  it("dead http client is marked dead and scheduled for retry", async () => {
    registry = new McpRegistry({
      logger: silentLogger,
      retryIntervalMs: 25,
      clientFactory: (config) => {
        const client = new MockHttpClient(config.name, ["web_search"]);
        createdClients.push(client);
        return client;
      },
    });
    await registry.start([
      {
        transport: "http",
        name: "exa",
        url: "https://mcp.exa.ai/mcp",
        headers: { Authorization: "Bearer test" },
      },
    ]);
    expect(createdClients).toHaveLength(1);
    const first = createdClients[0];
    if (!first) throw new Error("expected mock client");
    first.markDead("chaos");

    // Retry interval is 25ms; wait a bit and expect a fresh client.
    await new Promise((r) => setTimeout(r, 80));
    expect(createdClients.length).toBeGreaterThan(1);
    // Rebuilt clients go through start() again; our mock transitions to `ready`.
    const latest = createdClients.at(-1);
    if (!latest) throw new Error("expected rebuilt mock client");
    expect(latest.status).toBe("ready");
    expect(registry.snapshot().live).toEqual(["exa"]);
  });

  it("http config with start rejection does not throw out of start()", async () => {
    registry = new McpRegistry({
      logger: silentLogger,
      retryIntervalMs: 9_999,
      clientFactory: (config) => {
        const client = new MockHttpClient(config.name);
        if (config.name === "failing") client.startBehavior = "reject";
        createdClients.push(client);
        return client;
      },
    });
    await expect(
      registry.start([
        { transport: "http", name: "working", url: "https://example.com/mcp", headers: {} },
        { transport: "http", name: "failing", url: "https://fail.example.com/mcp", headers: {} },
      ]),
    ).resolves.toBeUndefined();
    expect(registry.snapshot().live).toEqual(["working"]);
  });
});
