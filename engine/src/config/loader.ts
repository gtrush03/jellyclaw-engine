/**
 * Config loader — merges defaults ← global ← local ← env ← CLI flags.
 *
 * Layering (first hit wins per key within a layer; later layers override):
 *   1. schema defaults (from Zod)
 *   2. `~/.jellyclaw/config.json` (global)
 *   3. `<cwd>/.jellyclaw/config.json` (local)
 *   4. env vars (ANTHROPIC_API_KEY, OPENROUTER_API_KEY, JELLYCLAW_MODEL, JELLYCLAW_PROVIDER, …)
 *   5. CLI flags (`{ provider?, model?, acknowledgeCachingLimits? }`)
 *
 * `assertCredentials()` is a separate step because zod cannot enforce the
 * "apiKey may come from config OR env" fallback inside a single field.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Logger } from "pino";
import { type Config, type Provider, parseConfig } from "./schema.js";

export class ConfigParseError extends Error {
  override readonly name = "ConfigParseError";
  constructor(
    readonly path: string,
    readonly cause_: unknown,
  ) {
    super(
      `Failed to parse config file '${path}': ${cause_ instanceof Error ? cause_.message : String(cause_)}`,
    );
  }
}

export class MissingCredentialError extends Error {
  override readonly name = "MissingCredentialError";
  constructor(readonly provider: Provider) {
    super(
      `Provider '${provider}' selected but no API key found. ` +
        `Set ${provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENROUTER_API_KEY"} ` +
        `env var or '${provider}.apiKey' in jellyclaw.json.`,
    );
  }
}

export interface CliOverrides {
  provider?: Provider;
  model?: string;
  acknowledgeCachingLimits?: boolean;
  configPath?: string;
}

export interface LoadConfigOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  cli?: CliOverrides;
  logger?: Logger;
}

const expand = (p: string): string => (p.startsWith("~") ? join(homedir(), p.slice(1)) : p);

function readJsonIfExists(path: string): unknown {
  if (!existsSync(path)) return undefined;
  const raw = readFileSync(path, "utf8");
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new ConfigParseError(path, err);
  }
}

interface DeepMergable {
  [key: string]: unknown;
}

function isPlainObject(v: unknown): v is DeepMergable {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function deepMerge(target: unknown, source: unknown): unknown {
  if (source === undefined) return target;
  if (!isPlainObject(target) || !isPlainObject(source)) return source;
  const out: DeepMergable = { ...target };
  for (const k of Object.keys(source)) {
    const s = source[k];
    if (s === undefined) continue;
    out[k] = isPlainObject(s) && isPlainObject(target[k]) ? deepMerge(target[k], s) : s;
  }
  return out;
}

function envOverlay(env: NodeJS.ProcessEnv): DeepMergable {
  const out: DeepMergable = {};
  const anthropic: DeepMergable = {};
  const openrouter: DeepMergable = {};

  if (env.JELLYCLAW_PROVIDER) out.provider = env.JELLYCLAW_PROVIDER;
  if (env.JELLYCLAW_MODEL) out.model = env.JELLYCLAW_MODEL;
  if (env.ANTHROPIC_API_KEY) anthropic.apiKey = env.ANTHROPIC_API_KEY;
  if (env.ANTHROPIC_BASE_URL) anthropic.baseURL = env.ANTHROPIC_BASE_URL;
  if (env.OPENROUTER_API_KEY) openrouter.apiKey = env.OPENROUTER_API_KEY;
  if (env.OPENROUTER_BASE_URL) openrouter.baseURL = env.OPENROUTER_BASE_URL;
  if (env.JELLYCLAW_ACKNOWLEDGE_CACHING_LIMITS === "1") {
    out.acknowledgeCachingLimits = true;
  }

  if (Object.keys(anthropic).length > 0) out.anthropic = anthropic;
  if (Object.keys(openrouter).length > 0) out.openrouter = openrouter;
  return out;
}

function cliOverlay(cli: CliOverrides | undefined): DeepMergable {
  if (!cli) return {};
  const out: DeepMergable = {};
  if (cli.provider) out.provider = cli.provider;
  if (cli.model) out.model = cli.model;
  if (cli.acknowledgeCachingLimits !== undefined) {
    out.acknowledgeCachingLimits = cli.acknowledgeCachingLimits;
  }
  return out;
}

/**
 * Load + merge + validate a `Config`. Does NOT check for credential presence;
 * use `assertCredentials(config)` for that.
 */
export function loadConfig(opts: LoadConfigOptions = {}): Config {
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;

  const globalPath = opts.cli?.configPath ?? expand("~/.jellyclaw/config.json");
  const localPath = resolve(cwd, ".jellyclaw/config.json");

  const globalJson = readJsonIfExists(globalPath) ?? {};
  const localJson = readJsonIfExists(localPath) ?? {};

  const merged = deepMerge(
    deepMerge(deepMerge(globalJson, localJson), envOverlay(env)),
    cliOverlay(opts.cli),
  );

  return parseConfig(merged ?? {});
}

/**
 * Ensures the active provider has a resolvable API key (config OR env).
 * Called by the engine bootstrap after `loadConfig`, before constructing
 * the provider. Keeps credential logic out of the Zod schema where it
 * would require a cross-field refinement the env isn't visible to.
 */
export function assertCredentials(config: Config, env: NodeJS.ProcessEnv = process.env): void {
  if (config.provider === "anthropic") {
    if (!config.anthropic.apiKey && !env.ANTHROPIC_API_KEY) {
      throw new MissingCredentialError("anthropic");
    }
  } else {
    if (!config.openrouter.apiKey && !env.OPENROUTER_API_KEY) {
      throw new MissingCredentialError("openrouter");
    }
  }
}

/**
 * Resolve the effective API key for the active provider. Config takes
 * precedence over env. Caller must have called `assertCredentials` first
 * (we still throw here as a belt-and-braces for mis-ordered call sites).
 */
export function resolveApiKey(config: Config, env: NodeJS.ProcessEnv = process.env): string {
  const key =
    config.provider === "anthropic"
      ? (config.anthropic.apiKey ?? env.ANTHROPIC_API_KEY)
      : (config.openrouter.apiKey ?? env.OPENROUTER_API_KEY);
  if (!key) throw new MissingCredentialError(config.provider);
  return key;
}

/**
 * Enforces the `acknowledgeCachingLimits` gate (research-notes §10).
 * Throws when the combination is forbidden. Safe to call unconditionally
 * at config-load time.
 */
export class CachingGateError extends Error {
  override readonly name = "CachingGateError";
  constructor(readonly model: string) {
    super(
      `Refusing to dispatch model '${model}' via OpenRouter without acknowledgeCachingLimits. ` +
        `Known regressions: cache_control stripped (issue #1245) and OAuth+cache_control=400 (issue #17910). ` +
        `Either use --provider anthropic OR set acknowledgeCachingLimits=true.`,
    );
  }
}

export function assertCachingGate(config: Config): void {
  if (config.provider !== "openrouter") return;
  const isAnthropicModel =
    config.model.startsWith("anthropic/") || /^claude[-_]/i.test(config.model);
  if (isAnthropicModel && !config.acknowledgeCachingLimits) {
    throw new CachingGateError(config.model);
  }
}
