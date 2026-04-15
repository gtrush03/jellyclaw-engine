/**
 * Provider barrel — the public surface for Phase 02+.
 *
 * The individual modules are also exported from `../providers/anthropic.js`
 * and `../providers/openrouter.js` paths directly (package.json `exports`),
 * kept stable for consumers that want to depth-import.
 */

export type { AnthropicProviderDeps, RetryPolicy } from "./anthropic.js";
export { AnthropicProvider, BETA_EXTENDED_CACHE_TTL } from "./anthropic.js";
export {
  type BreakpointOptions,
  defaultBreakpointOptions,
  type PlannedRequest,
  planBreakpoints,
} from "./cache-breakpoints.js";
export {
  AllKeysDeadError,
  type CredentialPool,
  type ResolveCredentialsOptions,
  resolveCredentials,
} from "./credential-pool.js";
export { CachingGateError, enforceCachingGate } from "./gate.js";
export type { OpenRouterProviderDeps } from "./openrouter.js";
export { OpenRouterProvider } from "./openrouter.js";
export type { ProviderRouterDeps } from "./router.js";
export { ProviderRouter, shouldFailover } from "./router.js";
export type {
  CacheControlInput,
  MemoryContext,
  Provider,
  ProviderChunk,
  ProviderRequest,
  SystemBlock,
} from "./types.js";
