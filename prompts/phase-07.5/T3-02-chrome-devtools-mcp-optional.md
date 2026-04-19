# Phase 07.5 — Chrome MCP — Prompt T3-02: chrome-devtools-mcp secondary (OPTIONAL)

**When to run:** After `T3-01` ✅ in `COMPLETION-LOG.md`. This prompt is OPTIONAL — Phase 07.5 can close cleanly at T3-01 if you don't want a second Chrome MCP stack.
**Estimated duration:** 1–2 hours
**New session?** Yes.
**Model:** Claude Opus 4.6 (1M context).

## Research task

1. Re-read `phases/PHASE-07.5-chrome-mcp.md` Step 8 and § 1 of `docs/CHROME-MCP-INTEGRATION-PLAN.md`.
2. WebFetch `https://registry.npmjs.org/chrome-devtools-mcp/latest` — confirm the current version.
3. WebFetch `https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/README.md` — read the CLI flags, tool list, and telemetry defaults.
4. Read `engine/templates/mcp.default.json` AFTER T3-01 landed. We extend it with a third disabled entry.
5. Read `docs/chrome-setup.md` AFTER T3-01 landed. We append a section for chrome-devtools-mcp.
6. Verify the Apache-2.0 license is compatible with whatever jellyclaw ships under.

## Implementation task

Add `chrome-devtools-mcp` as an opt-in secondary MCP server. Google-maintained, Puppeteer-based, exposes DevTools-flavored tools: Lighthouse audits, CPU/network throttling, performance traces, memory snapshots. Not a replacement for Playwright MCP — complementary.

This prompt does NOT write any engine source code. Templates + docs only. The existing MCP infrastructure from T0-01 → T2-02 already handles multiple MCP servers.

### Files to modify

- `engine/templates/mcp.default.json` — add a third disabled entry for chrome-devtools-mcp
- `docs/chrome-setup.md` — new section "Flow 4: Lighthouse + performance via chrome-devtools-mcp"
- `patches/005-chrome-devtools-mcp-pin.md` — **new.** Version-pin rationale doc for the new dep (even though not required as a dep, we document the pin we recommend in the template).

### Template addition

Append to `engine/templates/mcp.default.json`:

```json
{
  "_comment": "DISABLED — chrome-devtools-mcp secondary (Lighthouse + performance). Puppeteer-based; complementary to Playwright MCP. See docs/chrome-setup.md.",
  "_disabled": true,
  "transport": "stdio",
  "name": "chrome-devtools",
  "command": "npx",
  "args": [
    "-y", "chrome-devtools-mcp@latest",
    "--browserUrl", "http://127.0.0.1:9333",
    "--no-performance-crux",
    "--no-usage-statistics"
  ]
}
```

**Important defaults to hardcode in the template:**
- `--no-performance-crux` disables the CrUX API telemetry (ON by default upstream)
- `--no-usage-statistics` disables usage stats (ON by default upstream)

These two flags exist because Google's default is opt-out; jellyclaw ships opt-in-only.

### `docs/chrome-setup.md` new section

After Flow 3, before Troubleshooting, insert:

```markdown
## Flow 4 — Lighthouse + performance via chrome-devtools-mcp (optional)

For Lighthouse audits, CPU/network throttling, performance traces, and memory snapshots,
Google ships [`chrome-devtools-mcp`](https://github.com/ChromeDevTools/chrome-devtools-mcp).
Run it alongside `@playwright/mcp` — the two share the same debug Chrome.

1. Launch Chrome on port 9333 as in Flow 2.
2. Uncomment the `chrome-devtools` entry in `~/.jellyclaw/jellyclaw.json`.
3. Run jellyclaw — you now have two MCP servers. Tool namespaces disambiguate:
   - `mcp__playwright__browser_*` — interaction (click, type, navigate)
   - `mcp__chrome-devtools__*` — inspection (lighthouse_audit, performance_start_trace,
     take_memory_snapshot)

### chrome-devtools-mcp tools

- `navigate_page`, `list_pages`, `select_page`, `close_page`, `new_page`, `wait_for`
- `click`, `drag`, `fill`, `fill_form`, `handle_dialog`, `hover`, `press_key`, `type_text`, `upload_file`
- `emulate`, `resize_page`, `take_screenshot`, `take_snapshot`
- `evaluate_script`, `get_console_message`, `list_console_messages`
- `get_network_request`, `list_network_requests`
- `performance_analyze_insight`, `performance_start_trace`, `performance_stop_trace`, `take_memory_snapshot`
- `lighthouse_audit`

### Telemetry — off by default in our template

The upstream defaults for `--performance-crux` (CrUX API) and `--usage-statistics`
are ON; our `mcp.default.json` template disables them. If you want to re-enable either,
edit your local config and remove the `--no-*` flag.
```

### `patches/005-chrome-devtools-mcp-pin.md` skeleton

