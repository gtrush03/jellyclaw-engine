/**
 * Tests for MCP config loader (T0-01).
 */

import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import { ExitError } from "./main.js";
import { type LoadMcpConfigsDeps, loadMcpConfigs } from "./mcp-config-loader.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeNullLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: () => makeNullLogger(),
  } as unknown as Logger;
}

function makeFilesystem(files: Record<string, string>): LoadMcpConfigsDeps {
  return {
    fileExists: (path) => path in files,
    // biome-ignore lint/suspicious/useAwait: Matches LoadMcpConfigsDeps.readFile signature
    readFile: async (path) => {
      if (path in files) return files[path] as string;
      throw new Error(`ENOENT: ${path}`);
    },
    homedir: () => "/home/test",
  };
}

const VALID_CONFIG = JSON.stringify({
  provider: { type: "anthropic" },
  mcp: [
    {
      transport: "stdio",
      name: "echo",
      command: "echo",
      args: ["hello"],
    },
  ],
});

const _VALID_CONFIG_TWO_SERVERS = JSON.stringify({
  provider: { type: "anthropic" },
  mcp: [
    {
      transport: "stdio",
      name: "echo",
      command: "echo",
      args: ["hello"],
    },
    {
      transport: "stdio",
      name: "cat",
      command: "cat",
      args: ["-"],
    },
  ],
});

const VALID_CONFIG_DISABLED = JSON.stringify({
  provider: { type: "anthropic" },
  mcp: [
    {
      transport: "stdio",
      name: "disabled-server",
      command: "echo",
      args: ["disabled"],
      enabled: false,
    },
  ],
});

const VALID_CONFIG_UNDERSCORE_DISABLED = JSON.stringify({
  provider: { type: "anthropic" },
  mcp: [
    {
      _comment: "This server is disabled via _disabled marker",
      _disabled: true,
      transport: "stdio",
      name: "underscore-disabled-server",
      command: "echo",
      args: ["disabled"],
    },
  ],
});

const EMPTY_MCP_CONFIG = JSON.stringify({
  provider: { type: "anthropic" },
  mcp: [],
});

const INVALID_JSON = "{ not valid json }";

