# Built-in tools

jellyclaw ships **10 built-in tools** that mirror Claude Code's published
schemas byte-for-byte (see `test/fixtures/tools/claude-code-schemas/`). The
parity suite at `test/unit/tools/parity.test.ts` enforces this on every
test run; the `parity-allowed-drift.json` file is the only legitimate
escape hatch and currently lists zero deviations.

Each tool overrides its OpenCode counterpart of the same name (i.e. the
jellyclaw implementation wins inside an OpenCode session).

## Tool matrix

| Tool           | Claude Code | OpenCode | jellyclaw                    | Notes                                                         |
| -------------- | :---------: | :------: | :--------------------------: | ------------------------------------------------------------- |
| `Bash`         | ✅          | ✅       | ✅ override                  | env scrub, blocklist, background mode, `~/.jellyclaw/bash-bg` |
| `Read`         | ✅          | ✅       | ✅ override                  | text + ipynb + PDF (pdfjs-dist) + image dispatch              |
| `Write`        | ✅          | ✅       | ✅ override                  | atomic rename, read-before-overwrite, EOF newline preserved   |
| `Edit`         | ✅          | ✅       | ✅ override                  | unique-match invariant, replace_all, 6-line diff preview      |
| `Glob`         | ✅          | ✅       | ✅ override                  | tinyglobby, `.gitignore` filter, mtime-desc sort              |
| `Grep`         | ✅          | ✅       | ✅ override                  | `@vscode/ripgrep` via `spawn(argv)` (never shell)             |
| `WebFetch`     | ✅          | ✅       | ✅ override                  | undici, SSRF preflight, per-hop redirect re-check, 10MB cap   |
| `WebSearch`    | ✅          | ➖       | ✅ via MCP                   | Provided by the default Exa MCP. Set `EXA_API_KEY` to enable. |
| `TodoWrite`    | ✅          | ✅       | ✅ override                  | full-list replace, single in_progress invariant               |
| `Task`         | ✅          | ✅       | 🟡 stub                      | dispatch surface wired; real subagent engine lands Phase 06   |
| `NotebookEdit` | ✅          | ✅       | ✅ override                  | nbformat v4, replace/insert/delete, output preservation       |

Legend: ✅ = full implementation, 🟡 = stub (fails loudly with hint), ➖ = not present.

## WebSearch

**Provided by the default Exa MCP.** Set `EXA_API_KEY` in your environment to
enable. When the env var is present, jellyclaw automatically loads the Exa MCP
at startup and the model gets access to `mcp__exa__web_search_exa`. When the
env var is absent, no WebSearch capability is advertised — clean silent skip,
no error.

Get an API key at https://dashboard.exa.ai/api-keys.

## TodoWrite

`TodoWrite` replaces the session-scoped todo list. It is **not** a delta tool —
the model sends the full list on every call. Exactly one todo may be
`in_progress` at a time; violating this raises `MultipleInProgressError`.

The handler delegates to `ctx.session.update({ todos })`, which the engine
session writer turns into a jellyclaw `session.update` event so consumers
(Genie, the desktop shell, etc.) see todo state changes in their event
stream.

### Input schema

```json
{
  "todos": [
    { "content": "do the thing", "status": "in_progress", "activeForm": "doing the thing", "id": "t1" }
  ]
}
```

`status` ∈ `pending | in_progress | completed | cancelled`.

## Task

`Task` is the dispatch tool for subagents. **Phase 04 ships only the schema
and a stub dispatcher.** The real subagent engine — child OpenCode session,
event-stream pumping, summary roll-up — lands in Phase 06.

Calling `Task` today returns `SubagentsNotImplementedError` (with a clear
"Phase 06 required" hint) unless a real `SubagentService` is wired into
`ctx.subagents`. The stub at `engine/src/subagents/stub.ts` makes the
failure mode explicit so downstream code doesn't silently no-op.

### Input schema

```json
{
  "description": "find auth bug",
  "prompt": "Investigate /api/auth and report the failure mode in <100 words.",
  "subagent_type": "general-purpose"
}
```

## NotebookEdit

`NotebookEdit` edits a Jupyter notebook (`.ipynb`, `nbformat: 4`) cell.
Three edit modes:

- `replace` — replaces a cell's `source`. Outputs and `execution_count`
  are **preserved** unless `clear_outputs: true`. Changing `cell_type`
  resets both.
- `insert` — inserts a new cell after the located cell, or at the end if
  no locator is given. Requires `cell_type` and `new_source`.
- `delete` — removes the located cell.

Locators: `cell_id` (preferred — stable across edits) or `cell_number`
(0-indexed). The notebook must have been Read in this session
(`NotebookEditRequiresReadError` otherwise — same invariant as Write/Edit).

Writes are atomic via `<path>.jellyclaw.tmp` → `renameSync`.

### Input schema

```json
{
  "notebook_path": "/abs/path.ipynb",
  "cell_id": "abc123",
  "edit_mode": "replace",
  "new_source": "print('hi')",
  "clear_outputs": false
}
```

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
