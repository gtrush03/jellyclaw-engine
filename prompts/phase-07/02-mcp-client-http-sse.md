# Phase 07 — MCP client integration — Prompt 02: StreamableHTTP + SSE transports + OAuth

**When to run:** After Phase 07 prompt 01 (stdio client + registry) is ✅ in `COMPLETION-LOG.md`.
**Estimated duration:** 4–5 hours
**New session?** Yes — always start a fresh Claude Code session per prompt
**Model:** Claude Opus 4.6 (1M context)

<!-- BEGIN: paste from /Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/STARTUP-TEMPLATE.md -->
<!-- STOP if 07.01 not ✅. -->
<!-- END paste -->

## Research task

1. Re-read `/Users/gtrush/Downloads/jellyclaw-engine/phases/PHASE-07-mcp.md`, Step 2 (http/sse transports) + Step 5 (OAuth).
2. Use context7 to fetch current `@modelcontextprotocol/sdk` docs for:
   - StreamableHTTPClientTransport (the 2025 unified HTTP transport)
   - SSEClientTransport (legacy but still supported)
   - Auth primitives — the SDK may expose a built-in OAuth helper; prefer it over hand-rolling.
3. Read `/Users/gtrush/Downloads/jellyclaw-engine/engine/SECURITY.md` — file mode 0600 on token store; refuse to load world-readable tokens.
4. Research PKCE: RFC 7636. We need `code_verifier` (43–128 chars) and `code_challenge = base64url(sha256(verifier))` with `code_challenge_method=S256`.
5. Re-read `engine/src/mcp/registry.ts` from prompt 01 — your new transports register through the same registry.

## Implementation task

Add two more transports to the MCP client factory and implement OAuth 2.1 + PKCE for HTTP MCP servers that require auth.

### Files to create/modify

- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/mcp/client-http.ts` — StreamableHTTP transport.
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/mcp/client-sse.ts` — SSE transport (legacy fallback).
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/mcp/oauth.ts` — PKCE flow, local callback listener, token refresh.
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/mcp/token-store.ts` — `~/.jellyclaw/mcp-tokens.json` (mode 0600).
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/mcp/namespacing.ts` — extract namespacing logic from prompt 01's registry into its own module with tests.
- Modify `engine/src/mcp/registry.ts` — dispatch to the correct factory based on `transport` field.
- Modify `engine/src/mcp/types.ts` — extend `McpServerConfig` with `http` / `sse` / `oauth` variants (discriminated union via `transport` field).
- `engine/package.json` — add `eventsource@^2` (SSE polyfill for Node if needed; StreamableHTTP uses `fetch`).
- Tests: `client-http.test.ts`, `client-sse.test.ts`, `oauth.test.ts`, `token-store.test.ts`, `namespacing.test.ts`.
- Fixtures: `/Users/gtrush/Downloads/jellyclaw-engine/test/fixtures/mcp/http-echo.ts` (tiny Hono or Node http server that speaks MCP), and `/Users/gtrush/Downloads/jellyclaw-engine/test/fixtures/mcp/oauth-provider.ts` (mock authorization server).

### Config schema extensions

```ts
type McpServerConfig =
  | { transport: "stdio"; command: string; args?: string[]; env?: Record<string,string> }
  | { transport: "http"; url: string; headers?: Record<string,string>; oauth?: OAuthConfig }
  | { transport: "sse";  url: string; headers?: Record<string,string>; oauth?: OAuthConfig };

type OAuthConfig = {
  clientId: string;
  scope?: string;
  authorizeUrl?: string;   // optional override; else discovered via /.well-known/oauth-authorization-server
  tokenUrl?: string;
  callbackPort?: number;   // default 47419
};
```

### OAuth 2.1 + PKCE flow

1. On first call to a tool from an HTTP MCP server that requires auth (401 received, or `oauth` in config):
   - Generate `code_verifier` (crypto-random, 64 chars, base64url).
   - Compute `code_challenge = base64url(sha256(verifier))`.
   - Discover `authorization_endpoint` / `token_endpoint` via `GET <baseUrl>/.well-known/oauth-authorization-server` (or use explicit config).
   - Start a **local HTTP listener** on `127.0.0.1:<callbackPort>` (default 47419; configurable; surface conflict as an error, don't pick a random port — the redirect_uri must match a registered value).
   - `state = crypto-random`. Build authorize URL with `client_id, redirect_uri=http://127.0.0.1:<port>/callback, response_type=code, code_challenge, code_challenge_method=S256, state, scope`.
   - `open` the URL in the user's browser (cross-platform; use `opener` or spawn `open`/`xdg-open`/`start`). Print URL to stderr as fallback.
   - Wait for `GET /callback?code=...&state=...`; verify state; exchange code for token at `token_endpoint` with `code_verifier`.
   - Store token in `~/.jellyclaw/mcp-tokens.json` with mode 0600; structure: `{ [serverName]: { access_token, refresh_token?, expires_at, scope } }`.
