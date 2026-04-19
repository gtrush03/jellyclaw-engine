# Phase 08 Hosting — Prompt T5-01: HTTP/SSE MCP transport (the #1 blocker)

**When to run:** First prompt in Phase 08. Before anything else in the hosting tier.
**Estimated duration:** 2–3 hours
**New session?** Yes.
**Model:** Claude Opus 4.6 (1M context).

## Context

Phase 07.5 shipped stdio MCP + Chrome autolaunch. Agent 4's `docs/hosting/04-browser-in-cloud.md` picked Browserbase as the cloud browser; Browserbase is a **remote MCP server** reached at `https://mcp.browserbase.com/mcp` over Streamable-HTTP. Exa (WebSearch parity, T5-02) is the same — `https://mcp.exa.ai/mcp`. Today jellyclaw's `registry.ts` dispatches `case "http"` / `case "sse"` into `createHttpMcpClient` / `createSseMcpClient` and those client files already exist — but until we actually smoke-test a real remote MCP and close the round-trip (tools registered, callTool wired, auth headers forwarded), the cloud path is an untested stub. Agent 4 flagged this as "the #1 blocker — ~150 LOC fix unblocks Exa + Browserbase + every cloud MCP." This prompt closes it.

The scope is:

1. Audit `engine/src/mcp/client-http.ts` + `client-sse.ts` against the SDK's `StreamableHTTPClientTransport` and `SSEClientTransport` — confirm correct constructor usage, header forwarding, and `listTools` wiring. Fix anything that diverges.
2. Make sure `headers: { "Authorization": "Bearer ..." }` from user config flows through to the transport (for Browserbase `x-bb-api-key` and Exa `Authorization: Bearer` paths).
3. Add a unit test at `engine/src/mcp/registry.http.test.ts` that exercises the http transport via the registry DI seam (mock client factory, no network) — proves registry + http path compose cleanly and tools surface to `listTools()`.
4. Smoke-test the live Exa HTTP MCP end-to-end (real network) in the verification section.
5. Confirm stdio still works (regression).

## Research task

1. Read `engine/src/mcp/registry.ts:54-72` — the `defaultClientFactory` transport switch. Confirm http/sse arms dispatch to their clients.
2. Read `engine/src/mcp/types.ts:88-98` — `HttpMcpServerConfig` / `SseMcpServerConfig` shapes. `headers` is `Readonly<Record<string,string>>`, `oauth` is optional.
3. Read `engine/src/mcp/client-http.ts` in full. Line 95-101 constructs `StreamableHTTPClientTransport`. Line 96 sets `requestInit: { headers: { ...this.config.headers } }`. Verify this is how the SDK actually forwards per-request headers — check `@modelcontextprotocol/sdk` types under `node_modules/@modelcontextprotocol/sdk/client/streamableHttp.d.ts`.
4. Read `engine/src/mcp/client-sse.ts` in full. Lines 145-151 mirror the http transport for SSE.
5. Read `engine/src/mcp/registry.test.ts` — you're modelling the new `registry.http.test.ts` after this structure (DI the factory, skip the network).
6. Read `engine/src/cli/mcp-config-loader.ts` — confirms how an http config lands in the registry. A config like `{"transport":"http","name":"exa","url":"https://mcp.exa.ai/mcp","headers":{"Authorization":"Bearer ..."}}` must round-trip through the loader without schema-breaking.
7. Re-read `docs/hosting/04-browser-in-cloud.md` § "Chosen architecture in detail" for Browserbase's MCP usage model (the final topology we're unblocking).
8. Look up `StreamableHTTPClientTransport`'s `requestInit` vs `fetch` constructor options — confirm header forwarding across initial POST + SSE upgrade.

## Implementation task

Scope: audit + harden the existing http/sse clients so remote MCP works end-to-end, add the missing unit test, update the default MCP template to demonstrate http transport, and verify with a real Exa smoke. No new client files. No new transport cases — the registry already dispatches all three.

### Files to create / modify

- `engine/src/mcp/client-http.ts` — AUDIT; fix any header-forwarding regression; confirm `StreamableHTTPClientTransport` constructor is current.
- `engine/src/mcp/client-sse.ts` — AUDIT; same for `SSEClientTransport`; confirm `requestInit.headers` flows to both initial GET and POST phases.
- `engine/src/mcp/registry.http.test.ts` — **new.** DI the factory, assert registry composes an http config into `listTools()` output.
- `engine/src/mcp/registry.sse.test.ts` — **new.** Same for sse.
- `engine/templates/mcp.default.json` — add a disabled Exa http entry as a demo (keep `_disabled: true` until T5-02 flips it on).
- `docs/mcp.md` — Transports section: document `transport: "http"` and `transport: "sse"` with header forwarding examples.
- `COMPLETION-LOG.md` — append standard entry.

