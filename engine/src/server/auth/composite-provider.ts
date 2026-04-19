/**
 * Phase 08 T5-03 — CompositeAuthProvider.
 *
 * Tries each provider in order. First non-null wins. All null → null.
 */

import type { Principal } from "./principal.js";
import type { AuthProvider } from "./provider.js";

export class CompositeAuthProvider implements AuthProvider {
  private readonly providers: readonly AuthProvider[];

  constructor(providers: readonly AuthProvider[]) {
    this.providers = providers;
  }

  async authenticate(req: Request, ip: string): Promise<Principal | null> {
    for (const provider of this.providers) {
      const principal = await provider.authenticate(req, ip);
      if (principal !== null) {
        return principal;
      }
    }
    return null;
  }
}

/**
 * Factory function for consistency with other providers.
 */
export function createCompositeAuthProvider(providers: readonly AuthProvider[]): AuthProvider {
  return new CompositeAuthProvider(providers);
}
