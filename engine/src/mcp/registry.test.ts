/**
 * Registry tests. Uses the real echo-server stdio fixture for live tests
 * and synthetic mock clients (injected via `clientFactory`) where that
 * exercises the control flow more deterministically.
 */

import { resolve } from "node:path";
import { pino } from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { McpRegistry } from "./registry.js";
import {
  type McpCallToolResult,
  type McpClient,
  type McpClientEvent,
  type McpClientListener,
  McpNotReadyError,
  type McpServerConfig,
  type McpTool,
  McpUnknownServerError,
  namespaceTool,
} from "./types.js";

const FIXTURE_PATH = resolve(import.meta.dirname, "../../../test/fixtures/mcp/echo-server.ts");

const silentLogger = pino({ level: "silent" });

function echoConfig(name = "echo"): McpServerConfig {
  return {
    transport: "stdio",
    name,
    command: "bun",
    args: ["run", FIXTURE_PATH],
  };
}

function bogusConfig(name = "bogus"): McpServerConfig {
  return {
    transport: "stdio",
    name,
    command: "this-command-definitely-does-not-exist-jellyclaw",
    args: [],
  };
}

/**
 * Minimal scriptable mock client. Lets tests drive status + emit events
 * without having to spawn real children.
 */
class MockClient implements McpClient {
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

describe("McpRegistry (live stdio)", () => {
  let registry: McpRegistry;

  beforeEach(() => {
    registry = new McpRegistry({ logger: silentLogger });
  });

  afterEach(async () => {
    await registry.stop();
  });

  it("starts an echo server and exposes namespaced tools", async () => {
    await registry.start([echoConfig()]);
    const tools = registry.listTools();
    expect(tools.map((t) => t.namespacedName)).toContain("mcp__echo__echo");
    const snap = registry.snapshot();
    expect(snap.live).toEqual(["echo"]);
    expect(snap.dead).toEqual([]);
  });

  it("reports 1 live + 1 dead when one server fails to start", async () => {
    await registry.start([echoConfig("echo"), bogusConfig("gone")]);
    const snap = registry.snapshot();
    expect(snap.live).toEqual(["echo"]);
    // The bogus server may be either `dead` (spawn failure cascaded) or
    // `retrying` (background retry timer armed). Either way, not live.
    expect([...snap.dead, ...snap.retrying]).toContain("gone");
    expect(registry.listTools().some((t) => t.namespacedName.startsWith("mcp__gone__"))).toBe(
      false,
    );
  });

  it("routes callTool via namespaced name", async () => {
    await registry.start([echoConfig()]);
    const result = await registry.callTool("mcp__echo__echo", { msg: "hi" });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({ msg: "hi" });
  });
});

describe("McpRegistry (mocked clients)", () => {
  let registry: McpRegistry;
  const createdClients: MockClient[] = [];

  beforeEach(() => {
    createdClients.length = 0;
    registry = new McpRegistry({
      logger: silentLogger,
      retryIntervalMs: 25,
      clientFactory: (config) => {
        const client = new MockClient(config.name, config.name === "echo" ? ["echo"] : []);
        createdClients.push(client);
        return client;
      },
    });
  });

  afterEach(async () => {
    await registry.stop();
  });

  it("unknown_server error for totally-absent namespace", async () => {
    await registry.start([]);
    await expect(registry.callTool("mcp__nope__x", {})).rejects.toBeInstanceOf(
      McpUnknownServerError,
    );
  });

  it("unknown_server error for malformed namespaced name", async () => {
    await registry.start([]);
    await expect(registry.callTool("not-a-namespaced-tool", {})).rejects.toBeInstanceOf(
      McpUnknownServerError,
    );
  });

  it("deduplicates duplicate server names in config", async () => {
    await registry.start([
      { transport: "stdio", name: "echo", command: "bun", args: [] },
      { transport: "stdio", name: "echo", command: "bun", args: [] },
    ]);
    expect(createdClients).toHaveLength(1);
  });

  it("does NOT throw out of start() when a client rejects", async () => {
    registry = new McpRegistry({
      logger: silentLogger,
      retryIntervalMs: 9_999, // don't let retry fire during this test
      clientFactory: (config) => {
        const client = new MockClient(config.name);
        if (config.name === "bad") client.startBehavior = "reject";
        createdClients.push(client);
        return client;
      },
    });
    await expect(
      registry.start([
        { transport: "stdio", name: "ok", command: "bun", args: [] },
        { transport: "stdio", name: "bad", command: "bun", args: [] },
      ]),
    ).resolves.toBeUndefined();
    expect(registry.snapshot().live).toEqual(["ok"]);
  });

  it("schedules a background retry after a client goes dead", async () => {
    await registry.start([{ transport: "stdio", name: "echo", command: "bun", args: [] }]);
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
    expect(registry.snapshot().live).toEqual(["echo"]);
  });

  it("stop() cancels pending retries and closes all clients", async () => {
    await registry.start([{ transport: "stdio", name: "echo", command: "bun", args: [] }]);
    const first = createdClients[0];
    if (!first) throw new Error("expected mock client");
    first.markDead();
    await registry.stop();
    const countAtStop = createdClients.length;
    await new Promise((r) => setTimeout(r, 80));
    expect(createdClients.length).toBe(countAtStop);
  });

  it("callTool rejects when server is known but not ready", async () => {
    registry = new McpRegistry({
      logger: silentLogger,
      retryIntervalMs: 9_999,
      clientFactory: (config) => {
        const client = new MockClient(config.name, ["echo"]);
        createdClients.push(client);
        return client;
      },
    });
    await registry.start([{ transport: "stdio", name: "echo", command: "bun", args: [] }]);
    const first = createdClients[0];
    if (!first) throw new Error("expected mock client");
    first.markDead();
    await expect(registry.callTool("mcp__echo__echo", {})).rejects.toBeInstanceOf(McpNotReadyError);
  });
});