### Research-then-fix protocol

1. **Read both client files end-to-end.** Write a short audit note (inline as a code comment at the top of `client-http.ts`) listing every path that takes user input and where it surfaces in the outbound request. You'll need this for the header forwarding verification.

2. **Verify header forwarding in both phases.** For `StreamableHTTPClientTransport`:
   - Initial `client.connect(transport)` → SDK does a POST + switches to SSE on 200 — BOTH phases need the headers.
   - `requestInit.headers` is the documented path. If SDK version diverges (check `node_modules/@modelcontextprotocol/sdk/package.json`), adjust.
   - For SSE (`SSEClientTransport`), same path — `requestInit.headers` propagates.

3. **The header merge bug to watch for.** If `config.headers` is `undefined`, `{ ...this.config.headers }` spreads to `{}` which is fine. If it's `Readonly<Record<string,string>>`, the spread copies. But SDK internals may call `new Headers(requestInit.headers)` which lowercases keys — verify `Authorization` / `X-Api-Key` both surface on the wire with the case the server expects (case-insensitive HTTP spec, but some servers are picky).

4. **Unit test structure — `registry.http.test.ts`:**

```ts
import { describe, expect, it } from "vitest";
import { pino } from "pino";
import { McpRegistry } from "./registry.js";
import type { HttpMcpServerConfig, McpClient, McpTool } from "./types.js";

describe("McpRegistry + http transport", () => {
  it("composes an http config into listTools", async () => {
    const logger = pino({ level: "silent" });
    const fakeTools: McpTool[] = [
      {
        name: "web_search_exa",
        namespacedName: "mcp__exa__web_search_exa",
        inputSchema: { type: "object", properties: {} },
        server: "exa",
      },
    ];
    const fakeClient = makeFakeReadyClient("exa", fakeTools);
    const reg = new McpRegistry({
      logger,
      clientFactory: () => fakeClient,
    });
    const cfg: HttpMcpServerConfig = {
      transport: "http",
      name: "exa",
      url: "https://mcp.exa.ai/mcp",
      headers: { Authorization: "Bearer test-key" },
    };
    await reg.start([cfg]);
    expect(reg.listTools()).toHaveLength(1);
    expect(reg.listTools()[0]?.namespacedName).toBe("mcp__exa__web_search_exa");
    await reg.stop();
  });

  it("auth header placement — the factory receives the full config", async () => {
    // assert the factory sees `headers.Authorization` verbatim so the transport can forward it
    let received: HttpMcpServerConfig | null = null;
    const logger = pino({ level: "silent" });
    const reg = new McpRegistry({
      logger,
      clientFactory: (cfg) => {
        received = cfg as HttpMcpServerConfig;
        return makeFakeReadyClient("exa", []);
      },
    });
    await reg.start([{
      transport: "http",
      name: "exa",
      url: "https://mcp.exa.ai/mcp",
      headers: { Authorization: "Bearer sekret" },
    }]);
    expect(received?.headers?.["Authorization"]).toBe("Bearer sekret");
    await reg.stop();
  });
});

function makeFakeReadyClient(server: string, tools: McpTool[]): McpClient {
  // minimal stub — returns ready immediately, no real socket
  // (pattern already used in engine/src/mcp/registry.test.ts — mirror it)
}
```

5. **For the sse test** — same shape, `transport: "sse"`, different URL.

6. **Default template addition.** Append to `engine/templates/mcp.default.json`:

```json
{
  "_comment": "DISABLED — Exa WebSearch over HTTP MCP. Set EXA_API_KEY and flip _disabled to false. T5-02 makes this the default.",
  "_disabled": true,
  "transport": "http",
  "name": "exa",
  "url": "https://mcp.exa.ai/mcp",
  "headers": { "Authorization": "Bearer ${EXA_API_KEY}" }
}
```

