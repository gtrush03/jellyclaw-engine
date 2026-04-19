/**
 * Legacy `run()` async-generator — the Phase-0 stub.
 *
 * Kept intact here so the CLI (`cli.ts`, `cli/run.ts`) and the HTTP
 * run-manager (`server/run-manager.ts`) keep working while Agent A lands the
 * real `Engine.run()` in `engine.ts` + `run-handle.ts`.
 *
 * Exposed ONLY via `@jellyclaw/engine/internal` — new code should use
 * `createEngine()` from the public barrel.
 *
 * @deprecated — prefer `createEngine().run(input)`.
 */

import { randomUUID } from "node:crypto";
import { defaultConfig, type JellyclawConfig, loadConfigFromFile, parseConfig } from "./config.js";
import type { AgentEvent } from "./events.js";
import { createLogger, type Logger } from "./logger.js";
import { AnthropicProvider } from "./providers/anthropic.js";
import { OpenRouterProvider } from "./providers/openrouter.js";

type Provider = AnthropicProvider | OpenRouterProvider;

interface LegacyEngine {
  readonly config: JellyclawConfig;
  readonly logger: Logger;
  readonly provider: Provider;
}

interface LegacyCreateEngineOptions {
  config?: Partial<JellyclawConfig> | JellyclawConfig;
  configPath?: string;
  logger?: Logger;
}

/**
 * @deprecated — legacy options shape for the Phase-0 `run()` generator.
 *              Use `RunInput` from the public barrel with `createEngine()`.
 */
export interface RunOptions {
  wish: string;
  engine?: LegacyEngine;
  agent?: string;
  cwd?: string;
  sessionId?: string;
  config?: LegacyCreateEngineOptions["config"];
  configPath?: LegacyCreateEngineOptions["configPath"];
  /** Maximum tool-use turns. Defaults to DEFAULT_MAX_TURNS (50) if unset. */
  maxTurns?: number;
  /** Maximum cumulative cost in USD. When exceeded, the loop aborts with max_cost_usd_exceeded. */
  maxCostUsd?: number;
  /** Permission mode override from CLI --permission-mode flag (T2-05). */
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan";
  /** Prior messages for session resumption (T2-07). Prepended to conversation history. */
  priorMessages?: ReadonlyArray<{ role: "user" | "assistant"; content: string }>;
  /** Session ID to resume (T2-07). When provided, loads prior transcript. */
  resume?: string;
  /** Continue from the latest session for the current project (T2-08). */
  continue?: boolean;
  /** Tool names to allow (T2-09). When set, only these tools are enabled. Supports wildcards like `mcp__*`. */
  allowedTools?: readonly string[];
  /** Tool names to deny (T2-09). These tools are disabled. Supports wildcards like `mcp__github__*`. */
  disallowedTools?: readonly string[];
  /** Append to the system prompt (T2-10). Added after soul and skill injection. */
  appendSystemPrompt?: string;
  /** Additional allowed directories (T2-10). Path tools can access these in addition to cwd. */
  addDir?: readonly string[];
  /** Explicit MCP config file path (T0-01). Overrides cwd/home configs. */
  mcpConfig?: string;
  /** Config directory override (T0-01). Defaults to ~/.jellyclaw. */
  configDir?: string;
}

async function resolveConfig(options: LegacyCreateEngineOptions): Promise<JellyclawConfig> {
  if (options.config) {
    return parseConfig({ provider: { type: "anthropic" }, ...options.config });
  }
  if (options.configPath) {
    return loadConfigFromFile(options.configPath);
  }
  const { existsSync } = await import("node:fs");
  const local = `${process.cwd()}/jellyclaw.json`;
  if (existsSync(local)) {
    return loadConfigFromFile(local);
  }
  return defaultConfig();
}

function makeProvider(config: JellyclawConfig, logger: Logger): Provider {
  switch (config.provider.type) {
    case "anthropic": {
      const apiKey = config.provider.apiKey ?? process.env.ANTHROPIC_API_KEY ?? "missing";
      return new AnthropicProvider({
        apiKey,
        ...(config.provider.baseURL !== undefined ? { baseURL: config.provider.baseURL } : {}),
        logger,
      });
    }
    case "openrouter": {
      const apiKey = config.provider.apiKey ?? process.env.OPENROUTER_API_KEY ?? "missing";
      return new OpenRouterProvider({
        apiKey,
        ...(config.provider.baseURL !== undefined ? { baseURL: config.provider.baseURL } : {}),
        logger,
      });
    }
  }
}

async function buildLegacyEngine(options: LegacyCreateEngineOptions): Promise<LegacyEngine> {
  const config = await resolveConfig(options);
  const logger =
    options.logger ?? createLogger({ level: config.logger.level, pretty: config.logger.pretty });
  const provider = makeProvider(config, logger);
  return { config, logger, provider };
}

function modelOf(config: JellyclawConfig): string {
  return config.provider.defaultModel;
}

/**
 * @deprecated — Phase-0 stub. Emits a synthetic
 * `session.started` → `agent.message` → `usage.updated` → `session.completed`
 * sequence. Use `createEngine().run(input)` once Agent A lands the real
 * engine loop.
 */
export async function* run(options: RunOptions): AsyncGenerator<AgentEvent, void, void> {
  const engine =
    options.engine ??
    (await buildLegacyEngine({
      ...(options.config !== undefined ? { config: options.config } : {}),
      ...(options.configPath !== undefined ? { configPath: options.configPath } : {}),
    }));

  const session_id = options.sessionId ?? randomUUID();
  const cwd = options.cwd ?? process.cwd();
  const agent = options.agent ?? "default";
  const t0 = Date.now();
  let seq = 0;

  engine.logger.info({ session_id, wish: options.wish, agent }, "session.started");

  yield {
    type: "session.started",
    session_id,
    ts: t0,
    seq: seq++,
    wish: options.wish,
    agent,
    model: modelOf(engine.config),
    provider: engine.provider.name,
    cwd,
  };

  yield {
    type: "agent.message",
    session_id,
    ts: Date.now(),
    seq: seq++,
    delta: `[phase-0 stub] received wish: ${options.wish}\n`,
    final: true,
  };

  yield {
    type: "usage.updated",
    session_id,
    ts: Date.now(),
    seq: seq++,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
  };

  const t1 = Date.now();
  yield {
    type: "session.completed",
    session_id,
    ts: t1,
    seq: seq++,
    summary: "phase-0 stub completion",
    turns: 1,
    duration_ms: t1 - t0,
  };

  engine.logger.info({ session_id, duration_ms: t1 - t0 }, "session.completed");
}
