/**
 * Tests for the MCP OAuth 2.1 + PKCE module.
 *
 * Covers the PKCE primitives, the loopback callback listener, the
 * `OAuthClientProvider` adapter on top of `TokenStore`, and a full
 * PKCE round-trip against the in-process mock authorization server.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { createServer as createNetServer, type Server as NetServer } from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startOAuthProvider } from "../../../test/fixtures/mcp/oauth-provider.js";
import type { Logger } from "../logger.js";
import {
  awaitOAuthCallback,
  createOAuthClientProvider,
  OAuthCallbackPortInUseError,
  OAuthStateMismatchError,
  pkce,
} from "./oauth.js";
import { TokenStore } from "./token-store.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const silentLogger: Logger = pino({ level: "silent" });

async function findFreePort(): Promise<number> {
  const { createServer } = await import("node:net");
  return new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

function base64UrlOfSha256(input: string): string {
  return createHash("sha256").update(input).digest("base64url");
}

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

// ---------------------------------------------------------------------------
// tmp dir lifecycle
// ---------------------------------------------------------------------------

let tmpDir: string;
let storePath: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "jellyclaw-oauth-"));
  storePath = path.join(tmpDir, "mcp-tokens.json");
});

afterEach(async () => {
  await fs.chmod(tmpDir, 0o700).catch(() => undefined);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function newTokenStore(): Promise<TokenStore> {
  const store = new TokenStore({ path: storePath });
  await store.load();
  return store;
}

// ---------------------------------------------------------------------------
// 1. PKCE primitives
// ---------------------------------------------------------------------------

describe("pkce primitives", () => {
  it("generateVerifier returns a 43–128 char base64url string", () => {
    const v = pkce.generateVerifier();
    expect(v.length).toBeGreaterThanOrEqual(43);
    expect(v.length).toBeLessThanOrEqual(128);
    expect(BASE64URL_RE.test(v)).toBe(true);
  });

  it("generateVerifier produces different values across calls", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) seen.add(pkce.generateVerifier());
    expect(seen.size).toBe(20);
  });

  it("challengeFromVerifier is deterministic", () => {
    const v = pkce.generateVerifier();
    expect(pkce.challengeFromVerifier(v)).toBe(pkce.challengeFromVerifier(v));
  });

  it("challengeFromVerifier equals base64url(sha256(verifier))", () => {
    const v = pkce.generateVerifier();
    expect(pkce.challengeFromVerifier(v)).toBe(base64UrlOfSha256(v));
  });

  it("generateState returns a non-empty base64url string, fresh per call", () => {
    const a = pkce.generateState();
    const b = pkce.generateState();
    expect(a.length).toBeGreaterThan(0);
    expect(BASE64URL_RE.test(a)).toBe(true);
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// 2. awaitOAuthCallback — loopback listener
// ---------------------------------------------------------------------------

describe("awaitOAuthCallback", () => {
  it("resolves with {code,state} on a valid /callback", async () => {
    const port = await findFreePort();
    const p = awaitOAuthCallback({ port, expectedState: "abc123", timeoutMs: 5_000 });

    // Small retry loop — the listener is listening synchronously but
    // `server.listen()` is async under the hood.
    const res = await fetchWhenReady(`http://127.0.0.1:${port}/callback?code=XYZ&state=abc123`);
    expect(res.status).toBe(200);

    await expect(p).resolves.toEqual({ code: "XYZ", state: "abc123" });
  });

  it("rejects with OAuthStateMismatchError and returns 400 on mismatched state", async () => {
    const port = await findFreePort();
    const p = awaitOAuthCallback({ port, expectedState: "right", timeoutMs: 5_000 });
    // Attach rejection handler up-front to avoid racing unhandledRejection.
    const settled = p.then(
      (v) => ({ ok: true as const, v }),
      (e: unknown) => ({ ok: false as const, e }),
    );

    const res = await fetchWhenReady(`http://127.0.0.1:${port}/callback?code=XYZ&state=wrong`);
    expect(res.status).toBe(400);

    const r = await settled;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.e).toBeInstanceOf(OAuthStateMismatchError);
  });

  it("returns 404 on non-/callback paths and still completes on a later valid callback", async () => {
    const port = await findFreePort();
    const p = awaitOAuthCallback({ port, expectedState: "s1", timeoutMs: 5_000 });

    const bad = await fetchWhenReady(`http://127.0.0.1:${port}/nope`);
    expect(bad.status).toBe(404);

    const ok = await fetch(`http://127.0.0.1:${port}/callback?code=C&state=s1`);
    expect(ok.status).toBe(200);

    await expect(p).resolves.toEqual({ code: "C", state: "s1" });
  });

  it("rejects with 400 when /callback is missing code/state", async () => {
    const port = await findFreePort();
    const p = awaitOAuthCallback({ port, expectedState: "s1", timeoutMs: 5_000 });
    const settled = p.then(
      (v) => ({ ok: true as const, v }),
      (e: unknown) => ({ ok: false as const, e }),
    );

    const res = await fetchWhenReady(`http://127.0.0.1:${port}/callback`);
    expect(res.status).toBe(400);

    const r = await settled;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.e).toBeInstanceOf(Error);
    if (!r.ok) expect((r.e as Error).message).toMatch(/missing code or state/);
  });

  it("rejects with OAuthCallbackPortInUseError when the port is busy", async () => {
    const port = await findFreePort();
    const blocker: NetServer = createNetServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(port, "127.0.0.1", () => resolve());
    });

    try {
      await expect(
        awaitOAuthCallback({ port, expectedState: "s", timeoutMs: 1_000 }),
      ).rejects.toBeInstanceOf(OAuthCallbackPortInUseError);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it("rejects on abort and frees the port", async () => {
    const port = await findFreePort();
    const ac = new AbortController();
    const p = awaitOAuthCallback({
      port,
      expectedState: "s",
      timeoutMs: 30_000,
      signal: ac.signal,
    });

    // Give the listener a beat to bind before aborting.
    await new Promise((r) => setTimeout(r, 50));
    ac.abort();

    await expect(p).rejects.toThrow(/abort/i);

    // After abort, the port must be free — we can bind it ourselves.
    const probe: NetServer = createNetServer();
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(port, "127.0.0.1", () => resolve());
    });
    await new Promise<void>((resolve) => probe.close(() => resolve()));
  });
});

/**
 * Small retry helper — the HTTP server is listening almost immediately
 * after `server.listen()` is called, but there's a micro-window where
 * ECONNREFUSED can bite on a cold machine. Retry up to ~500 ms.
 */