(Env-var substitution syntax follows whatever `mcp-config-loader.ts` already supports — check it first. If it doesn't support `${VAR}` expansion, file a note in the doc but leave a literal placeholder.)

### Shell commands

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine
bun run typecheck
bun run test engine/src/mcp/registry.http.test.ts
bun run test engine/src/mcp/registry.sse.test.ts
bun run test engine/src/mcp/                  # regression sweep
bun run lint
bun run build

# Live smoke — Exa HTTP MCP (requires EXA_API_KEY from https://dashboard.exa.ai/api-keys)
# Ships skipped if EXA_API_KEY is unset — the prompt does NOT fail without the key,
# but with the key present the round-trip must succeed.
if [ -n "$EXA_API_KEY" ]; then
  TMP_CFG=$(mktemp -d)/jellyclaw.json
  cat > "$TMP_CFG" <<EOF
{
  "mcp": [{
    "transport": "http",
    "name": "exa",
    "url": "https://mcp.exa.ai/mcp",
    "headers": { "Authorization": "Bearer $EXA_API_KEY" }
  }]
}
EOF
  HOME_OVERRIDE=$(mktemp -d)
  cp "$TMP_CFG" "$HOME_OVERRIDE/jellyclaw.json"
  cd "$HOME_OVERRIDE"
  echo "search exa for 'anthropic claude pricing' and show top 3 results" | \
    /Users/gtrush/Downloads/jellyclaw-engine/engine/bin/jellyclaw run \
      --output-format stream-json --permission-mode bypassPermissions --max-turns 4 2>&1 | \
    grep -E "mcp:|exa|web_search" | head -20
  # Expect: "mcp: started 1 server(s)" + "mcp: connected server=exa tools=N"
  # AND: at least one tool_use for mcp__exa__web_search_exa in the stream
else
  echo "SKIP: EXA_API_KEY unset — live smoke skipped (unit tests still must pass)"
fi

# Stdio regression (no Chrome needed — uses the echo test server)
echo "call the echo MCP tool with message=hello" | \
  /Users/gtrush/Downloads/jellyclaw-engine/engine/bin/jellyclaw run \
    --output-format stream-json --permission-mode bypassPermissions --max-turns 3 2>&1 | \
  grep -E "mcp:|echo" | head -10
```

### Expected output

- `bun run test engine/src/mcp/` — all green, including both new test files.
- Unit tests prove: (a) http config round-trips the registry, (b) sse config round-trips, (c) auth headers reach the factory verbatim.
- Live Exa smoke (if `EXA_API_KEY` set) emits `mcp: connected server=exa` + registers `mcp__exa__web_search_exa` + the tool actually returns search results in the event stream.
- Stdio echo smoke still passes — zero regression on Phase 07.5 stdio path.
- `engine/templates/mcp.default.json` ships with the disabled Exa entry ready for T5-02 to flip.

### Tests to add

- `engine/src/mcp/registry.http.test.ts`:
  - http config → `listTools()` returns namespaced tools
  - factory receives `headers.Authorization` verbatim
  - empty config array → empty `listTools`
  - dead http client → marked `dead`, scheduled for retry (mirror the stdio test pattern)
- `engine/src/mcp/registry.sse.test.ts`:
  - sse config → `listTools()` returns namespaced tools
  - factory receives `headers["X-Api-Key"]` verbatim (case-sensitive spread check)

### Common pitfalls

- **Don't rewrite the clients.** The audit may turn up zero bugs — that's fine. The DELIVERABLE is proof via test + smoke, not diff size.
- **`requestInit.headers` merge semantics.** If the SDK does a `new Headers(...)` internally and your config uses a `Record`, mixed-case keys (`Authorization` vs `authorization`) get normalized — usually fine, but ADD a test asserting the factory sees the config verbatim. Downstream normalization is the SDK's problem.
- **OAuth path is optional.** `config.oauth` may be undefined; both clients handle that already. Don't require OAuth for Browserbase/Exa — they use static bearer tokens in the `headers` map.
- **Don't leak the API key in error messages.** Both clients already wire `buildCredentialScrubber(Object.values(config.headers ?? {}))` — verify this path survives any refactor. Unit-test it: connect failure with a bogus key should NOT surface the key in the thrown error.
- **Streamable-HTTP vs legacy SSE.** Streamable-HTTP (`client-http.ts`, `https://mcp.exa.ai/mcp`) is the 2025 unified transport — one URL handles both POST and SSE upgrades. Legacy SSE (`client-sse.ts`) uses a separate `/sse` path and is deprecated. Exa + Browserbase use Streamable-HTTP — that's the hot path. SSE remains because a few legacy servers still speak it.
- **Fly egress caveat (informational).** When hosted jellyclaw runs on Fly (Agent 1's design), outbound https to `mcp.exa.ai` / `mcp.browserbase.com` egresses Fly's shared public IPs. No allowlist required today. Flag only if a future MCP provider requires static egress IP.
- **Registry retry for dead http clients.** If Exa is down at `start()`, the client transitions to `dead` and the registry schedules a 30s retry — this behavior already exists for stdio; confirm it also fires for the new transports. Add a `registry.http.test.ts` case for it.

## Closeout

1. Update `COMPLETION-LOG.md` with `08.T5-01 ✅` — include the registry test count, Exa smoke result (DONE or SKIPPED), and file counts (N created, M modified).
2. Print `DONE: T5-01`.

On fatal failure: `FAIL: T5-01 <reason>`.