```markdown
# Patch 005 — `chrome-devtools-mcp` version-pin policy (secondary MCP)

**Status:** Advisory — jellyclaw does NOT include this in `engine/package.json`.
It's provided as a disabled template entry in `engine/templates/mcp.default.json`.
Users who opt in run `npx chrome-devtools-mcp@latest` which resolves at spawn time.

**Recommended pin:** `^0.21.0` (verified 2026-04-17 at
https://registry.npmjs.org/chrome-devtools-mcp/latest).

**Maintainer:** Google / Chrome DevTools team. Apache-2.0.

## Why optional

`chrome-devtools-mcp` provides DevTools-flavored tools that don't duplicate
Playwright MCP's surface: Lighthouse audits, performance tracing, memory snapshots.
It is not required for general Chrome browsing. Users who want it enable it explicitly.

## Compatibility with `@playwright/mcp`

Both can run simultaneously against the same Chrome instance on port 9333.
Tool namespaces are distinct (`mcp__playwright__*` vs `mcp__chrome-devtools__*`).

## Telemetry

Upstream defaults `--performance-crux` and `--usage-statistics` to ON. Our template
sets them OFF. If users re-enable, their config shows the explicit flag removal.

## Known caveat — Chrome 136+ default-profile block

Same as Playwright MCP. Use a non-default `--user-data-dir`. The shared `jellyclaw-chrome.sh`
from T1-02 already handles this — chrome-devtools-mcp with `--browserUrl http://127.0.0.1:9333`
inherits the dedicated profile.

## Verification

```bash
npx chrome-devtools-mcp@0.21.0 --browserUrl http://127.0.0.1:9333 --tools 2>&1 | head -40
```

Should list the tools documented above.
```

### Shell commands

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine

# Confirm the version still resolves
npm info chrome-devtools-mcp@latest version

# Smoke: list tools from the secondary
scripts/jellyclaw-chrome.sh &
CHROME_PID=$!
sleep 3

# Temporarily enable the chrome-devtools entry in a test config
cat > /tmp/both-mcps.json <<EOF
{"mcp":[
  {"transport":"stdio","name":"playwright","command":"npx","args":["-y","@playwright/mcp@latest","--browser","chrome","--cdp-endpoint","http://127.0.0.1:9333"]},
  {"transport":"stdio","name":"chrome-devtools","command":"npx","args":["-y","chrome-devtools-mcp@latest","--browserUrl","http://127.0.0.1:9333","--no-performance-crux","--no-usage-statistics"]}
]}
EOF

./engine/bin/jellyclaw mcp list --config /tmp/both-mcps.json
# Expect: both servers listed, each with its own tools; no namespace collisions

scripts/jellyclaw-chrome-stop.sh
wait $CHROME_PID 2>/dev/null || true
rm /tmp/both-mcps.json
```

### Expected output

- `engine/templates/mcp.default.json` has THREE disabled entries (echo + playwright + playwright-extension from T3-01, plus chrome-devtools added here)
- `docs/chrome-setup.md` has a new Flow 4 section
- `patches/005-chrome-devtools-mcp-pin.md` exists with the version rationale
- `jellyclaw mcp list` against the combined config lists both servers and their tools without collision
- Neither server spawns telemetry HTTP calls (verify via `lsof -i | grep chrome-devtools` during a run; no outbound to CrUX API)

### Tests to add

None required. The plumbing is fully reused from T0-01/T0-02; this prompt only adds template + docs content.

Optional but recommended: add a smoke test at `test/integration/chrome-devtools-mcp-smoke.test.ts` gated on `JELLYCLAW_CHROME_DEVTOOLS_MCP_TEST=1` that just verifies `mcp__chrome-devtools__lighthouse_audit` appears in the tool list. Do not run the audit itself — it takes ~60s and flakes on CI.

### Verification

```bash
# Confirm template now has 4 entries
jq '.mcp | length' engine/templates/mcp.default.json
# Expect: 4

# Confirm all are disabled
jq '.mcp[]._disabled' engine/templates/mcp.default.json
# Expect: true, true, true, true (echo has _disabled? probably false; adjust expectation)

bun run build
```

### Common pitfalls

- **DO NOT enable chrome-devtools-mcp by default.** Dual MCPs against the same Chrome is fine technically but doubles the model's tool-catalog noise. Users who want it opt in.
- **DO NOT skip the `--no-performance-crux --no-usage-statistics` flags.** Google's default is opt-out; jellyclaw's default is opt-in.
- **Don't wrap chrome-devtools-mcp in any jellyclaw code.** It's a pure child-process MCP like any other. The engine stays Chrome-agnostic by design.
- **Namespace discipline.** Both servers will surface similar-named tools (`browser_navigate` vs `navigate_page`). The model's prompt may need a hint about which to prefer for which task — note this in docs, don't try to enforce in code.
- **Apache-2.0 license** is compatible with MIT; confirm jellyclaw's own license field hasn't changed since last check.
- **Version drift.** The template references `@latest`. That's pragmatic — npx resolves on spawn. But document in `patches/005` what the last-known-good version was so a future user can pin if something breaks.

## Closeout

1. Update `COMPLETION-LOG.md` with `07.5.T3-02 ✅`.
2. Update `STATUS.md` — Phase 07.5 is now COMPLETE.
3. Print `DONE: T3-02`.

On fatal failure: `FAIL: T3-02 <reason>`.

**If skipping** (phase closes at T3-01): manually mark `STATUS.md` Phase 07.5 as COMPLETE, update `COMPLETION-LOG.md` with a note "T3-02 deferred — optional secondary MCP, not blocking."
