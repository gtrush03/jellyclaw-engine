/**
 * @jellyclaw/engine — public library API.
 *
 * The two entry points every consumer uses:
 *
 *   createEngine(config)  — construct a long-lived engine with providers, MCP, permissions.
 *   run({wish, engine})   — one-shot: dispatch a wish and return an async event stream.
 *
 * Everything else exported here is for type narrowing and advanced cases.
 */

import { randomUUID } from "node:crypto";
import { defaultConfig, type JellyclawConfig, loadConfigFromFile, parseConfig } from "./config.js";
import type { AgentEvent } from "./events.js";
import { createLogger, type Logger } from "./logger.js";
import { AnthropicProvider } from "./providers/anthropic.js";
import { OpenRouterProvider } from "./providers/openrouter.js";

// Phase 01 — bootstrap + plugin controls (opencode-ai ships compiled; these
// live jellyclaw-side per patches/README.md).
export {
  BindViolationError,
  OpenCodeExitError,
  type OpenCodeHandle,
  OpenCodeStartTimeoutError,
  OpenCodeVersionError,
  PortRangeError,
  type StartOpenCodeOptions,
  startOpenCode,
} from "./bootstrap/opencode-server.js";
export * from "./config.js";
export * from "./events.js";
export type { Logger } from "./logger.js";
export { createLogger } from "./logger.js";
export {
  createCachedResolver,
  type EnrichedToolHookEnvelope,
  enrichHookEnvelope,
  MAX_AGENT_CHAIN_DEPTH,
  type SessionMetadata,
  type SessionResolver,
  type ToolHookEnvelope,
} from "./plugin/agent-context.js";
export {
  type ScrubOptions,
  type ScrubStats,
  scrubSecrets,
  scrubToolResult,
  scrubWithStats,
} from "./plugin/secret-scrub.js";
export { AnthropicProvider } from "./providers/anthropic.js";
export { OpenRouterProvider } from "./providers/openrouter.js";

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export type Provider = AnthropicProvider | OpenRouterProvider;

export interface Engine {
  readonly config: JellyclawConfig;
  readonly logger: Logger;
  readonly provider: Provider;
  /**
   * Lazy handle to the OpenCode SDK — Phase 1 wires this. Until then it throws.
   */
  opencode(): never;
}

export interface CreateEngineOptions {
  /** Inline config object. Takes priority over configPath. */
  config?: Partial<JellyclawConfig> | JellyclawConfig;
  /** Path to a jellyclaw.json file. */
  configPath?: string;
  /** Override the logger (tests, library consumers with their own logger). */
  logger?: Logger;
}

/**
 * Construct a jellyclaw engine. Async because config may be loaded from disk.
 */
export async function createEngine(options: CreateEngineOptions = {}): Promise<Engine> {
  const config = await resolveConfig(options);
  const logger =
    options.logger ?? createLogger({ level: config.logger.level, pretty: config.logger.pretty });

  const provider = makeProvider(config, logger);

  logger.info(
    { provider: provider.name, model: modelOf(config), telemetry: config.telemetry.enabled },
    "jellyclaw engine ready",
  );

  return {
    config,
    logger,
    provider,
    opencode() {
      throw new Error("OpenCode client not wired yet (lands Phase 1)");
    },
  };
}

// ---------------------------------------------------------------------------
// run()
// ---------------------------------------------------------------------------

export interface RunOptions {
  wish: string;
  engine?: Engine;
  agent?: string;
  cwd?: string;
  sessionId?: string;
  /** Create an engine inline if one is not provided. */
  config?: CreateEngineOptions["config"];
  configPath?: CreateEngineOptions["configPath"];
}

/**
 * Dispatch a wish. Returns an async iterable of AgentEvent values.
 *
 * In Phase 0 this emits a synthetic session.started → agent.message → session.completed
 * sequence so the smoke test passes end-to-end. Phase 2+ replaces the body with the real
 * OpenCode-backed loop.
 */
export async function* run(options: RunOptions): AsyncGenerator<AgentEvent, void, void> {
  const engine =
    options.engine ??
    (await createEngine({
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

  // -- Phase 0 stub: echo the wish back as a single agent.message ----------
  // This is intentionally hollow. It exists so `./dist/cli.js run "hello"` works
  // end-to-end from Day 1 and so every downstream consumer can wire up their
  // event handling before the real engine loop exists.
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

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

async function resolveConfig(options: CreateEngineOptions): Promise<JellyclawConfig> {
  if (options.config) {
    // Allow partials for ergonomic inline construction.
    return parseConfig({ provider: { type: "anthropic" }, ...options.config });
  }
  if (options.configPath) {
    return loadConfigFromFile(options.configPath);
  }
  // Try ./jellyclaw.json in cwd, silently fall back to defaults.
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
      // Phase 0 stub path: run() never actually calls provider.stream().
      // We deliberately construct even without an API key so the phase-0
      // smoke test keeps working. The provider's stream() call will fail
      // at request time if the key is missing. Phase 10 replaces this glue.
      const apiKey = config.provider.apiKey ?? process.env.ANTHROPIC_API_KEY ?? "missing";
      return new AnthropicProvider({
        apiKey,
        ...(config.provider.baseURL !== undefined ? { baseURL: config.provider.baseURL } : {}),
        logger,
      });
    }
    case "openrouter": {
      // Phase 0 stub path: see the anthropic arm above. Constructs even
      // without a real key so run()'s stub keeps working.
      const apiKey = config.provider.apiKey ?? process.env.OPENROUTER_API_KEY ?? "missing";
      return new OpenRouterProvider({
        apiKey,
        ...(config.provider.baseURL !== undefined ? { baseURL: config.provider.baseURL } : {}),
        logger,
      });
    }
  }
}

function modelOf(config: JellyclawConfig): string {
  return config.provider.defaultModel;
}
