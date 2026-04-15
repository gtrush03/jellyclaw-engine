/**
 * Phase 07 Prompt 02 — OAuth 2.1 + PKCE for MCP HTTP/SSE transports.
 *
 * Thin adapter around the SDK's `OAuthClientProvider` interface that
 * wires three things together:
 *
 *   1. Persistent, 0600-mode `TokenStore` for access + refresh tokens
 *      and the in-flight PKCE code_verifier.
 *   2. A one-shot loopback HTTP listener on `127.0.0.1:<callbackPort>`
 *      that captures the `code` + `state` from the browser redirect.
 *   3. A cross-platform browser-opener (`open` on macOS, `xdg-open` on
 *      Linux, `start` on Windows) with an automatic stderr-print
 *      fallback for headless environments.
 *
 * The SDK owns PKCE crypto, discovery, and token refresh. We provide
 * the persistence, the redirect listener, and the browser nudge.
 */

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

import type { Logger } from "../logger.js";
import type { TokenStore } from "./token-store.js";
import type { OAuthConfig } from "./types.js";

const DEFAULT_CALLBACK_PORT = 47419;

/**
 * Thrown when the browser redirect carries a state value that doesn't
 * match the one we generated. Indicates tampering or a stale callback.
 */
export class OAuthStateMismatchError extends Error {
  override readonly name = "OAuthStateMismatchError";
  constructor() {
    super("OAuth callback state mismatch — possible CSRF or stale flow");
  }
}

/**
 * Thrown when the configured callback port is already in use. We do
 * not fall back to a random port because `redirect_uri` must match
 * the value registered with the authorization server.
 */
export class OAuthCallbackPortInUseError extends Error {
  override readonly name = "OAuthCallbackPortInUseError";
  constructor(readonly port: number) {
    super(
      `OAuth callback port ${port} is already in use; set 'oauth.callbackPort' to a free port and re-register the redirect_uri`,
    );
  }
}

export interface OAuthProviderOptions {
  readonly server: string;
  readonly url: string;
  readonly oauth: OAuthConfig;
  readonly logger: Logger;
  readonly tokenStore?: TokenStore;
  /** Optional opener override — tests pass `() => {}` to keep the browser closed. */
  readonly openBrowser?: (url: string) => void;
  /** Optional clock for TTL tests. */
  readonly now?: () => number;
}

/** Utilities exposed for direct testing. */
export const pkce = {
  /** RFC 7636: 43–128 chars, base64url(crypto-random). We use 64. */
  generateVerifier(): string {
    return randomBytes(48).toString("base64url").slice(0, 64);
  },
  /** S256 challenge: base64url(sha256(verifier)). */
  challengeFromVerifier(verifier: string): string {
    return createHash("sha256").update(verifier).digest("base64url");
  },
  /** CSRF-hardening state. Always fresh per flow. */
  generateState(): string {
    return randomBytes(24).toString("base64url");
  },
};

/**
 * Build an `OAuthClientProvider` for a single MCP server. The same
 * provider instance is used by both HTTP and SSE transports; it is
 * safe to construct per connection attempt (state is on the token
 * store, not the provider).
 */
export function createOAuthClientProvider(opts: OAuthProviderOptions): OAuthClientProvider {
  return new JellyclawOAuthProvider(opts);
}

const TOKEN_KEY = (server: string) => `oauth:${server}`;
const VERIFIER_KEY = (server: string) => `oauth-verifier:${server}`;
const CLIENT_INFO_KEY = (server: string) => `oauth-client:${server}`;

class JellyclawOAuthProvider implements OAuthClientProvider {
  readonly #server: string;
  readonly #oauth: OAuthConfig;
  readonly #logger: Logger;
  readonly #tokenStore: TokenStore | undefined;
  readonly #openBrowser: (url: string) => void;
  readonly #callbackPort: number;

  constructor(opts: OAuthProviderOptions) {
    this.#server = opts.server;
    this.#oauth = opts.oauth;
    this.#logger = opts.logger;
    this.#tokenStore = opts.tokenStore;
    this.#openBrowser = opts.openBrowser ?? defaultBrowserOpener;
    this.#callbackPort = opts.oauth.callbackPort ?? DEFAULT_CALLBACK_PORT;
  }

  get redirectUrl(): string {
    return `http://127.0.0.1:${this.#callbackPort}/callback`;
  }

