/**
 * `jellyclaw config show` / `config check` — Phase 10.01.
 *
 * `show` prints the effective merged config as pretty JSON. Secrets are
 * redacted by default (opt out with `--no-redact`). Redaction walks the
 * object and replaces known secret-bearing field names (apiKey, authToken,
 * password, secret, and the values of MCP `env` / `headers` blocks) with
 * the literal string "[REDACTED]". We do NOT delegate to
 * `plugin/secret-scrub.ts` for this path — that scrubber is pattern-based
 * (matches sk-…, JWTs, etc. in tool output) and would leave a plain config
 * `apiKey: "my-key"` intact.
 *
 * `check` compiles the permission rules via `compilePermissions` from
 * `engine/src/permissions/rules.ts` and collects the resulting warnings.
 * It also lints the MCP block (duplicate server names, and transport /
 * fields mismatch — stdio expects `command`, http/sse expect `url`).
 *
 * No `process.exit` here — actions return numeric exit codes and the
 * caller in `main.ts` maps them.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  defaultConfig,
  type JellyclawConfig,
  loadConfigFromFile,
  type McpServerConfig,
} from "../config.js";
import { compilePermissions } from "../permissions/rules.js";

// ---------------------------------------------------------------------------
// Config resolution (mirror of engine/src/index.ts resolveConfig, minus
// programmatic override because the CLI has no `options.config` path).
// ---------------------------------------------------------------------------

export interface ConfigDeps {
  readonly cwd?: string;
  readonly loadFromFile?: (path: string) => Promise<JellyclawConfig>;
  readonly defaults?: () => JellyclawConfig;
  readonly stdout?: NodeJS.WritableStream;
  readonly stderr?: NodeJS.WritableStream;
  readonly fileExists?: (path: string) => boolean;
}

function resolveEffectiveConfig(
  opts: { configPath?: string | undefined } | undefined,
  deps: ConfigDeps,
): Promise<JellyclawConfig> {
  const loadFromFile = deps.loadFromFile ?? loadConfigFromFile;
  const defaults = deps.defaults ?? defaultConfig;
  const exists = deps.fileExists ?? existsSync;
  if (opts?.configPath) {
    return loadFromFile(opts.configPath);
  }
  const cwd = deps.cwd ?? process.cwd();
  const local = resolve(cwd, "jellyclaw.json");
  if (exists(local)) {
    return loadFromFile(local);
  }
  return Promise.resolve(defaults());
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

const REDACTED = "[REDACTED]";

/**
 * Field names whose scalar values must be redacted wherever they appear.
 * Kept narrow on purpose: we would rather miss a custom field than mangle
 * a harmless one. New secret-bearing fields get added here in the same
 * commit that introduces them (mirrors logger.ts DEFAULT_REDACT policy).
 */
const SECRET_FIELDS: ReadonlySet<string> = new Set([
  "apiKey",
  "api_key",
  "authToken",
  "auth_token",
  "password",
  "secret",
  "token",
  "ANTHROPIC_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENCODE_SERVER_PASSWORD",
]);

/**
 * Field names whose value is a `Record<string, string>` where every value
 * should be redacted (MCP `env` and `headers`).
 */
const SECRET_MAP_FIELDS: ReadonlySet<string> = new Set(["env", "headers"]);

function redactValue(value: unknown, keyName?: string): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") {
    if (keyName !== undefined && SECRET_FIELDS.has(keyName) && typeof value === "string") {
      return REDACTED;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item));
  }
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(src)) {
    const raw = src[key];
    if (SECRET_FIELDS.has(key) && typeof raw === "string") {
      out[key] = REDACTED;
      continue;
    }
    if (
      SECRET_MAP_FIELDS.has(key) &&
      raw !== null &&
      typeof raw === "object" &&
      !Array.isArray(raw)
    ) {
      const mapOut: Record<string, string> = {};
      for (const mk of Object.keys(raw as Record<string, unknown>)) {
        mapOut[mk] = REDACTED;
      }
      out[key] = mapOut;
      continue;
    }
    out[key] = redactValue(raw, key);
  }
  return out;
}

export function redactConfig(config: JellyclawConfig): unknown {
  return redactValue(config);
}

// ---------------------------------------------------------------------------
// `config show`
// ---------------------------------------------------------------------------

export interface ConfigShowOptions {
  readonly redact?: boolean;
  readonly configPath?: string;
}

export async function configShowAction(
  opts: ConfigShowOptions = {},
  deps: ConfigDeps = {},
): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const redact = opts.redact ?? true;

  let config: JellyclawConfig;
  try {
    config = await resolveEffectiveConfig({ configPath: opts.configPath }, deps);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    stderr.write(`config show: ${message}\n`);
    return 1;
  }

  const out = redact ? redactConfig(config) : (config as unknown);
  stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// `config check`
// ---------------------------------------------------------------------------

export interface ConfigCheckOptions {
  readonly configPath?: string;
}

interface LintWarning {
  readonly location: string;
  readonly message: string;
}

function lintMcp(servers: readonly McpServerConfig[]): LintWarning[] {
  const out: LintWarning[] = [];
  const seen = new Map<string, number>();

  for (let i = 0; i < servers.length; i++) {
    const srv = servers[i];
    if (!srv) continue;
    const prev = seen.get(srv.name);
    if (prev !== undefined) {
      out.push({
        location: `mcp[${i}] ${srv.name}`,
        message: `duplicate server name (also defined at mcp[${prev}])`,
      });
    } else {
      seen.set(srv.name, i);
    }

    // Transport-to-field consistency. The Zod schema already enforces the
    // discriminant, but a config that somehow sneaks in (e.g. via partial
    // merge) with `transport:"stdio"` but a stray `url` field wouldn't be
    // caught. We re-check defensively.
    if (srv.transport === "stdio") {
      if (!srv.command || srv.command.length === 0) {
        out.push({
          location: `mcp[${i}] ${srv.name}`,
          message: "stdio transport requires non-empty 'command'",
        });
      }
    } else if (srv.transport === "http" || srv.transport === "sse") {
      if (!srv.url || srv.url.length === 0) {
        out.push({
          location: `mcp[${i}] ${srv.name}`,
          message: `${srv.transport} transport requires non-empty 'url'`,
        });
      }
    }
  }
  return out;
}

export async function configCheckAction(
  opts: ConfigCheckOptions = {},
  deps: ConfigDeps = {},
): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;

  let config: JellyclawConfig;
  try {
    config = await resolveEffectiveConfig({ configPath: opts.configPath }, deps);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    stderr.write(`config check: ${message}\n`);
    return 1;
  }

  const warnings: LintWarning[] = [];

  // Permissions — compile and surface the parser warnings.
  const compiled = compilePermissions({
    allow: config.permissions.allow,
    ask: [],
    deny: config.permissions.deny,
  });
  for (const w of compiled.warnings) {
    warnings.push({
      location: `permissions.${w.ruleClass} '${w.source}'`,
      message: w.reason,
    });
  }

  // MCP — duplicates + transport/field consistency.
  warnings.push(...lintMcp(config.mcp));

  for (const w of warnings) {
    stdout.write(`⚠ ${w.location}: ${w.message}\n`);
  }

  return warnings.length === 0 ? 0 : 1;
}
