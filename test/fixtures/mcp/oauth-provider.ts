#!/usr/bin/env bun
/**
 * Minimal mock OAuth 2.1 authorization server for Phase 07 tests.
 *
 * Implements just enough of the spec for a PKCE (S256) round-trip plus a
 * refresh-token grant. The /authorize endpoint skips any browser UI and
 * redirects immediately — that's fine because tests drive the flow
 * programmatically.
 *
 * Programmatic usage:
 *
 *   const { baseUrl, close, issueTokenDirectly, lastAuthorizeRequest }
 *     = await startOAuthProvider();
 */

import { createHash, randomBytes } from "node:crypto";
import {
  createServer,
  type Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { URL, URLSearchParams } from "node:url";

export interface StartOAuthProviderOptions {
  /** Accepted client_id. Default `"test-client"`. */
  clientId?: string;
}

export interface CapturedAuthorizeRequest {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  state: string;
  scope: string | undefined;
}

export interface TokenPair {
  access_token: string;
  refresh_token: string;
  token_type: "Bearer";
  expires_in: number;
  scope: string | undefined;
}

export interface OAuthProviderHandle {
  baseUrl: string;
  close(): Promise<void>;
  /** Bypass the /authorize flow entirely. Used by refresh-path tests. */
  issueTokenDirectly(scope?: string): TokenPair;
  /** Last payload captured by /authorize, or `null` if never called. */
  readonly lastAuthorizeRequest: CapturedAuthorizeRequest | null;
}

interface PendingCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope: string | undefined;
}

interface RefreshEntry {
  scope: string | undefined;
}

export async function startOAuthProvider(
  opts: StartOAuthProviderOptions = {},
): Promise<OAuthProviderHandle> {
  const clientId = opts.clientId ?? "test-client";

  const pendingCodes = new Map<string, PendingCode>();
  const refreshTokens = new Map<string, RefreshEntry>();
  let lastAuthorize: CapturedAuthorizeRequest | null = null;

  const mintToken = (): string => randomBytes(24).toString("hex");

  const makePair = (scope: string | undefined): TokenPair => {
    const access = mintToken();
    const refresh = mintToken();
    refreshTokens.set(refresh, { scope });
    return {
      access_token: access,
      refresh_token: refresh,
      token_type: "Bearer",
      expires_in: 3600,
      scope,
    };
  };

  const httpServer: HttpServer = createServer((req, res) => {
    route(req, res).catch((err: unknown) => {
      if (!res.headersSent) {
        sendJson(res, 500, {
          error: "server_error",
          error_description: String((err as Error).message ?? err),
        });
      }
    });
  });

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const host = req.headers.host ?? "127.0.0.1";
    const full = new URL(req.url ?? "/", `http://${host}`);
    const path = full.pathname;

    if (req.method === "GET" && path === "/.well-known/oauth-authorization-server") {
      sendJson(res, 200, {
        issuer: baseUrlValue(),
        authorization_endpoint: `${baseUrlValue()}/authorize`,
        token_endpoint: `${baseUrlValue()}/token`,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        grant_types_supported: ["authorization_code", "refresh_token"],
      });
      return;
    }

    if (req.method === "GET" && path === "/authorize") {
      handleAuthorize(full, res);
      return;
    }

    if (req.method === "POST" && path === "/token") {
      await handleToken(req, res);
      return;
    }

    res.statusCode = 404;
    res.end();
  }

  function handleAuthorize(u: URL, res: ServerResponse): void {
    const params = u.searchParams;
    const responseType = params.get("response_type");
    const reqClientId = params.get("client_id");
    const redirectUri = params.get("redirect_uri");
    const codeChallenge = params.get("code_challenge");
    const codeChallengeMethod = params.get("code_challenge_method") ?? "plain";
    const state = params.get("state") ?? "";
    const scope = params.get("scope") ?? undefined;

    if (responseType !== "code" || !reqClientId || !redirectUri || !codeChallenge) {
      sendJson(res, 400, { error: "invalid_request" });
      return;
    }
    if (codeChallengeMethod !== "S256") {
      sendJson(res, 400, { error: "invalid_request", error_description: "only S256 supported" });
      return;
    }
    if (reqClientId !== clientId) {
      sendJson(res, 400, { error: "invalid_client" });
      return;
    }

    lastAuthorize = {
      clientId: reqClientId,
      redirectUri,
      codeChallenge,
      codeChallengeMethod,
      state,
      scope,
    };

    const code = mintToken();
    pendingCodes.set(code, {
      clientId: reqClientId,
      redirectUri,
      codeChallenge,
      codeChallengeMethod,
      scope,
    });

    const redirect = new URL(redirectUri);
    redirect.searchParams.set("code", code);
    if (state) redirect.searchParams.set("state", state);

    res.statusCode = 302;
    res.setHeader("location", redirect.toString());
    res.end();
  }

  async function handleToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const rawBody = await readBody(req);
    const form = new URLSearchParams(rawBody);
    const grantType = form.get("grant_type");

    if (grantType === "authorization_code") {
      const code = form.get("code") ?? "";
      const verifier = form.get("code_verifier") ?? "";
      const reqClientId = form.get("client_id") ?? "";
      const redirectUri = form.get("redirect_uri") ?? "";

      const pending = pendingCodes.get(code);
      if (!pending) {
        sendJson(res, 400, { error: "invalid_grant", error_description: "unknown code" });
        return;
      }
      pendingCodes.delete(code);

      if (pending.clientId !== reqClientId || pending.redirectUri !== redirectUri) {
        sendJson(res, 400, {
          error: "invalid_grant",
          error_description: "client/redirect mismatch",
        });
        return;
      }

      const expected = base64UrlSha256(verifier);
      if (expected !== pending.codeChallenge) {
        sendJson(res, 400, {
          error: "invalid_grant",
          error_description: "PKCE verification failed",
        });
        return;
      }

      sendJson(res, 200, makePair(pending.scope));
      return;
    }

    if (grantType === "refresh_token") {
      const refresh = form.get("refresh_token") ?? "";
      const entry = refreshTokens.get(refresh);
      if (!entry) {
        sendJson(res, 400, { error: "invalid_grant", error_description: "unknown refresh token" });
        return;
      }
      // Rotate: invalidate old refresh token, issue new pair.
      refreshTokens.delete(refresh);
      sendJson(res, 200, makePair(entry.scope));
      return;
    }

    sendJson(res, 400, { error: "unsupported_grant_type" });
  }

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", () => {
      httpServer.removeListener("error", reject);
      resolve();
    });
  });

  const addr = httpServer.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  function baseUrlValue(): string {
    return baseUrl;
  }

  const handle: OAuthProviderHandle = {
    baseUrl,
    issueTokenDirectly(scope?: string): TokenPair {
      return makePair(scope);
    },
    get lastAuthorizeRequest() {
      return lastAuthorize;
    },
    async close() {
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
  return handle;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function base64UrlSha256(input: string): string {
  const hash = createHash("sha256").update(input).digest();
  return hash.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Bun-only `import.meta.main`; read via cast so we don't need a global
// augmentation that would conflict with the sibling fixture.
const metaMain = (import.meta as unknown as { main?: boolean }).main;
const isEntrypoint =
  metaMain === true ||
  (typeof process !== "undefined" &&
    process.argv[1] !== undefined &&
    import.meta.url === `file://${process.argv[1]}`);

if (isEntrypoint) {
  const handle = await startOAuthProvider();
  process.stderr.write(`[oauth-provider] listening on ${handle.baseUrl}\n`);
  const shutdown = async () => {
    await handle.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
