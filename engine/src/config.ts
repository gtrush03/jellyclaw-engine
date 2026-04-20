/**
 * jellyclaw.json — user-facing config schema.
 *
 * Resolution order (first hit wins per key):
 *   1. explicit `configPath` argument to `createEngine()`
 *   2. `./jellyclaw.json` in cwd
 *   3. `~/.config/jellyclaw/config.json`
 *   4. defaults from this file
 *
 * Every field is optional. The schema documents defaults inline.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

export const ProviderName = z.enum(["anthropic", "openrouter"]);
export type ProviderName = z.infer<typeof ProviderName>;

export const AnthropicProviderConfig = z.object({
  type: z.literal("anthropic"),
  apiKey: z.string().optional(), // falls back to ANTHROPIC_API_KEY env
  baseURL: z.string().url().optional(),
  defaultModel: z.string().default("claude-opus-4-7"),
  cache: z
    .object({
      enabled: z.boolean().default(true),
      breakpoints: z
        .enum(["auto", "manual"])
        .default("auto")
        .describe("'auto' lets the provider decide where to place cache_control markers"),
    })
    .default({ enabled: true, breakpoints: "auto" }),
});

export const OpenRouterProviderConfig = z.object({
  type: z.literal("openrouter"),
  apiKey: z.string().optional(), // falls back to OPENROUTER_API_KEY env
  baseURL: z.string().url().default("https://openrouter.ai/api/v1"),
  defaultModel: z.string().default("anthropic/claude-opus-4.7"),
  acknowledgeCachingLimits: z
    .boolean()
    .default(false)
    .describe("Must be true to use OpenRouter. See providers/openrouter.ts for why."),
});

export type AnthropicProviderConfig = z.infer<typeof AnthropicProviderConfig>;
export type OpenRouterProviderConfig = z.infer<typeof OpenRouterProviderConfig>;

export const ProviderConfig = z.discriminatedUnion("type", [
  AnthropicProviderConfig,
  OpenRouterProviderConfig,
]);
export type ProviderConfig = z.infer<typeof ProviderConfig>;

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

export const PermissionPolicy = z.object({
  mode: z
    .enum(["strict", "ask", "allow"])
    .default("ask")
    .describe("'strict' denies everything not on allow-list; 'ask' prompts; 'allow' permits all"),
  allow: z.array(z.string()).default([]),
  deny: z.array(z.string()).default([]),
  allowedPaths: z.array(z.string()).default([]),
  deniedPaths: z
    .array(z.string())
    .default(["/etc/**", "/usr/**", "/System/**", "~/.ssh/**", "~/.aws/**"]),
});
export type PermissionPolicy = z.infer<typeof PermissionPolicy>;

// ---------------------------------------------------------------------------
// MCP servers
// ---------------------------------------------------------------------------

// MCP server name restricted to kebab (lowercase letters, digits,
// hyphen). Enforces the namespacing invariant — see mcp/namespacing.ts.
const MCP_SERVER_NAME_RE = /^[a-z0-9-]+$/;

const OAuthConfig = z.object({
  clientId: z.string(),
  scope: z.string().optional(),
  authorizeUrl: z.string().url().optional(),
  tokenUrl: z.string().url().optional(),
  callbackPort: z.number().int().min(1024).max(65535).optional(),
});
export type OAuthConfig = z.infer<typeof OAuthConfig>;

const StdioMcpServerConfig = z.object({
  transport: z.literal("stdio"),
  name: z.string().regex(MCP_SERVER_NAME_RE),
  command: z.string(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  cwd: z.string().optional(),
  timeoutMs: z.number().int().positive().default(30_000),
  enabled: z.boolean().default(true),
  _disabled: z.boolean().optional(),
  _comment: z.string().optional(),
  _requires_env: z.array(z.string()).optional(),
});

const HttpMcpServerConfig = z.object({
  transport: z.literal("http"),
  name: z.string().regex(MCP_SERVER_NAME_RE),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).default({}),
  oauth: OAuthConfig.optional(),
  timeoutMs: z.number().int().positive().default(30_000),
  enabled: z.boolean().default(true),
  _disabled: z.boolean().optional(),
  _comment: z.string().optional(),
  _requires_env: z.array(z.string()).optional(),
});

const SseMcpServerConfig = z.object({
  transport: z.literal("sse"),
  name: z.string().regex(MCP_SERVER_NAME_RE),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).default({}),
  oauth: OAuthConfig.optional(),
  timeoutMs: z.number().int().positive().default(30_000),
  enabled: z.boolean().default(true),
  _disabled: z.boolean().optional(),
  _comment: z.string().optional(),
  _requires_env: z.array(z.string()).optional(),
});

export const McpServerConfig = z.discriminatedUnion("transport", [
  StdioMcpServerConfig,
  HttpMcpServerConfig,
  SseMcpServerConfig,
]);
export type McpServerConfig = z.infer<typeof McpServerConfig>;

// ---------------------------------------------------------------------------
// Agents / skills
// ---------------------------------------------------------------------------

export const AgentRef = z.object({
  name: z.string(),
  path: z.string().optional(),
  description: z.string().optional(),
});
export type AgentRef = z.infer<typeof AgentRef>;

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

export const LoggerConfig = z.object({
  level: z.enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"]).default("info"),
  pretty: z.boolean().default(false),
  redact: z
    .array(z.string())
    .default(["apiKey", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY", "authorization", "password"]),
  traceDir: z.string().optional(),
});
export type LoggerConfig = z.infer<typeof LoggerConfig>;

// ---------------------------------------------------------------------------
// Root schema
// ---------------------------------------------------------------------------

export const JellyclawConfig = z.object({
  $schema: z.string().optional(),
  provider: ProviderConfig,
  permissions: PermissionPolicy.default(PermissionPolicy.parse({})),
  mcp: z.array(McpServerConfig).default([]),
  agents: z.array(AgentRef).default([]),
  skillsDir: z.string().default("./skills"),
  logger: LoggerConfig.default(LoggerConfig.parse({})),
  telemetry: z
    .object({
      enabled: z.boolean().default(false), // zero telemetry by default
    })
    .default({ enabled: false }),
});
export type JellyclawConfig = z.infer<typeof JellyclawConfig>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function defaultConfig(): JellyclawConfig {
  return JellyclawConfig.parse({
    provider: { type: "anthropic" },
  });
}

export function parseConfig(input: unknown): JellyclawConfig {
  return JellyclawConfig.parse(input);
}

export async function loadConfigFromFile(path: string): Promise<JellyclawConfig> {
  const { readFile } = await import("node:fs/promises");
  const raw = await readFile(path, "utf8");
  const parsed: unknown = JSON.parse(raw);
  return parseConfig(parsed);
}
