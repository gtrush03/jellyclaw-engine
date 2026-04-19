# Phase 08 Hosting — Prompt T6-02: Browserbase MCP integration

**When to run:** After T5-01 (HTTP MCP transport in `engine/src/mcp/registry.ts`) AND T6-01 (Dockerfile + fly.toml) have both landed. This tier adds config + auth plumbing; it does not add a new transport.
**Estimated duration:** 2–3 hours
**New session?** Yes.
**Model:** Claude Opus 4.6 (1M context).

## Context

Agent 4 (browser-in-cloud workstream) picked **Browserbase** as the alpha browser backend. It's a hosted MCP server at `https://mcp.browserbase.com/mcp` that jellyclaw can talk to over HTTP — no Chrome in our container, no Chromium profile storage, no CAPTCHA tooling. The design is fully written up in `docs/hosting/04-browser-in-cloud.md`; § 9 has the exact MCP config JSON.

Your job is to:

1. Add a **disabled-by-default** Browserbase entry to `engine/templates/mcp.default.json` next to the existing Playwright stanzas, so self-hosted users discover it and hosted users can uncomment it trivially.
2. Wire the three env vars (`BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID`, optionally a per-request `BROWSERBASE_CONTEXT_ID`) through jellyclaw's existing config + request plumbing so that when the stanza is enabled, Browserbase actually works.
3. Add an `x-browserbase-context` request header on `/v1/threads` (or whichever create endpoint T5 lands — read the code, don't assume) so a caller can pin a per-request Context ID. When set, jellyclaw injects it into the Browserbase MCP server's outgoing `X-Browserbase-Context-Id` header.
4. Document the end-to-end signup → Context → request flow in a new `docs/browserbase-setup.md`.

**Do not regress the Playwright MCP path.** Local users must still be able to run `scripts/jellyclaw-chrome.sh` and point jellyclaw at `--cdp-endpoint http://127.0.0.1:9333` exactly as they do today.

## Research task

1. Read `docs/hosting/04-browser-in-cloud.md` end-to-end, with special attention to:
   - § TL;DR (names the decision)
   - § Sample MCP config JSON per architecture — **§ Option C chosen** is your source JSON
   - § Per-tenant isolation model
   - § Known unknowns / things to verify before launch (items 1 and 7 — the Gemini key is not our problem for the hosted HTTP path)
2. Read `engine/templates/mcp.default.json`. Note the existing commented-out Playwright stanzas — Browserbase goes here, same `_disabled: true` + `_comment` convention.
3. Read `engine/src/mcp/types.ts`. Confirm that after T5-01 the config schema accepts `transport: "http"` with `url` + `headers` fields. If T5-01 is not landed (only `stdio` is accepted), STOP and emit `FAIL: T6-02 HTTP MCP transport absent — T5-01 dependency not met`. Do not try to add HTTP support here.
4. Read `engine/src/server/routes/` — find whichever route handles thread / run creation (`threads.ts`, `sessions.ts`, or `runs.ts` depending on how T5 landed it). You need the place where an inbound request is parsed and the per-request MCP config is assembled.
5. Read `engine/src/mcp/registry.ts`. Understand how env vars flow from the loaded config into the spawned server — for HTTP transport, env-interpolated placeholders must be resolved at registry.start() time, not at config-file-parse time (so that per-request Context IDs override a blank default).
6. WebFetch `https://docs.browserbase.com/introduction/what-is-browserbase` and `https://docs.browserbase.com/features/contexts` — confirm Context IDs flow via a header (not a query param) on session create. If docs say otherwise, trust the live docs over Agent 4's § 9 JSON.
7. WebFetch `https://github.com/browserbase/mcp-server-browserbase` — the README lists the exact auth header names. Cross-check against Agent 4's JSON.

## Implementation task

### Files to create / modify

- **Modify** `engine/templates/mcp.default.json` — add a new stanza after the existing Playwright entries:
  ```json
  {
    "_comment": "DISABLED — Browserbase hosted MCP (cloud Chrome). Set BROWSERBASE_API_KEY + BROWSERBASE_PROJECT_ID in env, then flip _disabled to false. Per-request Context IDs flow via the x-browserbase-context header on /v1/threads.",
    "_disabled": true,
    "transport": "http",
    "name": "browserbase",
    "url": "https://mcp.browserbase.com/mcp",
    "headers": {
      "Authorization": "Bearer ${BROWSERBASE_API_KEY}",
      "X-Browserbase-Project": "${BROWSERBASE_PROJECT_ID}",
      "X-Browserbase-Context-Id": "${BROWSERBASE_CONTEXT_ID:-}"
    }
  }
  ```
  Note the `${VAR:-default}` syntax — if `BROWSERBASE_CONTEXT_ID` is unset at resolution time, the header becomes empty. Browserbase treats an empty header as "no context" per their docs.

- **Modify** `engine/src/mcp/registry.ts` (or wherever HTTP transport env resolution lives after T5-01) — extend the env-interpolation pass to:
  - Read env vars from `process.env` as the baseline.
  - Overlay any per-request vars passed in via a new `requestEnv?: Record<string, string>` option.
  - Resolve `${VAR}` and `${VAR:-default}` in header values at start-time.
  - If a required var (`BROWSERBASE_API_KEY` when the `browserbase` stanza is enabled) is unresolved, throw a typed error that surfaces as a `500` with a clear message, not a silent connection failure.

- **Modify** the thread-create route (likely `engine/src/server/routes/threads.ts` or whatever T5 named it):
  - Read the optional `x-browserbase-context` inbound header. Validate it with a zod schema: alphanumeric + underscores + hyphens, 8–128 chars, or empty. Reject malformed values with 400.
  - If present, pass it as `{ BROWSERBASE_CONTEXT_ID: "<value>" }` into the per-request MCP registry start call's `requestEnv`.
  - If absent, do not inject anything — the template default `${BROWSERBASE_CONTEXT_ID:-}` resolves to empty.

- **Create** `docs/browserbase-setup.md` — a runbook. Structure:
  ```markdown
  # Browserbase setup for jellyclaw hosted

  1. **Sign up** at https://www.browserbase.com and copy your `BROWSERBASE_API_KEY` + `BROWSERBASE_PROJECT_ID`.
  2. **Set Fly secrets** on your jellyclaw app:
     ```bash
     fly secrets set \
       BROWSERBASE_API_KEY=bb_live_… \
       BROWSERBASE_PROJECT_ID=proj_… \
       --app jellyclaw-prod
     ```
  3. **Enable the Browserbase stanza** in your `jellyclaw.json` (or `engine/templates/mcp.default.json` if you're templating from it): flip `_disabled: true` → `_disabled: false`.
  4. **Create a Context** (per-user persistent login state) via Browserbase's interactive session UI — see https://docs.browserbase.com/features/contexts. Save the returned `ctx_…` ID.
  5. **Use the Context on a request**:
     ```bash
     curl -N https://<your-app>.fly.dev/v1/threads \
       -H "Authorization: Bearer $JELLYCLAW_TOKEN" \
       -H "Content-Type: application/json" \
       -H "x-browserbase-context: ctx_abc123" \
       -d '{"prompt":"navigate to gmail.com and tell me my last 3 subject lines"}'
     ```
  6. **Verify** the agent resumed your Context by inspecting the Browserbase dashboard's session replay for that run.

  ## Local development (Playwright path unchanged)

  For self-hosted / laptop mode, keep using `scripts/jellyclaw-chrome.sh` + the Playwright stanza. Browserbase is optional.

  ## Failure modes

  - Missing `BROWSERBASE_API_KEY` → jellyclaw fails to start the MCP server with a typed error. Fix: set the secret.
  - Malformed `x-browserbase-context` header → 400 from `/v1/threads`. Fix: send a valid Context ID.
  - Browserbase 5xx → surfaced as `tool.error code="upstream_unavailable"` per Agent 4's § Failure modes.
  ```

### Files NOT to touch

- Anything under `scripts/` related to the local Chrome path. The Browserbase stanza is additive.
- `engine/src/cli/chrome-autolaunch.ts` — unrelated to this tier.

### Shell commands

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine

# Basic sanity
bun install
bun run typecheck
bun run lint
bun run build

# Validate the template JSON still parses
node -e "JSON.parse(require('node:fs').readFileSync('engine/templates/mcp.default.json','utf8'))" && echo "template JSON ok"

# Run any existing MCP-config-loader tests — must still pass with the new stanza
bun run test engine/src/cli/mcp-config-loader.test.ts

# Run the thread-create route tests (exact filename depends on T5 — use grep to find)
grep -l "x-browserbase-context\|BROWSERBASE_CONTEXT_ID" engine/src --include="*.test.ts" -r
bun run test engine/src/server/routes  # broad sweep; should all pass

# Smoke: start serve locally, send a request with the header, confirm the value round-trips into the MCP start env
# (Do not hit Browserbase for real — we just want to see jellyclaw resolve the header into BROWSERBASE_CONTEXT_ID in a log line.)
BROWSERBASE_API_KEY=smoke-key BROWSERBASE_PROJECT_ID=smoke-proj \
  ./engine/bin/jellyclaw serve --port 8081 --auth-token smoke &
SERVE_PID=$!
sleep 2
curl -sS -X POST http://127.0.0.1:8081/v1/threads \
  -H "Authorization: Bearer smoke" \
  -H "Content-Type: application/json" \
  -H "x-browserbase-context: ctx_smoke_xyz" \
  -d '{"prompt":"noop"}' || true
kill "$SERVE_PID" 2>/dev/null
# Look for a log line containing BROWSERBASE_CONTEXT_ID=ctx_smoke_xyz at debug level (you may need LOG_LEVEL=debug).
```

### Acceptance criteria

1. `engine/templates/mcp.default.json` parses as valid JSON AND contains a `_disabled: true` Browserbase entry with `transport: "http"`, the Browserbase URL, and the three documented headers.
2. When the stanza is enabled and `BROWSERBASE_API_KEY` + `BROWSERBASE_PROJECT_ID` are both set in env, `registry.start()` resolves the header values correctly (unit test).
3. When `BROWSERBASE_API_KEY` is unset, startup fails with a typed error naming the missing variable (unit test).
4. `/v1/threads` accepts an optional `x-browserbase-context` header, validates it, and threads it into the per-request MCP start call's env (unit test — you do NOT need to hit Browserbase live).
5. Malformed `x-browserbase-context` (`"../etc/passwd"`, values > 128 chars, empty-string-with-whitespace-only) → 400 (unit test).
6. `docs/browserbase-setup.md` exists and walks through all six setup steps.
7. The Playwright MCP path still works — run `bun test engine/src/cli/chrome-autolaunch.test.ts` and confirm no regressions. If a test expected exactly N MCP servers in the template, the count bumps by 1 — update the test intentionally, noting "Browserbase stanza added (T6-02)".

### Tests to add

- `engine/src/mcp/registry.test.ts` — extend with:
  - `resolves ${VAR} from process.env` — passes.
  - `resolves ${VAR:-default} to default when VAR unset` — passes.
  - `overlays requestEnv over process.env` — passes.
  - `throws typed error when required var unset`.
- New test file `engine/src/server/routes/threads-browserbase.test.ts` (or extend existing `threads.test.ts`):
  - `valid x-browserbase-context header is threaded into requestEnv.BROWSERBASE_CONTEXT_ID`.
  - `missing header does not inject BROWSERBASE_CONTEXT_ID`.
  - `malformed header returns 400 with a descriptive message`.

### Common pitfalls

- **Don't parse `x-browserbase-context` with a regex that allows `${…}` substitutions.** A user-supplied value must NEVER be eval'd or shell-interpolated; treat it as an opaque string.
- **Don't persist the Context ID server-side.** It flows in, goes into one request's env, and disappears. Logging a hash is fine; logging the raw value is fine only at debug level.
- **Do not leak `BROWSERBASE_API_KEY` into logs.** If pino's redact list doesn't already scrub `Authorization` headers of spawned MCP configs, add it. Check `engine/src/logger.ts`.
- **The Browserbase MCP server uses `X-Browserbase-Context-Id`** (that's Browserbase's header name, going outbound from jellyclaw to them). The inbound jellyclaw header is `x-browserbase-context` (lowercase per HTTP convention, what our API clients send to us). Do not confuse the two.
- **`_disabled: true` must be the SHIPPED default.** Self-hosted users shouldn't automatically start making calls to a vendor they didn't sign up for. Hosted jellyclaw enables the stanza via deployment config, not via the template.
- **`${VAR:-default}` syntax — pick one interpretation and document it.** Bash-style `:-` means "use default if unset OR empty". That's what we want for `BROWSERBASE_CONTEXT_ID` (empty → no context). Implement accordingly in `registry.ts`.
- **Header validation regex** — do NOT use `/^\w+$/`: Browserbase Context IDs contain hyphens. Use `/^[A-Za-z0-9_-]{8,128}$/` or similar per Agent 4's `ctx_…` examples.

## Verification checklist

- [ ] `bun run typecheck && bun run lint && bun run test && bun run build` all pass.
- [ ] Template JSON is valid and contains the new stanza.
- [ ] New tests in `engine/src/mcp/registry.test.ts` and the threads route pass.
- [ ] No regression in the Playwright MCP tests.
- [ ] `docs/browserbase-setup.md` exists and is readable.
- [ ] Grep for `BROWSERBASE_API_KEY` — every usage either (a) reads from `process.env` or (b) is inside a redacted log path. No hardcoded keys.

## Closeout

1. Append to `COMPLETION-LOG.md`: `08.T6-02 ✅` with the count of MCP stanzas now in the template.
2. Print `DONE: T6-02` on success, `FAIL: T6-02 <reason>` on fatal failure.
