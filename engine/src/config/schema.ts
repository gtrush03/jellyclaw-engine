/**
 * Authoritative config schema per SPEC §9.
 *
 * This is the NEW schema introduced in Phase 02. The legacy
 * `engine/src/config.ts` schema (from Phase 00 scaffolding) remains in
 * place so existing imports don't break; Phase 10 (CLI + library) will
 * consolidate the two. Until then, provider wrappers read from THIS
 * schema; the legacy is used only by `engine/src/index.ts` glue.
 *
 * See `engine/provider-research-notes.md` §3 for breakpoint rules and
 * §10 for the `acknowledgeCachingLimits` gate.
 */

import { z } from "zod";

export const Provider = z.enum(["anthropic", "openrouter"]);
export type Provider = z.infer<typeof Provider>;

export const AnthropicBlock = z
  .object({
    apiKey: z.string().optional(),
    baseURL: z.string().url().optional(),
  })
  .default({});

export const OpenRouterBlock = z
  .object({
    apiKey: z.string().optional(),
    baseURL: z.string().url().default("https://openrouter.ai/api/v1"),
  })
  .default({});

export const CacheBlock = z
  .object({
    enabled: z.boolean().default(true),
    skillsTopN: z.number().int().min(0).max(64).default(12),
    systemTTL: z.enum(["5m", "1h"]).default("1h"),
  })
  .default({});

export const ServerBlock = z
  .object({
    host: z.literal("127.0.0.1").default("127.0.0.1"),
    portRange: z
      .tuple([z.number().int().positive(), z.number().int().positive()])
      .default([49152, 65535]),
  })
  .default({});

export const TelemetryBlock = z
  .object({
    enabled: z.boolean().default(false),
  })
  .default({});

/**
 * Permission mode — see `engine/src/permissions/types.ts` and
 * `docs/permissions.md`. Exported so CLI / config consumers can reuse it.
 */
export const PermissionModeSchema = z.enum(["default", "acceptEdits", "bypassPermissions", "plan"]);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;

/**
 * Permissions block. Replaces the legacy `Record<string, "allow"|"ask"|"deny">`
 * shape from Phase 02; the new structured form is what the Phase 08 rule
 * parser / decision engine consume. `mcpTools` opts specific MCP tools into
 * plan-mode read-only treatment.
 */
export const PermissionsBlock = z
  .object({
    mode: PermissionModeSchema.default("default"),
    allow: z.array(z.string()).default([]),
    deny: z.array(z.string()).default([]),
    ask: z.array(z.string()).default([]),
    mcpTools: z.record(z.string(), z.literal("readonly")).default({}),
  })
  .default({});
export type PermissionsBlock = z.infer<typeof PermissionsBlock>;

/**
 * Hooks block — Phase 08 prompt 02. One entry per configured hook. The
 * TypeScript contract lives in `engine/src/hooks/types.ts` as `HookConfig`;
 * this schema is structurally compatible (string enum, optional matcher,
 * command, args, timeout, blocking, name, env).
 */
export const HookConfigSchema = z.object({
  event: z.enum([
    "SessionStart",
    "InstructionsLoaded",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "SubagentStart",
    "SubagentStop",
    "PreCompact",
    "Stop",
    "Notification",
  ]),
  matcher: z.string().optional(),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  timeout: z.number().int().positive().max(120_000).optional(),
  blocking: z.boolean().optional(),
  name: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
});
export type HookConfigInput = z.infer<typeof HookConfigSchema>;

export const HooksBlock = z.array(HookConfigSchema).default([]);
export type HooksBlock = z.infer<typeof HooksBlock>;

// ---------------------------------------------------------------------------
// Rate limits (Phase 08.03). Browser rate limits protect against
// runaway Playwright driving; future non-browser categories will slot
// in here. Policy resolver lives at engine/src/ratelimit/policies.ts.
// ---------------------------------------------------------------------------
export const BucketSpec = z.object({
  capacity: z.number().int().positive(),
  refillPerSecond: z.number().positive(),
});
export type BucketSpec = z.infer<typeof BucketSpec>;

export const BrowserRateLimits = z
  .object({
    default: BucketSpec.optional(),
    perDomain: z.record(z.string(), BucketSpec).default({}),
  })
  .default({});
export type BrowserRateLimits = z.infer<typeof BrowserRateLimits>;

export const RateLimitsBlock = z
  .object({
    browser: BrowserRateLimits.optional(),
    /** If true, empty-bucket → deny immediately rather than awaiting refill. */
    strict: z.boolean().default(false),
    /** Cap on awaitable refill time before returning a rate-limited error. */
    maxWaitMs: z.number().int().positive().max(60_000).default(5_000),
  })
  .default({});
export type RateLimitsBlock = z.infer<typeof RateLimitsBlock>;

// ---------------------------------------------------------------------------
// Secrets block (Phase 08.03). User-extended scrub patterns layered on
// top of the built-in set in engine/src/security/secret-patterns.ts.
// Regex compilation + ReDoS probe happens at engine boot — invalid
// patterns surface as warnings, not fatal.
// ---------------------------------------------------------------------------
export const UserSecretPatternSpec = z.object({
  name: z
    .string()
    .min(1)
    .regex(/^[a-z0-9_]+$/, "name must be snake_case (lowercase letters, digits, underscores)"),
  regex: z.string().min(1),
  flags: z.string().optional(),
});
export type UserSecretPatternSpec = z.infer<typeof UserSecretPatternSpec>;

export const SecretsBlock = z
  .object({
    patterns: z.array(UserSecretPatternSpec).default([]),
    /** Skip scrubbing strings shorter than this. Default 8 (no real secret fits). */
    minLength: z.number().int().nonnegative().default(8),
    /** Short-circuit after first hit per string. Default false. */
    fast: z.boolean().default(false),
  })
  .default({});
export type SecretsBlock = z.infer<typeof SecretsBlock>;

export const Config = z.object({
  provider: Provider.default("anthropic"),
  model: z.string().default("claude-opus-4-7"),
  anthropic: AnthropicBlock,
  openrouter: OpenRouterBlock,
  cache: CacheBlock,
  server: ServerBlock,
  telemetry: TelemetryBlock,
  permissions: PermissionsBlock,
  hooks: HooksBlock,
  rateLimits: RateLimitsBlock,
  secrets: SecretsBlock,
  /**
   * Safety gate. When false (default), the router MUST reject any request
   * that routes an `anthropic/*` model via the `openrouter` provider.
   * See provider-research-notes.md §10.
   */
  acknowledgeCachingLimits: z.boolean().default(false),
});
export type Config = z.infer<typeof Config>;

/**
 * Parses and validates a raw config object. Throws `z.ZodError` on failure.
 */
export function parseConfig(input: unknown): Config {
  return Config.parse(input);
}

export function defaultConfig(): Config {
  return Config.parse({});
}