const INVALID_SCHEMA = JSON.stringify({
  provider: { type: "anthropic" },
  mcp: [
    {
      transport: "invalid-transport",
      name: "bad",
    },
  ],
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("loadMcpConfigs", () => {
  describe("no sources exist", () => {
    it("returns empty array when no config files exist", async () => {
      const deps = makeFilesystem({});
      const result = await loadMcpConfigs({ cwd: "/tmp" }, deps);
      expect(result).toEqual([]);
    });
  });

  describe("loads from cwd", () => {
    it("loads <cwd>/jellyclaw.json when present", async () => {
      const deps = makeFilesystem({
        "/tmp/jellyclaw.json": VALID_CONFIG,
      });
      const result = await loadMcpConfigs({ cwd: "/tmp" }, deps);
      expect(result).toHaveLength(1);
      expect(result[0]?.name).toBe("echo");
    });
  });

  describe("loads from home", () => {
    it("loads ~/.jellyclaw/jellyclaw.json when present", async () => {
      const deps = makeFilesystem({
        "/home/test/.jellyclaw/jellyclaw.json": VALID_CONFIG,
      });
      const result = await loadMcpConfigs({ cwd: "/tmp" }, deps);
      expect(result).toHaveLength(1);
      expect(result[0]?.name).toBe("echo");
    });
  });

  describe("merge behavior", () => {
    it("merges cwd and home configs with first-write-wins", async () => {
      const logger = makeNullLogger();
      const deps = makeFilesystem({
        "/tmp/jellyclaw.json": JSON.stringify({
          provider: { type: "anthropic" },
          mcp: [{ transport: "stdio", name: "echo", command: "cwd-echo", args: [] }],
        }),
        "/home/test/.jellyclaw/jellyclaw.json": JSON.stringify({
          provider: { type: "anthropic" },
          mcp: [
            { transport: "stdio", name: "echo", command: "home-echo", args: [] },
            { transport: "stdio", name: "cat", command: "cat", args: [] },
          ],
        }),
      });

      const result = await loadMcpConfigs({ cwd: "/tmp", logger }, deps);

      // "echo" should come from cwd (first-write-wins)
      expect(result).toHaveLength(2);
      const echo = result.find((s) => s.name === "echo");
      expect(echo).toBeDefined();
      if (echo?.transport === "stdio") {
        expect(echo.command).toBe("cwd-echo");
      }

      // "cat" should come from home (not in cwd)
      const cat = result.find((s) => s.name === "cat");
      expect(cat).toBeDefined();

      // Should have logged a warning about the duplicate
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  describe("explicit --mcp-config flag", () => {
    it("loads from explicit path when provided", async () => {
      const deps = makeFilesystem({
        "/custom/config.json": VALID_CONFIG,
      });
      const result = await loadMcpConfigs({ cwd: "/tmp", mcpConfig: "/custom/config.json" }, deps);
      expect(result).toHaveLength(1);
      expect(result[0]?.name).toBe("echo");
    });

    it("explicit config takes precedence over cwd/home", async () => {
      const deps = makeFilesystem({
        "/custom/config.json": JSON.stringify({
          provider: { type: "anthropic" },
          mcp: [{ transport: "stdio", name: "echo", command: "custom-echo", args: [] }],
        }),
        "/tmp/jellyclaw.json": JSON.stringify({
          provider: { type: "anthropic" },
          mcp: [{ transport: "stdio", name: "echo", command: "cwd-echo", args: [] }],
        }),
      });

      const result = await loadMcpConfigs({ cwd: "/tmp", mcpConfig: "/custom/config.json" }, deps);

      expect(result).toHaveLength(1);
      const echo = result[0];
      if (echo?.transport === "stdio") {
        expect(echo.command).toBe("custom-echo");
      }
    });
  });

  describe("throws on nonexistent --mcp-config", () => {
    it("throws ExitError(4) when explicit path doesn't exist", async () => {
      const deps = makeFilesystem({});
      await expect(
        loadMcpConfigs({ cwd: "/tmp", mcpConfig: "/nonexistent.json" }, deps),
      ).rejects.toThrow(ExitError);

      try {
        await loadMcpConfigs({ cwd: "/tmp", mcpConfig: "/nonexistent.json" }, deps);
      } catch (err) {
        expect(err).toBeInstanceOf(ExitError);
        expect((err as ExitError).code).toBe(4);
        expect((err as ExitError).message).toContain("mcp config not found");
      }
    });
  });

  describe("zod validation error on malformed JSON", () => {
    it("throws ExitError(4) for invalid JSON in --mcp-config", async () => {
      const deps = makeFilesystem({
        "/custom/config.json": INVALID_JSON,
      });
      await expect(
        loadMcpConfigs({ cwd: "/tmp", mcpConfig: "/custom/config.json" }, deps),
      ).rejects.toThrow(ExitError);

      try {
        await loadMcpConfigs({ cwd: "/tmp", mcpConfig: "/custom/config.json" }, deps);
      } catch (err) {
        expect(err).toBeInstanceOf(ExitError);
        expect((err as ExitError).code).toBe(4);
        expect((err as ExitError).message).toContain("invalid JSON");
      }
    });

    it("throws ExitError(4) for schema errors in --mcp-config", async () => {
      const deps = makeFilesystem({
        "/custom/config.json": INVALID_SCHEMA,
      });
      await expect(
        loadMcpConfigs({ cwd: "/tmp", mcpConfig: "/custom/config.json" }, deps),
      ).rejects.toThrow(ExitError);

      try {
        await loadMcpConfigs({ cwd: "/tmp", mcpConfig: "/custom/config.json" }, deps);
      } catch (err) {
        expect(err).toBeInstanceOf(ExitError);
        expect((err as ExitError).code).toBe(4);
        expect((err as ExitError).message).toContain("schema error");
      }
    });

    it("silently skips invalid cwd config (not explicit flag)", async () => {
      const deps = makeFilesystem({
        "/tmp/jellyclaw.json": INVALID_JSON,
        "/home/test/.jellyclaw/jellyclaw.json": VALID_CONFIG,
      });
      const result = await loadMcpConfigs({ cwd: "/tmp" }, deps);
      // Should fall back to home config
      expect(result).toHaveLength(1);
      expect(result[0]?.name).toBe("echo");
    });
  });

  describe("empty mcp array", () => {
    it("returns empty array when .mcp[] is empty", async () => {
      const deps = makeFilesystem({
        "/tmp/jellyclaw.json": EMPTY_MCP_CONFIG,
      });
      const result = await loadMcpConfigs({ cwd: "/tmp" }, deps);
      expect(result).toEqual([]);
    });
  });

  describe("disabled servers", () => {
    it("skips servers with enabled: false", async () => {
      const deps = makeFilesystem({
        "/tmp/jellyclaw.json": VALID_CONFIG_DISABLED,
      });
      const result = await loadMcpConfigs({ cwd: "/tmp" }, deps);
      expect(result).toEqual([]);
    });

    it("skips servers with _disabled: true", async () => {
      const deps = makeFilesystem({
        "/tmp/jellyclaw.json": VALID_CONFIG_UNDERSCORE_DISABLED,
      });
      const result = await loadMcpConfigs({ cwd: "/tmp" }, deps);
      expect(result).toEqual([]);
    });
  });

  describe("configDir override", () => {
    it("uses configDir instead of home when provided", async () => {
      const deps = makeFilesystem({
        "/custom-config/jellyclaw.json": VALID_CONFIG,
      });
      const result = await loadMcpConfigs({ cwd: "/tmp", configDir: "/custom-config" }, deps);
      expect(result).toHaveLength(1);
      expect(result[0]?.name).toBe("echo");
    });
  });

  describe("_requires_env gate", () => {
    it("skips entry when required env var is missing", async () => {
      // Ensure env var is unset
      const orig = process.env.TEST_MCP_MISSING_VAR;
      delete process.env.TEST_MCP_MISSING_VAR;

      const deps = makeFilesystem({
        "/tmp/jellyclaw.json": JSON.stringify({
          provider: { type: "anthropic" },
          mcp: [
            {
              _requires_env: ["TEST_MCP_MISSING_VAR"],
              transport: "http",
              name: "gated-server",
              url: "https://example.com/mcp",
              headers: {},
            },
          ],
        }),
      });

      const result = await loadMcpConfigs({ cwd: "/tmp" }, deps);
      expect(result).toHaveLength(0);

      // Restore
      if (orig !== undefined) process.env.TEST_MCP_MISSING_VAR = orig;
    });

    it("includes entry when required env var is set", async () => {
      const orig = process.env.TEST_MCP_REQUIRED_VAR;
      process.env.TEST_MCP_REQUIRED_VAR = "present";

      const deps = makeFilesystem({
        "/tmp/jellyclaw.json": JSON.stringify({
          provider: { type: "anthropic" },
          mcp: [
            {
              _requires_env: ["TEST_MCP_REQUIRED_VAR"],
              transport: "http",
              name: "gated-server",
              url: "https://example.com/mcp",
              headers: {},
            },
          ],
        }),
      });

      const result = await loadMcpConfigs({ cwd: "/tmp" }, deps);
      expect(result).toHaveLength(1);
      expect(result[0]?.name).toBe("gated-server");

      // Restore
      if (orig === undefined) delete process.env.TEST_MCP_REQUIRED_VAR;
      else process.env.TEST_MCP_REQUIRED_VAR = orig;
    });
  });

  describe("env var expansion in headers", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional ${VAR} syntax
    it("expands ${VAR} placeholders in header values", async () => {
      const orig = process.env.TEST_MCP_API_KEY;
      process.env.TEST_MCP_API_KEY = "secret-key-123";

      const deps = makeFilesystem({
        "/tmp/jellyclaw.json": JSON.stringify({
          provider: { type: "anthropic" },
          mcp: [
            {
              transport: "http",
              name: "http-server",
              url: "https://example.com/mcp",
              // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional ${VAR} syntax for env expansion test
              headers: { Authorization: "Bearer ${TEST_MCP_API_KEY}" },
            },
          ],
        }),
      });

      const result = await loadMcpConfigs({ cwd: "/tmp" }, deps);
      expect(result).toHaveLength(1);
      const server = result[0];
      if (server?.transport === "http") {
        expect(server.headers?.Authorization).toBe("Bearer secret-key-123");
      } else {
        throw new Error("Expected http transport");
      }

      // Restore
      if (orig === undefined) delete process.env.TEST_MCP_API_KEY;
      else process.env.TEST_MCP_API_KEY = orig;
    });

    it("expands missing env vars to empty string", async () => {
      const orig = process.env.TEST_MCP_NONEXISTENT;
      delete process.env.TEST_MCP_NONEXISTENT;

      const deps = makeFilesystem({
        "/tmp/jellyclaw.json": JSON.stringify({
          provider: { type: "anthropic" },
          mcp: [
            {
              transport: "http",
              name: "http-server",
              url: "https://example.com/mcp",
              // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional ${VAR} syntax for env expansion test
              headers: { Authorization: "Bearer ${TEST_MCP_NONEXISTENT}" },
            },
          ],
        }),
      });

      const result = await loadMcpConfigs({ cwd: "/tmp" }, deps);
      expect(result).toHaveLength(1);
      const server = result[0];
      if (server?.transport === "http") {
        expect(server.headers?.Authorization).toBe("Bearer ");
      } else {
        throw new Error("Expected http transport");
      }

      // Restore
      if (orig !== undefined) process.env.TEST_MCP_NONEXISTENT = orig;
    });

    // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional ${VAR:-default} syntax
    it("expands ${VAR:-default} to default when VAR is unset", async () => {
      const orig = process.env.TEST_MCP_OPTIONAL_VAR;
      delete process.env.TEST_MCP_OPTIONAL_VAR;

      const deps = makeFilesystem({
        "/tmp/jellyclaw.json": JSON.stringify({
          provider: { type: "anthropic" },
          mcp: [
            {
              transport: "http",
              name: "http-server",
              url: "https://example.com/mcp",
              // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional ${VAR:-default} syntax for env expansion test
              headers: { "X-Context": "${TEST_MCP_OPTIONAL_VAR:-fallback_value}" },
            },
          ],
        }),
      });

      const result = await loadMcpConfigs({ cwd: "/tmp" }, deps);
      expect(result).toHaveLength(1);
      const server = result[0];
      if (server?.transport === "http") {
        expect(server.headers?.["X-Context"]).toBe("fallback_value");
      } else {
        throw new Error("Expected http transport");
      }

      // Restore
      if (orig !== undefined) process.env.TEST_MCP_OPTIONAL_VAR = orig;
    });

    // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional ${VAR:-default} syntax
    it("expands ${VAR:-default} to VAR value when VAR is set", async () => {
      const orig = process.env.TEST_MCP_SET_VAR;
      process.env.TEST_MCP_SET_VAR = "actual_value";

      const deps = makeFilesystem({
        "/tmp/jellyclaw.json": JSON.stringify({
          provider: { type: "anthropic" },
          mcp: [
            {
              transport: "http",
              name: "http-server",
              url: "https://example.com/mcp",
              // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional ${VAR:-default} syntax for env expansion test
              headers: { "X-Context": "${TEST_MCP_SET_VAR:-fallback_value}" },
            },
          ],
        }),
      });

      const result = await loadMcpConfigs({ cwd: "/tmp" }, deps);
      expect(result).toHaveLength(1);
      const server = result[0];
      if (server?.transport === "http") {
        expect(server.headers?.["X-Context"]).toBe("actual_value");
      } else {
        throw new Error("Expected http transport");
      }

      // Restore
      if (orig === undefined) delete process.env.TEST_MCP_SET_VAR;
      else process.env.TEST_MCP_SET_VAR = orig;
    });

    // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional ${VAR:-} syntax
    it("expands ${VAR:-} to empty string when VAR is unset (no default)", async () => {
      const orig = process.env.TEST_MCP_EMPTY_DEFAULT;
      delete process.env.TEST_MCP_EMPTY_DEFAULT;

      const deps = makeFilesystem({
        "/tmp/jellyclaw.json": JSON.stringify({
          provider: { type: "anthropic" },
          mcp: [
            {
              transport: "http",
              name: "http-server",
              url: "https://example.com/mcp",
              // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional ${VAR:-} syntax for env expansion test
              headers: { "X-Context-Id": "${TEST_MCP_EMPTY_DEFAULT:-}" },
            },
          ],
        }),
      });

      const result = await loadMcpConfigs({ cwd: "/tmp" }, deps);
      expect(result).toHaveLength(1);
      const server = result[0];
      if (server?.transport === "http") {
        expect(server.headers?.["X-Context-Id"]).toBe("");
      } else {
        throw new Error("Expected http transport");
      }

      // Restore
      if (orig !== undefined) process.env.TEST_MCP_EMPTY_DEFAULT = orig;
    });

    // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional ${VAR:-default} syntax
    it("treats empty string VAR as unset for ${VAR:-default} (Bash semantics)", async () => {
      const orig = process.env.TEST_MCP_EMPTY_STRING;
      process.env.TEST_MCP_EMPTY_STRING = "";

      const deps = makeFilesystem({
        "/tmp/jellyclaw.json": JSON.stringify({
          provider: { type: "anthropic" },
          mcp: [
            {
              transport: "http",
              name: "http-server",
              url: "https://example.com/mcp",
              // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional ${VAR:-default} syntax for env expansion test
              headers: { "X-Context": "${TEST_MCP_EMPTY_STRING:-use_default}" },
            },
          ],
        }),
      });

      const result = await loadMcpConfigs({ cwd: "/tmp" }, deps);
      expect(result).toHaveLength(1);
      const server = result[0];
      if (server?.transport === "http") {
        // Bash semantics: empty string is treated as unset for :-
        expect(server.headers?.["X-Context"]).toBe("use_default");
      } else {
        throw new Error("Expected http transport");
      }

      // Restore
      if (orig === undefined) delete process.env.TEST_MCP_EMPTY_STRING;
      else process.env.TEST_MCP_EMPTY_STRING = orig;
    });
  });
});
