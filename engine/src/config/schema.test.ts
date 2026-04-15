import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertCachingGate,
  assertCredentials,
  CachingGateError,
  ConfigParseError,
  loadConfig,
  MissingCredentialError,
  resolveApiKey,
} from "./loader.js";
import { Config, defaultConfig, parseConfig } from "./schema.js";

describe("schema", () => {
  it("defaults populate when given empty input", () => {
    const c = parseConfig({});
    expect(c.provider).toBe("anthropic");
    expect(c.model).toBe("claude-sonnet-4-6");
    expect(c.cache.enabled).toBe(true);
    expect(c.cache.skillsTopN).toBe(12);
    expect(c.cache.systemTTL).toBe("1h");
    expect(c.server.host).toBe("127.0.0.1");
    expect(c.server.portRange).toEqual([49152, 65535]);
    expect(c.telemetry.enabled).toBe(false);
    expect(c.acknowledgeCachingLimits).toBe(false);
    expect(c.openrouter.baseURL).toBe("https://openrouter.ai/api/v1");
    // Phase 08.03 blocks: defaults populate.
    expect(c.rateLimits.strict).toBe(false);
    expect(c.rateLimits.maxWaitMs).toBe(5_000);
    expect(c.rateLimits.browser).toBeUndefined();
    expect(c.secrets.patterns).toEqual([]);
    expect(c.secrets.minLength).toBe(8);
    expect(c.secrets.fast).toBe(false);
  });

  it("rateLimits block accepts per-domain bucket spec", () => {
    const c = parseConfig({
      rateLimits: {
        browser: {
          default: { capacity: 5, refillPerSecond: 1 },
          perDomain: { "example.com": { capacity: 10, refillPerSecond: 2 } },
        },
        strict: true,
      },
    });
    expect(c.rateLimits.browser?.default?.capacity).toBe(5);
    expect(c.rateLimits.browser?.perDomain["example.com"]?.refillPerSecond).toBe(2);
    expect(c.rateLimits.strict).toBe(true);
  });

  it("rateLimits rejects zero/negative capacity and maxWaitMs > 60s", () => {
    expect(() =>
      parseConfig({ rateLimits: { browser: { default: { capacity: 0, refillPerSecond: 1 } } } }),
    ).toThrow();
    expect(() => parseConfig({ rateLimits: { maxWaitMs: 60_001 } })).toThrow();
  });

  it("secrets block rejects non-snake_case pattern names", () => {
    expect(() =>
      parseConfig({ secrets: { patterns: [{ name: "MyCorpKey", regex: "MYCORP[A-Z0-9]+" }] } }),
    ).toThrow();
  });

  it("secrets block accepts well-formed user patterns", () => {
    const c = parseConfig({
      secrets: { patterns: [{ name: "mycorp_key", regex: "MYCORP[A-Z0-9]{16,}" }] },
    });
    expect(c.secrets.patterns).toHaveLength(1);
    expect(c.secrets.patterns[0]?.name).toBe("mycorp_key");
  });

  it("rejects unknown provider enum value", () => {
    expect(() => parseConfig({ provider: "groq" })).toThrow();
  });

  it("rejects non-127.0.0.1 server.host", () => {
    expect(() => parseConfig({ server: { host: "0.0.0.0" } })).toThrow();
  });

  it("rejects skillsTopN above 64", () => {
    expect(() => parseConfig({ cache: { skillsTopN: 9999 } })).toThrow();
  });

  it("accepts a minimal valid user config", () => {
    const c = Config.parse({
      provider: "anthropic",
      model: "claude-opus-4-6",
      anthropic: { apiKey: "sk-ant-test" },
    });
    expect(c.anthropic.apiKey).toBe("sk-ant-test");
    expect(c.model).toBe("claude-opus-4-6");
  });

  it("defaultConfig returns a fully-valid Config", () => {
    const c = defaultConfig();
    expect(Config.safeParse(c).success).toBe(true);
  });
});

