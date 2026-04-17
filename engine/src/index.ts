/**
 * @jellyclaw/engine — public library API (Phase 10.03).
 *
 * Consumers import only from this barrel:
 *
 *   import { createEngine, type EngineEvent } from "@jellyclaw/engine";
 *
 * The surface is intentionally slim — ~15 named exports. Internal helpers
 * (bootstrap, provider classes, the legacy `run()` generator, scrubbers)
 * live in `@jellyclaw/engine/internal` and are NOT stable API.
 *
 * All type-only re-exports pass through `public-types.ts`, which is the
 * frozen contract.
 */

// ---------------------------------------------------------------------------
// Value exports
// ---------------------------------------------------------------------------

export { loadConfig } from "./config/loader.js";
export { createEngine } from "./create-engine.js";
export {
  ConfigInvalidError,
  Engine,
  EngineDisposedError,
  NoSessionsForProjectError,
  RunNotFoundError,
} from "./engine.js";
export { createLogger } from "./logger.js";

// SDK exports (T3-12)
export { query } from "./sdk/index.js";

// ---------------------------------------------------------------------------
// Type-only exports — all from public-types.ts
// ---------------------------------------------------------------------------

export type {
  Agent,
  EngineConfig,
  EngineEvent,
  EngineEventKind,
  EngineOptions,
  EngineOptionsConfig,
  HookEvent,
  McpTool,
  PermissionMode,
  ProviderConfig,
  ProviderName,
  RunHandle,
  RunInput,
  SessionSummary,
  Skill,
  Usage,
} from "./public-types.js";

// SDK type exports (T3-12)
export type { Query, QueryOptions, SDKMessage } from "./sdk/index.js";
