---
phase: 07
name: "MCP client integration"
duration: "1.5 days"
depends_on: [01, 02]
blocks: [11, 12]
---

# Phase 07 — MCP client integration

## Dream outcome

`jellyclaw.json` declares MCP servers (stdio, HTTP, SSE). On engine start, each server is connected, tools are auto-registered under `mcp__<server>__<tool>` namespace, and available to the model. Genie's existing `playwright-mcp@0.0.41` wired to CDP:9222 drops in unchanged via config — jellyclaw itself knows nothing about Chrome.

## Deliverables

- `engine/src/mcp/client.ts` — MCP client factory (stdio/HTTP/SSE)
- `engine/src/mcp/registry.ts` — connect all, expose merged tool list
- `engine/src/mcp/oauth.ts` — OAuth flow for HTTP MCP
- `engine/src/mcp/namespacing.ts` — `mcp__server__tool` collision resolution
- Integration test against a mock MCP server fixture
- `docs/mcp.md`

## Step-by-step

### Step 1 — MCP config schema (extend Phase 02)
```jsonc
{
  "mcp": {
    "playwright": {
      "transport": "stdio",
      "command": "npx",
      "args": ["@playwright/mcp@0.0.41", "--browser", "chrome", "--cdp-endpoint", "http://127.0.0.1:9222"],
      "env": {}
    },
    "github": {
      "transport": "http",
      "url": "https://mcp.github.com/",
      "oauth": { "clientId": "...", "scope": "repo" }
    }
  }
}
```

### Step 2 — Client
Use `@modelcontextprotocol/sdk`. Per transport:
- **stdio** → `child_process.spawn` + JSON-RPC over stdio.
- **http** → fetch-based, bearer token.
- **sse** → EventSource with reconnect.

### Step 3 — Registry
On start, connect all servers in parallel with timeout 10 s. Log failures but do not block engine start (servers optional). Expose `listTools()` merged + namespaced.

### Step 4 — Namespacing
Tool exposed to model = `mcp__<server>__<tool>`. Collisions impossible because server prefix unique.

### Step 5 — OAuth flow
For HTTP MCP requiring OAuth:
1. On first use, open browser to `authorize_url`.
2. Listen on `http://127.0.0.1:<port>/callback`.
3. Exchange code → token, store in `~/.jellyclaw/mcp-tokens.json` (mode 0600).
4. Refresh on 401.

### Step 6 — Playwright sanity test
With Chrome running with `--remote-debugging-port=9222`, configure the `playwright` MCP, run `jellyclaw run "navigate to example.com and take a screenshot"`. Assert screenshot file exists.

### Step 7 — Mock MCP fixture
`test/fixtures/mcp/echo-server.ts` — trivial stdio MCP server exposing an `echo` tool. Used by integration tests without external dependencies.

## Acceptance criteria

- [ ] stdio, HTTP, SSE transports all connect in tests
- [ ] Tools auto-registered under `mcp__server__tool`
- [ ] OAuth flow completes end-to-end (manual test)
- [ ] Playwright MCP via CDP:9222 loads and executes a navigation
- [ ] Missing/failing server logs a warning but does not crash engine
- [ ] Tokens stored with mode 0600

## Risks + mitigations

- **MCP SDK API churn** → pin exact version; integration test locked.
- **Token file leakage** → enforce mode 0600 on write; check on load; refuse if world-readable.
- **Chrome not running** → detect CDP connection refused, emit friendly error naming the endpoint.

## Dependencies to install

```
@modelcontextprotocol/sdk@^1
eventsource@^2
```

## Files touched

- `engine/src/mcp/{client,registry,oauth,namespacing}.ts`
- `engine/src/mcp/*.test.ts`
- `test/fixtures/mcp/echo-server.ts`
- `docs/mcp.md`