2. Subsequent calls: read token; if `expires_at` in past and refresh_token present, refresh; else redo full flow.
3. On 401 during a call, invalidate cached token and retry once with a fresh flow.

### Token store security

- On every load: `fs.stat`; if mode allows world or group read → refuse with a hard error (`"refusing to load world-readable MCP tokens at ~/.jellyclaw/mcp-tokens.json"`).
- On every write: `fs.writeFile` then `fs.chmod(path, 0o600)` explicitly.
- Atomic write: write to `<path>.tmp` + rename.

### Namespacing

Move namespacing into `engine/src/mcp/namespacing.ts`:
- `namespace(server, tool) → "mcp__<server>__<tool>"`
- `parse(namespaced) → { server, tool }` (reject ambiguous names with unexpected `__` content; always split on first `__`, second `__` — Claude Code's exact parsing rule).
- Validate server name matches `/^[a-z0-9-]+$/` at config load time; reject `__` in server or tool names.

### Shell commands

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine
bun add eventsource@^2
bun run typecheck
bun run test engine/src/mcp
bun run lint
```

### Expected output

- HTTP echo fixture: `listTools()` returns `echo`; `callTool("mcp__http-echo__echo", {msg:"hi"})` returns `{msg:"hi"}`.
- SSE fixture: same, routed through SSE transport.
- OAuth test: spins up mock authorization server, performs full PKCE round trip, tokens stored at a temp path with mode 0600.
- Reading a token file with mode 0644 throws.

### Tests to add

- `client-http.test.ts` — happy path + 401 triggers reauth (mock 401 on first call).
- `client-sse.test.ts` — SSE transport + reconnect on stream close.
- `namespacing.test.ts` — round-trip, invalid name rejection.
- `oauth.test.ts` — full PKCE flow against mock provider; state mismatch rejected; verifier matches challenge (test the crypto); callback port conflict errors.
- `token-store.test.ts` — world-readable refusal, atomic write, refresh path.

### Verification

```bash
bun run test engine/src/mcp   # expect: all green
bun run typecheck
bun run lint

# Manual OAuth smoke (no real provider wired yet — just confirm listener + browser open):
bun run tsx engine/scripts/mcp-oauth-demo.ts --server github
# expect: prints "opening browser to https://..."; listens on 127.0.0.1:47419
```

### Common pitfalls

- StreamableHTTP vs SSE: the MCP spec (2025) deprecates SSE-only in favor of unified StreamableHTTP with optional SSE upgrade. Support both; detect which the server speaks via initial handshake.
- OAuth state parameter: must be cryptographically random per request; never reuse. Reject callbacks whose state doesn't match.
- PKCE verifier: use `crypto.randomBytes(48).toString('base64url').slice(0,64)` — NOT `Math.random`.
- Callback listener: bind `127.0.0.1` **only**; never `0.0.0.0`. Shut it down immediately after receiving the code — don't leave a port open.
- On macOS/Linux, `open` the URL; if no DISPLAY (headless), just print the URL and poll — don't hang forever.
- Token file mode check: compare `stat.mode & 0o077 === 0`; don't just check 0o600 literal — symlinks / remote FS can have quirks.
- Fetch in Node 20+ is global; don't import `node-fetch` unless you need it for streaming quirks.
- SSE fixture: `eventsource` v2 API is event-emitter; remember to `close()` on teardown.
- Do not log Authorization headers. Ever.

<!-- BEGIN: paste from /Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/COMPLETION-UPDATE-TEMPLATE.md -->
<!-- On success: 07.02 ✅, next prompt = prompts/phase-07/03-playwright-mcp-integration.md. -->
<!-- END paste -->
