# Phase 04 — Tool parity — Prompt 04: WebFetch + WebSearch

**When to run:** After Phase 04 Prompt 03 (`03-glob-grep.md`) is committed.
**Estimated duration:** 3-4 hours
**New session?** Yes (always start a fresh Claude Code session for each prompt)
**Model:** Claude Opus 4.6 (1M context)

<!-- BEGIN SESSION STARTUP -->
Read and follow the full contents of `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/STARTUP-TEMPLATE.md` before doing anything else.

Substitutions for this session:
- `<NN>` → `04`
- `<phase-name>` → `Tool parity`
- `<sub-prompt>` → `04-webfetch-websearch`
<!-- END SESSION STARTUP -->

## Task

Implement `WebFetch` with SSRF protections and a Markdown-converted response, and `WebSearch` as a stub that errors with a clear "configure a search MCP" message (per `phases/PHASE-04-tool-parity.md`). Unit tests for both. Do not mark Phase 04 complete.

### Context

`engine/SPEC.md` §14 mandates SSRF protection: WebFetch respects a denylist of localhost, link-local, and RFC1918 unless explicitly allowed. `phases/PHASE-04-tool-parity.md` states WebSearch can be a stub for MVP. Use `undici` for fetch (already pinned in SPEC §15-adjacent).

### Steps

1. Fetch schemas via `context7`: WebFetch, WebSearch. Save fixtures.
2. Add dep if not present: `undici@^6`. Add `turndown` (HTML → Markdown).
3. Implement `engine/src/tools/webfetch.ts`:
   - Input schema: `{ url: string, prompt: string }` (Claude Code's schema).
   - Validate URL: must be `http:` or `https:`. Reject `file:`, `data:`, `javascript:`, `gopher:`, etc.
   - SSRF denylist: after DNS resolution, reject any IP in `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `::1`, `fc00::/7`, `fe80::/10`. Use `dns.promises.lookup` with `{ all: true }` then check each resolved address. If ANY resolved address is in the denylist, refuse.
   - Allowlist override via `config.webfetch.allowLocalhost: true` (Zod-extend config schema; reject unless this flag set).
   - Fetch with `undici` respecting `AbortSignal` from `ctx.abort`. Timeout 30s default.
   - Max response size: 10MB. Stream and count; abort on overflow.
   - Follow redirects: max 5. Re-check SSRF on each redirect target (TOCTOU!).
   - Content-type handling:
     - `text/html` → convert with `turndown` to Markdown, return `{ content: md, final_url, content_type }`.
     - `text/plain`, `text/markdown`, `application/json` → return as-is.
     - Other → return `{ error: "unsupported content-type", content_type }`.
   - Do NOT invoke the model with `prompt` — per Claude Code semantics, `prompt` is a hint for the calling model; we just return the fetched content. Record `prompt` in the telemetry payload but otherwise ignore.
   - Strip cookies + auth headers from outgoing request. Never pass `Authorization` through.
   - User-Agent: `jellyclaw/0.x (+https://github.com/gtrush03/jellyclaw-engine)`.
4. Implement `engine/src/tools/websearch.ts`:
   - Input schema: `{ query: string, allowed_domains?: string[], blocked_domains?: string[] }`.
   - Handler always throws `WebSearchNotConfigured` with message:
     > "WebSearch is not built into jellyclaw. Configure a search MCP (e.g. @modelcontextprotocol/server-brave-search, tavily-mcp) in your jellyclaw.json `mcp` map. See docs/tools.md#websearch."
   - Register the tool so schemas are discoverable; emit a one-time logger warning at registration if `process.env.JELLYCLAW_WARN_WEBSEARCH !== "false"`.
5. Register both in `engine/src/tools/index.ts`.
6. Author `test/unit/tools/webfetch.test.ts`:
   - Happy path: Vitest `http.createServer` returns HTML → Markdown conversion correct.
   - SSRF: `http://127.0.0.1:8080` rejected. `http://localhost` rejected. `http://169.254.169.254/` (AWS metadata) rejected. `http://10.0.0.1` rejected. An attacker DNS record resolving to `127.0.0.1` (simulate via `dns` mock) rejected.
   - Redirect SSRF: initial URL is public but 302 redirects to `http://127.0.0.1` — rejected.
   - Non-http(s) protocol rejected.
   - Response size overflow: server streams 11MB → aborted, error returned.
   - Cookie/Authorization: assert outgoing request headers via test server; none of those keys present.
   - Allowlist override: with `config.webfetch.allowLocalhost: true`, localhost succeeds.
7. Author `test/unit/tools/websearch.test.ts`:
   - Always throws `WebSearchNotConfigured`.
   - Message includes MCP configuration hint.
   - Registration emits warning once per process (stub the logger).
8. Author `docs/tools.md` section for WebFetch (SSRF guarantees, size limits, content-types) and WebSearch (MCP pointer).
9. Run `bun run --filter @jellyclaw/engine test`. All green.

### Files to create/modify

- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/tools/webfetch.ts`
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/tools/websearch.ts`
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/tools/index.ts` — register both.
- `/Users/gtrush/Downloads/jellyclaw-engine/test/unit/tools/{webfetch,websearch}.test.ts`
- `/Users/gtrush/Downloads/jellyclaw-engine/test/fixtures/tools/claude-code-schemas/{webfetch,websearch}.json`
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/package.json` — `turndown` (+ `undici` if not already).
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/config/schema.ts` — add `webfetch.allowLocalhost`.
- `/Users/gtrush/Downloads/jellyclaw-engine/docs/tools.md` — WebFetch + WebSearch sections.

### Verification

- Unit tests green including all SSRF variants.
- Manual: `WebFetch({ url: "https://example.com", prompt: "summarize" })` returns a Markdown-ish body with the "Example Domain" heading.
- `WebSearch({ query: "test" })` throws `WebSearchNotConfigured`.

### Common pitfalls

- **TOCTOU on DNS.** The IP we resolve before the request may differ from the IP `fetch` connects to. Mitigation: resolve up-front, then use `undici.Agent` with a pre-resolved `connect` that forces that IP. This is finicky; at minimum, resolve pre-flight AND re-resolve on every redirect.
- **IPv6 coverage gaps.** `::1`, `fe80::/10`, `fc00::/7` must all be checked. Use a reliable IP library (`ipaddr.js`).
- **Following redirects to file:// or ftp://.** Explicitly reject non-http(s) on redirect targets.
- **Max size bypass via chunked transfer encoding.** Count bytes as you stream; abort on overflow regardless of `Content-Length` headers.
- **Turndown losing code blocks.** Configure Turndown with GFM support; test on a Markdown-heavy page.
- **Accidentally registering WebSearch with a working handler later.** When a future phase adds MCP-backed search, it should shadow (not overwrite) the stub — document that.
- **Forgetting the `prompt` field.** Claude Code's schema requires it. Do not drop it.

<!-- BEGIN SESSION CLOSEOUT -->
Read and follow the full contents of `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/COMPLETION-UPDATE-TEMPLATE.md`.

Substitutions for this session:
- `<NN>` → `04`
- `<phase-name>` → `Tool parity`
- `<sub-prompt>` → `04-webfetch-websearch`
- Do NOT mark Phase 04 complete. Append a session-log row.
<!-- END SESSION CLOSEOUT -->