async function fetchWhenReady(url: string): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < 50; i++) {
    try {
      return await fetch(url);
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

// ---------------------------------------------------------------------------
// 3. createOAuthClientProvider — TokenStore integration
// ---------------------------------------------------------------------------

describe("createOAuthClientProvider — TokenStore integration", () => {
  it("round-trips tokens", async () => {
    const tokenStore = await newTokenStore();
    const provider = createOAuthClientProvider({
      server: "srv1",
      url: "https://example.test",
      oauth: { clientId: "cid", callbackPort: 47501 },
      logger: silentLogger,
      tokenStore,
      openBrowser: () => undefined,
    });

    await provider.saveTokens({
      access_token: "a",
      refresh_token: "r",
      token_type: "Bearer",
      expires_in: 3600,
    });

    const t = await provider.tokens();
    expect(t).toBeDefined();
    expect(t?.access_token).toBe("a");
    expect(t?.refresh_token).toBe("r");
    expect(t?.token_type).toBe("Bearer");
  });

  it("invalidateCredentials('tokens') removes tokens but preserves verifier", async () => {
    const tokenStore = await newTokenStore();
    const provider = createOAuthClientProvider({
      server: "srv1",
      url: "https://example.test",
      oauth: { clientId: "cid", callbackPort: 47502 },
      logger: silentLogger,
      tokenStore,
      openBrowser: () => undefined,
    });

    await provider.saveTokens({ access_token: "a", token_type: "Bearer" });
    await provider.saveCodeVerifier("verifier-xyz");
    if (!provider.invalidateCredentials) throw new Error("invalidateCredentials missing");
    await provider.invalidateCredentials("tokens");

    expect(await provider.tokens()).toBeUndefined();
    expect(await provider.codeVerifier()).toBe("verifier-xyz");
  });

  it("invalidateCredentials('all') removes tokens and verifier", async () => {
    const tokenStore = await newTokenStore();
    const provider = createOAuthClientProvider({
      server: "srv1",
      url: "https://example.test",
      oauth: { clientId: "cid", callbackPort: 47503 },
      logger: silentLogger,
      tokenStore,
      openBrowser: () => undefined,
    });

    await provider.saveTokens({ access_token: "a", token_type: "Bearer" });
    await provider.saveCodeVerifier("verifier-xyz");
    if (!provider.invalidateCredentials) throw new Error("invalidateCredentials missing");
    await provider.invalidateCredentials("all");

    expect(await provider.tokens()).toBeUndefined();
    await expect(provider.codeVerifier()).rejects.toThrow(/no PKCE verifier saved/);
  });

  it("round-trips the PKCE verifier", async () => {
    const tokenStore = await newTokenStore();
    const provider = createOAuthClientProvider({
      server: "srv1",
      url: "https://example.test",
      oauth: { clientId: "cid", callbackPort: 47504 },
      logger: silentLogger,
      tokenStore,
      openBrowser: () => undefined,
    });

    await provider.saveCodeVerifier("xyz");
    expect(await provider.codeVerifier()).toBe("xyz");
  });

  it("without a TokenStore, tokens() is undefined and saveCodeVerifier throws", async () => {
    const provider = createOAuthClientProvider({
      server: "srv1",
      url: "https://example.test",
      oauth: { clientId: "cid", callbackPort: 47505 },
      logger: silentLogger,
      openBrowser: () => undefined,
    });

    expect(await provider.tokens()).toBeUndefined();
    await expect(provider.saveCodeVerifier("v")).rejects.toThrow(/requires a TokenStore/);
  });

  it("clientMetadata has correct redirect_uri, grant_types, response_types, scope", async () => {
    const tokenStore = await newTokenStore();
    const callbackPort = 47506;
    const provider = createOAuthClientProvider({
      server: "srv1",
      url: "https://example.test",
      oauth: { clientId: "cid", callbackPort, scope: "repo" },
      logger: silentLogger,
      tokenStore,
      openBrowser: () => undefined,
    });

    const md = provider.clientMetadata;
    expect(md.redirect_uris[0]).toBe(`http://127.0.0.1:${callbackPort}/callback`);
    expect(md.grant_types).toContain("authorization_code");
    expect(md.response_types).toEqual(["code"]);
    expect((md as { scope?: string }).scope).toBe("repo");
  });

  it("redirectToAuthorization invokes the opener and prints to stderr", async () => {
    const tokenStore = await newTokenStore();
    const opened: string[] = [];
    const provider = createOAuthClientProvider({
      server: "srv1",
      url: "https://example.test",
      oauth: { clientId: "cid", callbackPort: 47507 },
      logger: silentLogger,
      tokenStore,
      openBrowser: (url) => opened.push(url),
    });

    const origWrite = process.stderr.write.bind(process.stderr);
    const captured: string[] = [];
    (process.stderr as unknown as { write: (chunk: string) => boolean }).write = (
      chunk: string,
    ) => {
      captured.push(chunk);
      return true;
    };

    try {
      await provider.redirectToAuthorization(new URL("https://auth.example.test/authorize?x=1"));
    } finally {
      (process.stderr as unknown as { write: typeof origWrite }).write = origWrite;
    }

    expect(opened).toEqual(["https://auth.example.test/authorize?x=1"]);
    expect(captured.join("")).toMatch(/OAuth authorization required/);
    expect(captured.join("")).toMatch(/https:\/\/auth\.example\.test\/authorize/);
  });
});

// ---------------------------------------------------------------------------
// 4. Full PKCE flow against the mock provider
// ---------------------------------------------------------------------------

describe("full PKCE flow against mock authorization server", () => {
  it("completes authorize → loopback → token exchange and persists the tokens", async () => {
    const mock = await startOAuthProvider({ clientId: "test" });
    try {
      const tokenStore = await newTokenStore();
      const callbackPort = await findFreePort();
      const provider = createOAuthClientProvider({
        server: "mock",
        url: mock.baseUrl,
        oauth: { clientId: "test", scope: "repo", callbackPort },
        logger: silentLogger,
        tokenStore,
        openBrowser: () => undefined,
      });

      const verifier = pkce.generateVerifier();
      const challenge = pkce.challengeFromVerifier(verifier);
      const state = pkce.generateState();

      await provider.saveCodeVerifier(verifier);

      const callbackPromise = awaitOAuthCallback({
        port: callbackPort,
        expectedState: state,
        timeoutMs: 5_000,
      });

      // Drive /authorize with redirect: "manual" so we can fish out the
      // Location header and hit the loopback ourselves.
      const authUrl = new URL(`${mock.baseUrl}/authorize`);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("client_id", "test");
      authUrl.searchParams.set("redirect_uri", provider.redirectUrl as string);
      authUrl.searchParams.set("code_challenge", challenge);
      authUrl.searchParams.set("code_challenge_method", "S256");
      authUrl.searchParams.set("state", state);
      authUrl.searchParams.set("scope", "repo");

      const authRes = await fetch(authUrl.toString(), { redirect: "manual" });
      expect(authRes.status).toBe(302);
      const location = authRes.headers.get("location");
      expect(location).toBeTruthy();
      if (!location) throw new Error("no Location header");

      // Fire the loopback callback manually.
      const loopbackRes = await fetch(location);
      expect(loopbackRes.status).toBe(200);

      const { code, state: returnedState } = await callbackPromise;
      expect(returnedState).toBe(state);
      expect(code.length).toBeGreaterThan(0);

      // Assert the mock captured our challenge correctly.
      const captured = mock.lastAuthorizeRequest;
      expect(captured).not.toBeNull();
      if (!captured) throw new Error("no captured authorize request");
      expect(captured.codeChallenge).toBe(pkce.challengeFromVerifier(verifier));
      expect(captured.codeChallengeMethod).toBe("S256");
      expect(captured.clientId).toBe("test");
      expect(captured.scope).toBe("repo");

      // Exchange the code.
      const tokenBody = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        client_id: "test",
        redirect_uri: provider.redirectUrl as string,
      });
      const tokenRes = await fetch(`${mock.baseUrl}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: tokenBody.toString(),
      });
      expect(tokenRes.status).toBe(200);
      const tokenJson = (await tokenRes.json()) as {
        access_token: string;
        refresh_token: string;
        token_type: "Bearer";
        expires_in: number;
        scope?: string;
      };
      expect(tokenJson.access_token.length).toBeGreaterThan(0);
      expect(tokenJson.refresh_token.length).toBeGreaterThan(0);

      await provider.saveTokens({
        access_token: tokenJson.access_token,
        refresh_token: tokenJson.refresh_token,
        token_type: tokenJson.token_type,
        expires_in: tokenJson.expires_in,
        ...(tokenJson.scope ? { scope: tokenJson.scope } : {}),
      });

      const persisted = await provider.tokens();
      expect(persisted?.access_token).toBe(tokenJson.access_token);
      expect(persisted?.refresh_token).toBe(tokenJson.refresh_token);
    } finally {
      await mock.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Refresh-token path
// ---------------------------------------------------------------------------

describe("refresh-token grant against mock authorization server", () => {
  it("swaps a refresh token for a fresh access token", async () => {
    const mock = await startOAuthProvider();
    try {
      const seed = mock.issueTokenDirectly("repo");

      const body = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: seed.refresh_token,
      });
      const res = await fetch(`${mock.baseUrl}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        access_token: string;
        refresh_token: string;
        token_type: "Bearer";
      };
      expect(json.access_token.length).toBeGreaterThan(0);
      expect(json.access_token).not.toBe(seed.access_token);
      expect(json.refresh_token).not.toBe(seed.refresh_token);
    } finally {
      await mock.close();
    }
  });
});
