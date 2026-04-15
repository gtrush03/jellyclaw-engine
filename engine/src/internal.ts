/**
 * @jellyclaw/engine/internal — NON-public surface.
 *
 * This barrel exists so Phase 10.01 CLI and Phase 10.02 server code can keep
 * reaching into engine internals (bootstrap, providers, plugin helpers, the
 * legacy `run()` generator) WITHOUT leaking those shapes through the public
 * library surface (`engine/src/index.ts`).
 *
 * Stability: NONE. Anything here may change between minor versions. Library
 * consumers MUST NOT import from `@jellyclaw/engine/internal` — use the
 * public `createEngine()` / `Engine` API instead.
 */

// ---------------------------------------------------------------------------
// Bootstrap — OpenCode server lifecycle
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Providers — concrete classes. Public surface exposes provider types via
// `ProviderConfig` only; callers construct through `createEngine()`.
// ---------------------------------------------------------------------------

export { AnthropicProvider } from "./providers/anthropic.js";
export { OpenRouterProvider } from "./providers/openrouter.js";

// ---------------------------------------------------------------------------
// Plugin helpers — agent-context + secret scrubbing. Used by CLI/server to
// redact tool payloads before they hit disk or the wire.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Legacy `run()` generator — the Phase-0 stub kept alive as an async iterator
// so the CLI (`cli.ts`, `cli/run.ts`) and the HTTP run-manager
// (`server/run-manager.ts`) keep working while Agent A lands the real
// `Engine.run()` in `engine.ts` + `run-handle.ts`.
//
// @deprecated — prefer `createEngine().run(input)` from the public barrel.
// ---------------------------------------------------------------------------

export { type RunOptions, run } from "./legacy-run.js";

// ---------------------------------------------------------------------------
// Config — full schema surface (zod objects + helpers). Public barrel only
// re-exports the validated *types*; internals still need the runtime zod
// values for parsing.
// ---------------------------------------------------------------------------

export {
  defaultConfig,
  type JellyclawConfig,
  loadConfigFromFile,
  parseConfig,
} from "./config.js";
