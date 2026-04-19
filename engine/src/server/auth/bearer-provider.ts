/**
 * Phase 08 T5-03 — BearerAuthProvider.
 *
 * Wraps the existing constant-time bearer token comparison logic.
 * Used in self-hosted mode (the default). Returns `selfHostedPrincipal()`
 * on match, null on mismatch.
 *
 * Timing safety: Uses `crypto.timingSafeEqual` over equal-length buffers.
 * If the provided token differs in length, we still run the compare on a
 * zero-padded copy so a length-based early return cannot leak token length.
 */

import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";

import { selfHostedPrincipal, type Principal } from "./principal.js";
import type { AuthProvider } from "./provider.js";

export interface BearerAuthProviderOptions {
  readonly authToken: string;
}

export class BearerAuthProvider implements AuthProvider {
  private readonly expected: Buffer;

  constructor(opts: BearerAuthProviderOptions) {
    if (opts.authToken.length === 0) {
      throw new Error("BearerAuthProvider: authToken must be non-empty");
    }
    this.expected = Buffer.from(opts.authToken, "utf8");
  }

  // biome-ignore lint/suspicious/useAwait: interface requires Promise return
  async authenticate(req: Request, _ip: string): Promise<Principal | null> {
    const header = req.headers.get("Authorization") ?? req.headers.get("authorization");
    if (header === null) {
      return null;
    }

    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match) {
      return null;
    }

    const provided = match[1] ?? "";
    const allow = this.constantTimeTokenCompare(provided);
    if (!allow) {
      return null;
    }

    return selfHostedPrincipal();
  }

  /**
   * Compare a caller-provided token against the expected buffer in (roughly)
   * constant time. Never short-circuits on length mismatch: a padded buffer of
   * `expected.length` is always compared; a parallel `lengthsEqual` boolean is
   * ANDed into the result so a length-only match cannot succeed.
   */
  private constantTimeTokenCompare(provided: string): boolean {
    const providedBuf = Buffer.from(provided, "utf8");
    const lengthsEqual = providedBuf.length === this.expected.length;

    // Always allocate expected.length and copy whatever fits.
    // Node's timingSafeEqual requires equal-length buffers.
    const padded = Buffer.alloc(this.expected.length);
    providedBuf.copy(padded, 0, 0, Math.min(providedBuf.length, this.expected.length));

    const bytesEqual = timingSafeEqual(padded, this.expected);
    return bytesEqual && lengthsEqual;
  }
}

/**
 * Factory function for consistency with other providers.
 */
export function createBearerAuthProvider(opts: BearerAuthProviderOptions): AuthProvider {
  return new BearerAuthProvider(opts);
}
