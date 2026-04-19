/**
 * Phase 08 T5-03 — AuthProvider interface.
 *
 * The single seam for all authentication flows. Implementations:
 *   - BearerAuthProvider — self-hosted single-user mode (default)
 *   - MultiTenantAuthProvider — managed mode with API keys + BYOK
 *   - CompositeAuthProvider — chains multiple providers
 */

import type { Principal } from "./principal.js";

export interface AuthProvider {
  /**
   * Authenticate an incoming request.
   *
   * @param req - The raw Fetch-API Request object
   * @param ip - Client IP (from Fly-Client-IP, X-Forwarded-For, or fallback)
   * @returns Principal on success, null on failure. Never throws for unauth.
   */
  authenticate(req: Request, ip: string): Promise<Principal | null>;
}
