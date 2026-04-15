import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { type JellyclawConfig, parseConfig } from "../config.js";
import { type McpRegistryLike, mcpListAction } from "./mcp-cmd.js";

function captureStream(): { stream: PassThrough; read: () => string } {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on("data", (c: Buffer) => chunks.push(c));
  return { stream, read: () => Buffer.concat(chunks).toString("utf8") };
}

function fakeRegistry(opts: {
  live: readonly string[];
  dead: readonly string[];
  tools: ReadonlyArray<{ server: string; namespacedName: string }>;
}): McpRegistryLike {
  return {
    start: async () => {},
    listTools: () => opts.tools,
    snapshot: () => ({ live: opts.live, dead: opts.dead, retrying: [] }),
    stop: async () => {},
  };
}

function buildConfig(): JellyclawConfig {
  return parseConfig({
    provider: { type: "anthropic" },
    mcp: [
      { transport: "stdio", name: "good", command: "./good-server" },
      { transport: "stdio", name: "bad", command: "./bad-server" },
    ],
  });
}

describe("mcpListAction", () => {
  it("renders one row per configured server and exits 0 even when some are dead", async () => {
    const stdout = captureStream();
    const stderr = captureStream();
    const cfg = buildConfig();
    const code = await mcpListAction(
      {},
      {
        stdout: stdout.stream,
        stderr: stderr.stream,
        loadFromFile: async () => cfg,
        fileExists: () => true,
        registryFactory: () =>
          fakeRegistry({
            live: ["good"],
            dead: ["bad"],
            tools: [
              { server: "good", namespacedName: "mcp__good__echo" },
              { server: "good", namespacedName: "mcp__good__fetch" },
            ],
          }),
      },
    );
    expect(code).toBe(0);
    const out = stdout.read();
    expect(out).toContain("SERVER");
    expect(out).toContain("good");
    expect(out).toContain("bad");
    expect(out).toContain("live");
    expect(out).toContain("dead");
    expect(out).toContain("mcp__good__echo");
    expect(out).toContain("mcp__good__fetch");
  });

  it("prints a friendly message when no servers are configured", async () => {
    const stdout = captureStream();
    const cfg = parseConfig({ provider: { type: "anthropic" } });
    const code = await mcpListAction(
      {},
      {
        stdout: stdout.stream,
        stderr: captureStream().stream,
        loadFromFile: async () => cfg,
        fileExists: () => true,
        registryFactory: () => fakeRegistry({ live: [], dead: [], tools: [] }),
      },
    );
    expect(code).toBe(0);
    expect(stdout.read()).toContain("no MCP servers configured");
  });

  it("skips servers with enabled:false", async () => {
    const stdout = captureStream();
    const cfg = parseConfig({
      provider: { type: "anthropic" },
      mcp: [
        { transport: "stdio", name: "on", command: "./on" },
        { transport: "stdio", name: "off", command: "./off", enabled: false },
      ],
    });
    const code = await mcpListAction(
      {},
      {
        stdout: stdout.stream,
        stderr: captureStream().stream,
        loadFromFile: async () => cfg,
        fileExists: () => true,
        registryFactory: () => fakeRegistry({ live: ["on"], dead: [], tools: [] }),
      },
    );
    expect(code).toBe(0);
    const out = stdout.read();
    expect(out).toContain("on");
    expect(out).not.toMatch(/\boff\b/);
  });
});
