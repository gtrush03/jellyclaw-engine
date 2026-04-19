/**
 * Phase 08 T5-03 — MultiTenantAuthProvider (STUB).
 *
 * Recognizes:
 *   - x-anthropic-api-key: sk-ant-* → BYOK Principal (tier "byok")
 *   - x-api-key: jk_live_* or jk_test_* → Free-tier Principal
 *   - Authorization: Bearer jk_live_* or jk_test_* → Same as x-api-key
 *   - else → null
 *
 * TODO(T5-future): Replace body with argon2id verify against Postgres.
 *
 * The stub hashes the key with SHA-256 and takes the first 8 chars to
 * produce a stable accountId. Key is never logged or persisted.
 */

import { createHash } from "node:crypto";

import { byokPrincipal, freeTierPrincipal, type Principal } from "./principal.js";
import type { AuthProvider } from "./provider.js";

/**
 * Hash a key to produce a stable stub account ID.
 * Takes first 8 chars of SHA-256 hex digest.
 */
function hashKeyToAccountId(key: string): string {
  return `stub:${createHash("sha256").update(key).digest("hex").slice(0, 8)}`;
}

export class MultiTenantAuthProviderStub implements AuthProvider {
  // biome-ignore lint/suspicious/useAwait: interface requires Promise return
  async authenticate(req: Request, _ip: string): Promise<Principal | null> {
    // 1. Check x-anthropic-api-key header (BYOK)
    const anthropicKey = req.headers.get("x-anthropic-api-key");
    if (anthropicKey?.startsWith("sk-ant-")) {
      const accountId = hashKeyToAccountId(anthropicKey);
      return byokPrincipal(accountId, anthropicKey);
    }

    // 2. Check x-api-key header (jellyclaw API key)
    const apiKey = req.headers.get("x-api-key");
    if (apiKey !== null && (apiKey.startsWith("jk_live_") || apiKey.startsWith("jk_test_"))) {
      const accountId = hashKeyToAccountId(apiKey);
      return freeTierPrincipal(accountId);
    }

    // 3. Check Authorization: Bearer jk_* (alternative to x-api-key)
    const authHeader = req.headers.get("Authorization") ?? req.headers.get("authorization");
    if (authHeader !== null) {
      const match = /^Bearer\s+(.+)$/i.exec(authHeader);
      if (match) {
        const token = match[1] ?? "";
        if (token.startsWith("jk_live_") || token.startsWith("jk_test_")) {
          const accountId = hashKeyToAccountId(token);
          return freeTierPrincipal(accountId);
        }
      }
    }

    return null;
  }
}

/**
 * Factory function for consistency with other providers.
 */
export function createMultiTenantAuthProviderStub(): AuthProvider {
  return new MultiTenantAuthProviderStub();
}
