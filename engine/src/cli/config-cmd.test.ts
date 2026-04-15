import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { type JellyclawConfig, parseConfig } from "../config.js";
import { configCheckAction, configShowAction, redactConfig } from "./config-cmd.js";

function captureStream(): { stream: PassThrough; read: () => string } {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on("data", (c: Buffer) => chunks.push(c));
  return {
    stream,
    read: () => Buffer.concat(chunks).toString("utf8"),
  };
}

function sampleConfig(overrides: Record<string, unknown> = {}): JellyclawConfig {
  return parseConfig({
    provider: { type: "anthropic", apiKey: "sk-live-abc" },
    ...overrides,
  });
}

describe("redactConfig", () => {
  it("replaces provider apiKey with [REDACTED]", () => {
    const cfg = sampleConfig();
    const redacted = JSON.stringify(redactConfig(cfg));
    expect(redacted).not.toContain("sk-live-abc");
    expect(redacted).toContain("[REDACTED]");
  });

  it("redacts nested env and headers maps on mcp servers", () => {
    const cfg = sampleConfig({
      mcp: [
        {
          transport: "stdio",
          name: "srv",
          command: "./bin",
          env: { GH_TOKEN: "ghp_secret_token_xxxxxxxxxxxxxxxxxxxx" },
        },
        {
          transport: "http",
          name: "remote",
          url: "https://example.com/mcp",
          headers: { Authorization: "Bearer abc.def.ghi" },
        },
      ],
    });
    const serialized = JSON.stringify(redactConfig(cfg));
    expect(serialized).not.toContain("ghp_secret_token_xxxxxxxxxxxxxxxxxxxx");
    expect(serialized).not.toContain("Bearer abc.def.ghi");
    expect(serialized).toContain("[REDACTED]");
  });
});

describe("configShowAction", () => {
  it("redacts by default", async () => {
    const stdout = captureStream();
    const stderr = captureStream();
    const code = await configShowAction(
      { redact: true },
      {
        stdout: stdout.stream,
        stderr: stderr.stream,
        loadFromFile: async () => sampleConfig(),
        fileExists: () => false,
        defaults: () => sampleConfig(),
      },
    );
    expect(code).toBe(0);
    const output = stdout.read();
    expect(output).not.toContain("sk-live-abc");
    expect(output).toContain("[REDACTED]");
  });

  it("--no-redact shows the raw apiKey", async () => {
    const stdout = captureStream();
    const stderr = captureStream();
    const code = await configShowAction(
      { redact: false },
      {
        stdout: stdout.stream,
        stderr: stderr.stream,
        loadFromFile: async () => sampleConfig(),
        fileExists: () => false,
        defaults: () => sampleConfig(),
      },
    );
    expect(code).toBe(0);
    expect(stdout.read()).toContain("sk-live-abc");
  });
});

describe("configCheckAction", () => {
  it("exits 0 with no output on a clean config", async () => {
    const stdout = captureStream();
    const stderr = captureStream();
    const code = await configCheckAction(
      {},
      {
        stdout: stdout.stream,
        stderr: stderr.stream,
        loadFromFile: async () => sampleConfig(),
        fileExists: () => false,
        defaults: () => sampleConfig(),
      },
    );
    expect(code).toBe(0);
    expect(stdout.read()).toBe("");
  });

  it("exits 1 and prints a warning for a malformed permission rule", async () => {
    const stdout = captureStream();
    const stderr = captureStream();
    const cfg = sampleConfig({
      permissions: {
        mode: "ask",
        allow: ["Bash(unterminated"], // grammar failure: missing ')'
        deny: [],
      },
    });
    const code = await configCheckAction(
      {},
      {
        stdout: stdout.stream,
        stderr: stderr.stream,
        loadFromFile: async () => cfg,
        fileExists: () => false,
        defaults: () => cfg,
      },
    );
    expect(code).toBe(1);
    const out = stdout.read();
    expect(out).toContain("⚠");
    expect(out).toContain("permissions.allow");
  });

  it("flags duplicate MCP server names", async () => {
    const stdout = captureStream();
    const cfg = sampleConfig({
      mcp: [
        { transport: "stdio", name: "dup", command: "./a" },
        { transport: "stdio", name: "dup", command: "./b" },
      ],
    });
    const code = await configCheckAction(
      {},
      {
        stdout: stdout.stream,
        stderr: captureStream().stream,
        loadFromFile: async () => cfg,
        fileExists: () => false,
        defaults: () => cfg,
      },
    );
    expect(code).toBe(1);
    expect(stdout.read()).toContain("duplicate server name");
  });

  it("does not report an agents list error (Phase 06 stub inline check)", async () => {
    // Sanity: ensures the agents stub message is not accidentally emitted
    // by `config check`; this keeps surfaces decoupled.
    const stdout = captureStream();
    const code = await configCheckAction(
      {},
      {
        stdout: stdout.stream,
        stderr: captureStream().stream,
        loadFromFile: async () => sampleConfig(),
        fileExists: () => false,
        defaults: () => sampleConfig(),
      },
    );
    expect(code).toBe(0);
    expect(stdout.read()).not.toContain("Phase 06 stub");
  });
});