describe("permissions block (Phase 08)", () => {
  it("defaults to mode=default with empty arrays and empty mcpTools", () => {
    const c = parseConfig({});
    expect(c.permissions.mode).toBe("default");
    expect(c.permissions.allow).toEqual([]);
    expect(c.permissions.deny).toEqual([]);
    expect(c.permissions.ask).toEqual([]);
    expect(c.permissions.mcpTools).toEqual({});
  });

  it("round-trips mode=plan", () => {
    const c = parseConfig({ permissions: { mode: "plan" } });
    expect(c.permissions.mode).toBe("plan");
    expect(c.permissions.allow).toEqual([]);
  });

  it("round-trips a rich block", () => {
    const c = parseConfig({
      permissions: {
        mode: "acceptEdits",
        allow: ["Bash(git status)"],
        deny: ["Bash(rm *)"],
        ask: ["Write(src/**)"],
        mcpTools: { mcp__github__get_issue: "readonly" },
      },
    });
    expect(c.permissions.mode).toBe("acceptEdits");
    expect(c.permissions.allow).toEqual(["Bash(git status)"]);
    expect(c.permissions.deny).toEqual(["Bash(rm *)"]);
    expect(c.permissions.ask).toEqual(["Write(src/**)"]);
    expect(c.permissions.mcpTools).toEqual({ mcp__github__get_issue: "readonly" });
  });

  it("rejects an unknown mode", () => {
    expect(() => parseConfig({ permissions: { mode: "yolo" } })).toThrow();
  });

  it("rejects a non-readonly mcpTools value", () => {
    expect(() => parseConfig({ permissions: { mcpTools: { mcp__x__y: "readwrite" } } })).toThrow();
  });
});

describe("hooks block (Phase 08.02)", () => {
  it("defaults to an empty array", () => {
    const c = parseConfig({});
    expect(c.hooks).toEqual([]);
  });

  it("round-trips a valid hook entry", () => {
    const hook = {
      event: "PreToolUse" as const,
      matcher: "Bash(*)",
      command: "/usr/local/bin/guard",
      args: ["--strict"],
      timeout: 5000,
      blocking: true,
      name: "bash-guard",
      env: { LEVEL: "debug" },
    };
    const c = parseConfig({ hooks: [hook] });
    expect(c.hooks).toHaveLength(1);
    expect(c.hooks[0]).toEqual(hook);
  });

  it("accepts a minimal hook entry (event + command only)", () => {
    const c = parseConfig({
      hooks: [{ event: "Stop", command: "echo" }],
    });
    expect(c.hooks[0]).toEqual({ event: "Stop", command: "echo" });
  });

  it("rejects an unknown event name", () => {
    expect(() => parseConfig({ hooks: [{ event: "WatThis", command: "echo" }] })).toThrow();
  });

  it("rejects timeout over the 120_000 ms cap", () => {
    expect(() =>
      parseConfig({
        hooks: [{ event: "PreToolUse", command: "echo", timeout: 500_000 }],
      }),
    ).toThrow();
  });

  it("rejects zero / negative timeout", () => {
    expect(() =>
      parseConfig({ hooks: [{ event: "PreToolUse", command: "echo", timeout: 0 }] }),
    ).toThrow();
    expect(() =>
      parseConfig({ hooks: [{ event: "PreToolUse", command: "echo", timeout: -1 }] }),
    ).toThrow();
  });

  it("rejects empty command", () => {
    expect(() => parseConfig({ hooks: [{ event: "PreToolUse", command: "" }] })).toThrow();
  });
});

describe("assertCredentials", () => {
  it("passes when anthropic.apiKey is set in config", () => {
    const c = parseConfig({ provider: "anthropic", anthropic: { apiKey: "sk-ant-x" } });
    expect(() => assertCredentials(c, {})).not.toThrow();
  });

  it("passes when ANTHROPIC_API_KEY env is set", () => {
    const c = parseConfig({ provider: "anthropic" });
    expect(() => assertCredentials(c, { ANTHROPIC_API_KEY: "sk-ant-env" })).not.toThrow();
  });

  it("throws MissingCredentialError when neither env nor config has a key", () => {
    const c = parseConfig({ provider: "anthropic" });
    expect(() => assertCredentials(c, {})).toThrow(MissingCredentialError);
  });

  it("throws distinct error for openrouter", () => {
    const c = parseConfig({ provider: "openrouter", acknowledgeCachingLimits: true });
    try {
      assertCredentials(c, {});
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(MissingCredentialError);
      expect((e as MissingCredentialError).provider).toBe("openrouter");
    }
  });
});

