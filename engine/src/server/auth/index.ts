/**
 * Phase 08 T5-03 — Auth module exports.
 */

export type { AuthProvider } from "./provider.js";
export {
  byokPrincipal,
  freeTierPrincipal,
  selfHostedPrincipal,
  type Principal,
  type RateLimitSnapshot,
  type Scope,
} from "./principal.js";
export { BearerAuthProvider, createBearerAuthProvider } from "./bearer-provider.js";
export {
  createMultiTenantAuthProviderStub,
  MultiTenantAuthProviderStub,
} from "./multi-tenant-provider.js";
export { CompositeAuthProvider, createCompositeAuthProvider } from "./composite-provider.js";
