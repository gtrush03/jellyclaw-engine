# Built-in tools

jellyclaw ships a minimal set of built-in tools that mirror Claude Code's
published schemas byte-for-byte. Everything else (search, notebooks, exotic
integrations) is expected to arrive via MCP.

## WebFetch

`WebFetch` fetches a public URL over HTTP(S) and returns its content, with
HTML auto-converted to Markdown. It is the jellyclaw equivalent of Claude
Code's built-in `WebFetch`.

### Input schema

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "url":    { "type": "string", "format": "uri" },
    "prompt": { "type": "string" }
  },
  "required": ["url", "prompt"]
}
```

The `prompt` field is required for schema parity with Claude Code but the
jellyclaw built-in does **not** invoke a model — the prompt is logged at
`debug` and otherwise ignored. Consumers that want summarization should pipe
the returned content through their own LLM call.

### SSRF guarantees

Before every request (and every redirect hop) the target hostname is
resolved via `dns.lookup` (or parsed as a literal IP) and each resolved
address is matched against a blocklist:

- **IPv4** — `private` (RFC1918), `linkLocal` (169.254/16), `loopback`
  (127/8), `multicast`, `broadcast`, `carrierGradeNat`, `unspecified`,
  `reserved`.
- **IPv6** — `linkLocal` (fe80::/10), `uniqueLocal` (fc00::/7),
  `loopback` (::1), `multicast`, `unspecified`, `reserved`, and the
  various tunnel/transition ranges (`rfc6145`, `rfc6052`, `6to4`,
  `teredo`). IPv4-mapped addresses (`::ffff:a.b.c.d`) are unwrapped and
  the embedded v4 is re-checked.

Matches throw `SsrfBlockedError` with the offending URL, IP, and label.

**Allowlist override.** The permission key `webfetch.localhost` (surfaced
through `ctx.permissions.isAllowed`) bypasses SSRF **for the `loopback`
category only**. RFC1918 / link-local / ULA / multicast are never
skippable — this is intentional and enforced in code.

### Caps

- **Body size:** 10 MB. Enforced by a streaming counter; `content-length`
  is not trusted.
- **Timeout:** 30 s (`headersTimeout` + `bodyTimeout`).
- **Redirects:** 5 hops max. Each hop re-runs the protocol + SSRF preflight.

### Content-type dispatch

| Content-Type                                     | Handling                           |
| ------------------------------------------------ | ---------------------------------- |
| `text/html`                                      | Converted to Markdown via Turndown |
| `text/plain`, `text/markdown`, `text/x-markdown` | Returned as-is (UTF-8)             |
| `application/json`, `application/ld+json`, `*+json` | Returned as-is (UTF-8)          |
| `application/xml`, `text/xml`, `*+xml`           | Returned as-is (UTF-8)             |
| anything else                                    | `ToolError("UnsupportedContentType")` |

### Header policy

Only two headers are sent outbound: `User-Agent`
(`jellyclaw/0.x (+https://github.com/gtrush03/jellyclaw-engine)`) and a
fixed `Accept`. `Authorization`, `Cookie`, and `Proxy-Authorization` are
**never** forwarded — not on the initial request, not on any redirect hop.
This keeps ambient credentials out of arbitrary URLs the model chooses to
visit.

### Future MCP path

Like WebSearch, the built-in will eventually defer to any MCP-provided
fetcher of the same name at resolve time (Phase 10). Until then, the
built-in is the only path; pair it with a user-configured WebSearch MCP
for a complete research flow.

## WebSearch

`WebSearch` is registered as a **stub**. Calling it unconditionally throws
`WebSearchNotConfiguredError`. The model receives a structured, actionable
error telling it to configure a search MCP — it will not silently degrade.

### Why a stub?

jellyclaw is embeddable and vendor-neutral. Bundling a specific search
provider (Brave, Tavily, Serper, …) would pick a winner, add a
hard-to-audit network dependency, and bloat the install surface. We leave
the choice to the consumer: wire whichever search MCP you trust in your
`jellyclaw.json`, and its `search`/`web_search` tool will shadow this
stub at resolve time.

### Wiring a real search via MCP

Example — Tavily:

```json
{
  "mcp": {
    "tavily": {
      "command": "npx",
      "args": ["-y", "tavily-mcp"],
      "env": { "TAVILY_API_KEY": "tvly-..." }
    }
  }
}
```

The future MCP-backed `WebSearch` resolution (Phase 10) will prefer the
MCP-provided tool over this built-in stub. Until then, any call to the
built-in will throw `WebSearchNotConfiguredError` with a pointer to this
section.

### Silencing the registration warning

The engine emits a one-time logger warning when the WebSearch stub is
registered. Set `JELLYCLAW_WARN_WEBSEARCH=false` in the process
environment to suppress it (useful for library consumers that knowingly
ship without search).