describe("resolveApiKey", () => {
  it("config value wins over env", () => {
    const c = parseConfig({ provider: "anthropic", anthropic: { apiKey: "sk-cfg" } });
    expect(resolveApiKey(c, { ANTHROPIC_API_KEY: "sk-env" })).toBe("sk-cfg");
  });
  it("falls back to env when config missing", () => {
    const c = parseConfig({ provider: "anthropic" });
    expect(resolveApiKey(c, { ANTHROPIC_API_KEY: "sk-env" })).toBe("sk-env");
  });
  it("throws when neither", () => {
    const c = parseConfig({ provider: "anthropic" });
    expect(() => resolveApiKey(c, {})).toThrow(MissingCredentialError);
  });
});

describe("assertCachingGate (research-notes §10)", () => {
  it("allows anthropic provider with any model", () => {
    const c = parseConfig({ provider: "anthropic", model: "claude-opus-4-6" });
    expect(() => assertCachingGate(c)).not.toThrow();
  });
  it("allows openrouter with non-anthropic model regardless of gate", () => {
    const c = parseConfig({
      provider: "openrouter",
      model: "qwen/qwen3-coder",
    });
    expect(() => assertCachingGate(c)).not.toThrow();
  });
  it("blocks openrouter + anthropic/* when gate is false", () => {
    const c = parseConfig({
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4.6",
    });
    expect(() => assertCachingGate(c)).toThrow(CachingGateError);
  });
  it("blocks openrouter + bare 'claude-*' model when gate is false", () => {
    const c = parseConfig({
      provider: "openrouter",
      model: "claude-opus-4-6",
    });
    expect(() => assertCachingGate(c)).toThrow(CachingGateError);
  });
  it("allows openrouter + anthropic model when gate is flipped", () => {
    const c = parseConfig({
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4.6",
      acknowledgeCachingLimits: true,
    });
    expect(() => assertCachingGate(c)).not.toThrow();
  });
});

describe("loadConfig — precedence", () => {
  let tmp: string;
  let cwd: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "jc-cfg-"));
    cwd = join(tmp, "project");
    mkdirSync(join(cwd, ".jellyclaw"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("defaults when no files, no env, no cli", () => {
    const c = loadConfig({ cwd, env: {} });
    expect(c.provider).toBe("anthropic");
    expect(c.model).toBe("claude-sonnet-4-6");
  });

  it("local file overrides defaults", () => {
    writeFileSync(
      join(cwd, ".jellyclaw/config.json"),
      JSON.stringify({ model: "claude-opus-4-6" }),
    );
    const c = loadConfig({ cwd, env: {} });
    expect(c.model).toBe("claude-opus-4-6");
  });

  it("env overrides local file", () => {
    writeFileSync(
      join(cwd, ".jellyclaw/config.json"),
      JSON.stringify({ model: "claude-opus-4-6" }),
    );
    const c = loadConfig({ cwd, env: { JELLYCLAW_MODEL: "claude-haiku-4-5" } });
    expect(c.model).toBe("claude-haiku-4-5");
  });

  it("cli overrides env", () => {
    const c = loadConfig({
      cwd,
      env: { JELLYCLAW_MODEL: "claude-haiku-4-5" },
      cli: { model: "claude-sonnet-4-6" },
    });
    expect(c.model).toBe("claude-sonnet-4-6");
  });

  it("ANTHROPIC_API_KEY env populates the anthropic block", () => {
    const c = loadConfig({ cwd, env: { ANTHROPIC_API_KEY: "sk-ant-xyz" } });
    expect(c.anthropic.apiKey).toBe("sk-ant-xyz");
  });

  it("malformed local JSON → ConfigParseError with path", () => {
    writeFileSync(join(cwd, ".jellyclaw/config.json"), "{ not json");
    expect(() => loadConfig({ cwd, env: {} })).toThrow(ConfigParseError);
  });
});
