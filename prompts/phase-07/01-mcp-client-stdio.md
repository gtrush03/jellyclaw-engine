# Phase 07 — MCP client integration — Prompt 01: stdio MCP client

**When to run:** After Phase 06 is fully ✅ in `COMPLETION-LOG.md`.
**Estimated duration:** 3–4 hours
**New session?** Yes — always start a fresh Claude Code session per prompt
**Model:** Claude Opus 4.6 (1M context)

<!-- BEGIN: paste from /Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/STARTUP-TEMPLATE.md -->
<!-- STOP if Phase 06 not ✅. -->
<!-- END paste -->

## Research task

1. Read `/Users/gtrush/Downloads/jellyclaw-engine/phases/PHASE-07-mcp.md` end-to-end.
2. Read `/Users/gtrush/Downloads/jellyclaw-engine/engine/SPEC.md` — MCP section.
3. Read `/Users/gtrush/Downloads/jellyclaw-engine/engine/SECURITY.md` — MCP credential handling (credentials must NEVER be written to logs, stream transcripts, or hook audit logs).
4. Read `/Users/gtrush/Downloads/jellyclaw-engine/engine/PROVIDER-STRATEGY.md` — connection retry philosophy should align.
5. Use context7 to fetch current `@modelcontextprotocol/sdk` TypeScript SDK docs (query: "modelcontextprotocol typescript SDK stdio client transport"). Read the actual SDK types — the API has churned; do not rely on memory. Note:
   - Transport class name for stdio
   - How to await connection / tool list
   - Reconnect pattern (if any is idiomatic)
6. Read the Phase 02 config loader — the MCP server config shape is defined there. If prompt 02 of Phase 07 needs to extend the schema, note the extension point here but don't implement it.

## Implementation task

Implement a **stdio** MCP client factory: spawn a child process, speak JSON-RPC 2.0 over stdio via `@modelcontextprotocol/sdk`, expose tool list, and auto-reconnect on unexpected exit. HTTP/SSE transports are prompt 02; Playwright wiring is prompt 03.

### Files to create/modify

- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/mcp/types.ts` — `McpServerConfig`, `McpClient`, `McpTool`, `McpTransport`.
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/mcp/client-stdio.ts` — stdio client factory.
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/mcp/registry.ts` — manages all MCP clients; parallel connect with 10 s timeout; failures warn, do not crash.
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/mcp/credential-strip.ts` — strips matching env var values from any string (for log scrubbing); used on all stderr/stdout from the child.
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/mcp/index.ts` — barrel.
- Tests: `client-stdio.test.ts`, `registry.test.ts`, `credential-strip.test.ts`.
- Fixture: `/Users/gtrush/Downloads/jellyclaw-engine/test/fixtures/mcp/echo-server.ts` — a trivial stdio MCP server exposing an `echo` tool. Runnable standalone via `bun run test/fixtures/mcp/echo-server.ts`.
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/package.json` — add `@modelcontextprotocol/sdk@^1`.

### Client semantics

- **Connect:** spawn via `child_process.spawn(cmd, args, { env, stdio: ["pipe","pipe","pipe"] })`. Wrap with the SDK's StdioClientTransport.
- **Initialize:** call `client.initialize()` with jellyclaw's client info (name="jellyclaw-engine", version from `package.json`).
- **List tools:** on connect, `listTools()`. Expose `client.tools: McpTool[]`.
- **Reconnect:** on `exit` event with unexpected code, attempt reconnect with exponential backoff: 500 ms, 1 s, 2 s, 4 s, 8 s, give up after 5 tries and mark client `dead`. Emit `mcp.disconnected` / `mcp.reconnected` events.
- **Dedicated event loop:** wrap all SDK calls inside a single async loop per client so we never interleave JSON-RPC requests mid-message. Use a `Promise` queue (serial awaits), not raw concurrency.
- **Credential stripping:** read MCP server config's `env` field; any *value* present there is a secret. Any stderr line, any log string that mentions the raw value must be replaced with `[REDACTED]` before logging. Test this.

### Registry semantics

- `McpRegistry.start(configs)` connects every server in parallel via `Promise.allSettled` with a 10 s per-connection timeout.
- Failed connections log `warn` with server name + reason and are retried in the background (every 30 s) until success or shutdown.
- `registry.listTools()` returns all live tools, each namespaced `mcp__<server>__<tool>` (namespacing logic is shared with prompt 02 but implement once here).
- `registry.callTool(namespacedName, input)` routes to the correct client; returns the raw MCP result.
- `registry.stop()` cleanly disconnects all clients, killing child processes with SIGTERM → SIGKILL after 3 s.

### Shell commands

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine
bun add @modelcontextprotocol/sdk@^1
bun run typecheck
bun run test engine/src/mcp
bun run lint
```

### Expected output

- All three test files pass.
- Integration test connects to echo-server fixture, lists the `echo` tool, calls it, gets the expected result.
- Unexpected child exit triggers reconnect within 1 s in the reconnect test.

### Tests to add

- `client-stdio.test.ts`:
  - Connect to echo-server fixture; assert `tools` contains `echo`.
  - Call `echo` with `{msg: "hi"}`; assert result `{msg: "hi"}`.
  - Kill child; assert reconnect within 2 s; tools re-listed.
  - Spawn failure (bogus command) → marked dead after retries; does not throw out of `start()`.
- `credential-strip.test.ts`:
  - Values from config `env` are redacted in stringified output.
  - Multiple values redacted independently.
  - No false positives on random text not matching a secret.
- `registry.test.ts`:
  - Two servers, one fails to start → registry reports 1 live, 1 dead.
  - `listTools()` namespaces correctly: `mcp__echo__echo`.
  - `callTool("mcp__unknown__x")` → error `unknown_server`.

### Verification

```bash
bun run test engine/src/mcp   # expect: green
bun run typecheck
bun run lint

# Smoke with real config
cat > ~/.jellyclaw/jellyclaw.json <<'EOF'
{
  "mcp": {
    "echo": {
      "transport": "stdio",
      "command": "bun",
      "args": ["run", "test/fixtures/mcp/echo-server.ts"]
    }
  }
}
EOF
bun run tsx engine/scripts/mcp-list.ts    # write the script if absent; prints live MCP tools
# expect: lists mcp__echo__echo
```

### Common pitfalls

- SDK API: the TypeScript SDK has breaking changes between minor versions — pin to an exact version and capture it in `package.json`; document in `CHANGELOG.md`.
- `child_process.spawn` with `stdio: "pipe"` returns streams — don't also set `shell: true` (injection risk).
- The StdioClientTransport expects line-delimited JSON-RPC; do NOT write to stdin from anywhere else.
- Credential stripping applies to `.stderr`, `.stdout`, errors thrown by the SDK (wrap the SDK in a try/catch and strip the message).
- Reconnect must not leak the previous subprocess; always `kill()` + `await exit` before respawning.
- Event loop ordering: use an internal `Promise` chain (`this.queue = this.queue.then(fn)`) to serialize; don't use a naive `Mutex` that could miss cancellation.
- Do not log the MCP server's `env` object — ever. Log only the server name.
- Use `import type` for MCP SDK types where possible; tree-shake runtime imports.
- Tests: always `await registry.stop()` in afterEach or you leak zombie children.

<!-- BEGIN: paste from /Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/COMPLETION-UPDATE-TEMPLATE.md -->
<!-- On success: 07.01 ✅, next prompt = prompts/phase-07/02-mcp-client-http-sse.md. -->
<!-- END paste -->