  get clientMetadata(): OAuthClientMetadata {
    const metadata: OAuthClientMetadata = {
      client_name: `jellyclaw-engine (${this.#server})`,
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
    if (this.#oauth.scope) {
      (metadata as OAuthClientMetadata & { scope: string }).scope = this.#oauth.scope;
    }
    return metadata;
  }

  state(): string {
    return pkce.generateState();
  }

  async clientInformation(): Promise<OAuthClientInformationFull | undefined> {
    // Static clientId from config is sufficient for most MCP servers.
    // If a server requires dynamic registration, the SDK will call
    // `saveClientInformation` with the result; we persist it under
    // CLIENT_INFO_KEY so subsequent sessions skip registration.
    if (!this.#tokenStore) {
      return {
        client_id: this.#oauth.clientId,
        redirect_uris: [this.redirectUrl],
      };
    }
    const saved = await this.#tokenStore.get(CLIENT_INFO_KEY(this.#server));
    if (saved?.accessToken) {
      // We hijacked the `accessToken` field for the JSON-encoded blob —
      // keeps the token-store schema tiny. Decode defensively.
      try {
        return JSON.parse(saved.accessToken) as OAuthClientInformationFull;
      } catch {
        // Fall through to the static fallback.
      }
    }
    return {
      client_id: this.#oauth.clientId,
      redirect_uris: [this.redirectUrl],
    };
  }

  async saveClientInformation(info: OAuthClientInformationFull): Promise<void> {
    if (!this.#tokenStore) return;
    await this.#tokenStore.set(CLIENT_INFO_KEY(this.#server), {
      accessToken: JSON.stringify(info),
    });
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    if (!this.#tokenStore) return undefined;
    const stored = await this.#tokenStore.get(TOKEN_KEY(this.#server));
    if (!stored) return undefined;
    const tokens: OAuthTokens = {
      access_token: stored.accessToken,
      token_type: stored.tokenType ?? "Bearer",
    };
    if (stored.refreshToken) tokens.refresh_token = stored.refreshToken;
    if (stored.scope) tokens.scope = stored.scope;
    return tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    if (!this.#tokenStore) return;
    await this.#tokenStore.set(TOKEN_KEY(this.#server), {
      accessToken: tokens.access_token,
      ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
      ...(tokens.expires_in ? { expiresAt: Date.now() + tokens.expires_in * 1000 } : {}),
      ...(tokens.scope ? { scope: tokens.scope } : {}),
      tokenType: tokens.token_type ?? "Bearer",
    });
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    // Sync by design: the SDK accepts `void | Promise<void>`. Keeping
    // this synchronous avoids a needless microtask and the `useAwait`
    // false-positive.
    this.#logger.info(
      { server: this.#server, callbackPort: this.#callbackPort },
      "mcp oauth: opening browser for authorization",
    );
    process.stderr.write(
      `\n[jellyclaw] OAuth authorization required for MCP server '${this.#server}'.\n` +
        `          If a browser does not open, visit this URL:\n          ${authorizationUrl.toString()}\n`,
    );
    this.#openBrowser(authorizationUrl.toString());
  }

  async saveCodeVerifier(verifier: string): Promise<void> {
    if (!this.#tokenStore) {
      throw new Error("OAuth flow requires a TokenStore to persist the PKCE verifier");
    }
    await this.#tokenStore.set(VERIFIER_KEY(this.#server), { accessToken: verifier });
  }

  async codeVerifier(): Promise<string> {
    if (!this.#tokenStore) {
      throw new Error("OAuth flow requires a TokenStore to read the PKCE verifier");
    }
    const stored = await this.#tokenStore.get(VERIFIER_KEY(this.#server));
    if (!stored) throw new Error("no PKCE verifier saved — flow is out of order");
    return stored.accessToken;
  }

  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): Promise<void> {
    if (!this.#tokenStore) return;
    if (scope === "all" || scope === "tokens") {
      await this.#tokenStore.delete(TOKEN_KEY(this.#server));
    }
    if (scope === "all" || scope === "verifier") {
      await this.#tokenStore.delete(VERIFIER_KEY(this.#server));
    }
    if (scope === "all" || scope === "client") {
      await this.#tokenStore.delete(CLIENT_INFO_KEY(this.#server));
    }
  }
}

// ---------------------------------------------------------------------------
// Loopback callback listener
// ---------------------------------------------------------------------------

export interface CallbackAwait {
  readonly code: string;
  readonly state: string;
}

export interface StartCallbackListenerOptions {
  readonly port: number;
  readonly expectedState: string;
  /** Abort after this many ms if no callback arrives. Default 300_000 (5 min). */
  readonly timeoutMs?: number;
  /** Injectable for tests. */
  readonly signal?: AbortSignal;
}

/**
 * Start a one-shot HTTP server on `127.0.0.1:<port>` that resolves
 * once it receives a `GET /callback?code=...&state=...` matching the
 * expected state. The server is closed immediately after the match
 * (or on timeout/abort). Any request other than `/callback` gets 404;
 * a callback with a mismatched state gets 400 + the returned promise
 * rejects with `OAuthStateMismatchError`.
 */
export function awaitOAuthCallback(opts: StartCallbackListenerOptions): Promise<CallbackAwait> {
  const timeoutMs = opts.timeoutMs ?? 300_000;

  return new Promise<CallbackAwait>((resolve, reject) => {
    const server: Server = createServer((req, res) => {
      if (!req.url) {
        res.statusCode = 400;
        res.end("bad request");
        return;
      }
      const url = new URL(req.url, `http://127.0.0.1:${opts.port}`);
      if (url.pathname !== "/callback") {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code || !state) {
        res.statusCode = 400;
        res.end("missing code or state");
        finish(new Error("OAuth callback missing code or state"));
        return;
      }
      if (state !== opts.expectedState) {
        res.statusCode = 400;
        res.end("state mismatch");
        finish(new OAuthStateMismatchError());
        return;
      }
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.statusCode = 200;
      res.end(
        "<!doctype html><meta charset=utf-8><title>jellyclaw</title>" +
          '<body style="font:14px system-ui;padding:2rem">Authorization complete. You can close this tab.</body>',
      );
      finish({ code, state });
    });

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(new OAuthCallbackPortInUseError(opts.port));
      } else {
        reject(err);
      }
    });

    const timer = setTimeout(() => {
      finish(new Error(`OAuth callback timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const abortHandler = () => finish(new Error("OAuth callback aborted"));
    opts.signal?.addEventListener("abort", abortHandler, { once: true });

    let finished = false;
    function finish(result: CallbackAwait | Error): void {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", abortHandler);
      server.close();
      if (result instanceof Error) reject(result);
      else resolve(result);
    }

    server.listen(opts.port, "127.0.0.1");
  });
}

// ---------------------------------------------------------------------------
// Browser opener
// ---------------------------------------------------------------------------

function defaultBrowserOpener(url: string): void {
  // Best-effort; if this fails (headless), the URL has already been
  // written to stderr by the redirectToAuthorization handler.
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {
      /* swallow — stderr fallback already printed */
    });
    child.unref();
  } catch {
    // ignored — stderr fallback suffices
  }
}
