# MCP (Model Context Protocol) clients

jellyclaw connects to MCP servers to extend the tool surface the model sees at
runtime. All tools advertised by a server are exposed to the model under the
`mcp__<server>__<tool>` namespace; the server prefix is unique per config entry,
making collisions impossible.

Three transports are supported (Phase 07):

| transport | status | when to use |
|-----------|--------|-------------|
| `stdio`   | ✅ stable | local subprocesses (the default; includes Playwright, filesystem tools, Git, etc.) |
| `http`    | ✅ stable | remote servers speaking the 2025 **StreamableHTTP** protocol |
| `sse`     | ⚠️ legacy | remote servers that only speak the pre-2025 SSE transport — prefer `http` when both are offered |

## Configuration

MCP servers live under `mcp[]` in `jellyclaw.json`. Each entry is a discriminated
union on `transport`.

```jsonc
{
  "mcp": [
    {
      "transport": "stdio",
      "name": "playwright",
      "command": "npx",
      "args": [
        "@playwright/mcp@0.0.41",
        "--browser", "chrome",
        "--cdp-endpoint", "http://127.0.0.1:9222"
      ],
      "env": {}
    },
    {
      "transport": "http",
      "name": "github",
      "url": "https://mcp.github.com/",
      "oauth": { "clientId": "your-client-id", "scope": "repo" }
    },
    {
      "transport": "sse",
      "name": "legacy-tool",
      "url": "https://example.test/mcp/sse",
      "headers": { "X-Api-Key": "<secret>" }
    }
  ]
}
```

Server `name` must match `/^[a-z0-9-]+$/` — it becomes the tool-namespace prefix,
and underscores would break round-trip parsing. The validator rejects
non-conforming names at config load.

## OAuth 2.1 + PKCE

HTTP and SSE servers may require OAuth. When `oauth` is set:

- The SDK handles discovery (`/.well-known/oauth-authorization-server`), PKCE
  verifier/challenge generation (S256), token refresh, and reconnect on 401.
- jellyclaw provides the persistence + the redirect listener:
  - **Token store:** `~/.jellyclaw/mcp-tokens.json` at mode `0600`. If the file
    ever has world or group read/write bits, jellyclaw refuses to load it and
    exits with a security error.
  - **Loopback callback listener:** `127.0.0.1:<callbackPort>` (default `47419`).
    Exactly one request is accepted — `/callback?code=...&state=...` — and the
    server is torn down immediately. Any other path returns 404; a mismatched
    state returns 400 and fails the flow with `OAuthStateMismatchError`.
  - **Browser:** jellyclaw spawns `open` (macOS), `xdg-open` (Linux), or
    `cmd /c start` (Windows) pointed at the authorize URL. The URL is also
    written to stderr so headless environments can copy-paste.

### Why `callbackPort` is fixed, not random

`redirect_uri` must match what you registered with the authorization server.
Changing it breaks the flow. If the port is already in use, jellyclaw errors
out with `OAuthCallbackPortInUseError` telling you to pick a free port and
re-register.

### `OAuthConfig` fields

| field | required | description |
|-------|----------|-------------|
| `clientId` | ✅ | OAuth client identifier registered with the AS |
| `scope` | — | space-separated scopes; omit for default |
| `authorizeUrl` | — | overrides the authorize endpoint (else discovered) |
| `tokenUrl` | — | overrides the token endpoint (else discovered) |
| `callbackPort` | — | defaults to `47419`; must match the registered `redirect_uri` |

## Lifecycle

`McpRegistry.start(configs)` connects every server in parallel via
`Promise.allSettled`. Failures log `warn` and schedule a background retry
(default every 30 s) — the engine starts regardless. `listTools()` returns only
tools from clients currently in the `ready` state.

`stop()` is idempotent. Stdio clients get `SIGTERM` → `SIGKILL` after a 3 s
grace. HTTP/SSE clients close through the SDK.

### Reconnect policy

- **stdio:** exponential backoff `[500, 1000, 2000, 4000, 8000]` ms × 5
  attempts, then `dead`. The registry separately retries `dead` servers every
  30 s by building a fresh client.
- **http:** StreamableHTTP reconnect is handled by the SDK.
- **sse:** same backoff schedule as stdio, but note the SDK limitation below.

### SDK limitation — SSE close detection

The SDK's `SSEClientTransport` (the deprecated path) **does not surface
server-side stream drops** through `onclose`. It only fires `onclose` from its
own `close()` method. A real upstream stream termination will not trigger the
client's reconnect loop — callers should prefer StreamableHTTP whenever the
server supports it. This is documented in `client-sse.test.ts` and will be
revisited if the SDK fixes the upstream behavior.

## Credential scrubbing

Values from `env` (stdio) and `headers` (http/sse) are treated as secrets. Any
occurrence of one of those values in stderr, in an SDK-thrown error message, in
a timeout message, or in a reconnect-failure reason is replaced with
`[REDACTED]` before it reaches the logger. The scrubber is built once per
client from `Object.values(config.env | config.headers)`.

The Authorization header created by the OAuth provider is NEVER logged — the
redact list in `engine/src/logger.ts` includes `headers.authorization` and
variants.

## Smoke test

```sh
# Minimal config:
cat > ~/.jellyclaw/jellyclaw.json <<'EOF'
{
  "mcp": [
    {
      "transport": "stdio",
      "name": "echo",
      "command": "bun",
      "args": ["run", "/absolute/path/to/test/fixtures/mcp/echo-server.ts"]
    }
  ]
}
EOF

bun run engine/scripts/mcp-list.ts
# mcp: 1 live, 0 dead, 0 retrying
# mcp__echo__echo
```

## Files

- `engine/src/mcp/types.ts` — `McpServerConfig` union + `McpClient` contract
- `engine/src/mcp/namespacing.ts` — `mcp__<server>__<tool>` helpers
- `engine/src/mcp/client-stdio.ts` — child-process transport
- `engine/src/mcp/client-http.ts` — StreamableHTTP transport
- `engine/src/mcp/client-sse.ts` — legacy SSE transport
- `engine/src/mcp/oauth.ts` — OAuthClientProvider + loopback callback listener
- `engine/src/mcp/token-store.ts` — 0600-mode token persistence
- `engine/src/mcp/credential-strip.ts` — stderr/error scrubber
- `engine/src/mcp/registry.ts` — parallel connect, background retry, namespaced routing
- `test/fixtures/mcp/{echo-server,http-echo,oauth-provider}.ts` — test doubles
