# Phase 07.5 — Chrome MCP — Prompt T3-01: Docs + templates

**When to run:** After `T2-02` ✅ in `COMPLETION-LOG.md`.
**Estimated duration:** 1–2 hours
**New session?** Yes.
**Model:** Claude Opus 4.6 (1M context).

## Research task

1. Re-read `phases/PHASE-07.5-chrome-mcp.md` Step 7 and the whole § 4 ("Flow choices explained") in `docs/CHROME-MCP-INTEGRATION-PLAN.md`.
2. Read `docs/mcp.md` and `docs/playwright-setup.md` in full. Identify what already exists and what moves/updates.
3. Read `engine/templates/mcp.default.json` (created in T0-02). Understand its schema + `_comment` convention.
4. WebFetch `https://chromewebstore.google.com/detail/playwright-mcp-bridge/mmlmfjhmonkocbjadbfplnigmagldckm` to confirm the extension is still live. Screenshot the extension ID into the doc for reference.
5. Look at `docs/skills.md`, `docs/permissions.md` for the tone/shape of other first-class feature docs in this repo.

## Implementation task

Ship user-facing documentation for Chrome MCP, and expand the default template with ready-to-uncomment Chrome entries. After this prompt, a new jellyclaw user should be able to go from zero to "agent drives my Chrome" in under five minutes by following `docs/chrome-setup.md`.

This prompt does NOT: wire chrome-devtools-mcp (T3-02) or touch code beyond docs + templates.

### Files to create / modify

- `docs/chrome-setup.md` — **new.** User-facing quickstart for Chrome MCP.
- `docs/mcp.md` — Chrome section rewritten; strip stale `~/.jellyclaw/mcp.json` references; point at `chrome-setup.md` for the deep dive.
- `docs/playwright-setup.md` — keep (it documents the port-9333 test harness) but cross-link to `chrome-setup.md`.
- `engine/templates/mcp.default.json` — append commented Playwright MCP entries for both Flow 1 (extension) and Flow 2 (CDP).
- `README.md` (repo root) — add a one-line "Chrome browsing: see docs/chrome-setup.md" link in the Features section.

### `docs/chrome-setup.md` skeleton

```markdown
# Chrome MCP setup

jellyclaw can drive a real Chrome browser on macOS via Microsoft's
[`@playwright/mcp`](https://github.com/microsoft/playwright-mcp) server. Three ways to
wire it, ordered by recommendation.

---

## Flow 1 — Chrome Web Store extension (recommended for personal use)

Keeps your real Chrome profile intact. All existing logins work. No CDP flag dance.

1. Install **Playwright MCP Bridge** from the Chrome Web Store:
   https://chromewebstore.google.com/detail/playwright-mcp-bridge/mmlmfjhmonkocbjadbfplnigmagldckm
2. Add to `~/.jellyclaw/jellyclaw.json`:
   ```json
   {
     "mcp": [
       {
         "transport": "stdio",
         "name": "playwright",
         "command": "npx",
         "args": ["-y", "@playwright/mcp@latest", "--extension"]
       }
     ]
   }
   ```
3. Run `jellyclaw run "open github.com and snapshot"` — first time, Chrome surfaces a
   tab picker; pick a tab and the agent connects.
4. Verify: `jellyclaw doctor` shows `playwright` MCP server as ready.

**Security note:** The agent can read every open tab's DOM + cookies + localStorage.
Don't run an untrusted prompt against this flow with banking tabs open.

---

## Flow 2 — Dedicated debug profile (recommended for scripted / shared / CI use)

Isolates the agent from your default Chrome profile. First run requires logging in
inside the jellyclaw-chrome profile; sessions persist across runs.

1. Launch Chrome in debug mode:
   ```bash
   ./scripts/jellyclaw-chrome.sh
   ```
   This opens Chrome on CDP port 9333 with a dedicated profile at
   `~/Library/Application Support/jellyclaw-chrome-profile`.
2. Add to `~/.jellyclaw/jellyclaw.json`:
   ```json
   {
     "mcp": [
       {
         "transport": "stdio",
         "name": "playwright",
         "command": "npx",
         "args": ["-y", "@playwright/mcp@latest",
                  "--browser", "chrome",
                  "--cdp-endpoint", "http://127.0.0.1:9333"]
       }
     ]
   }
   ```
3. Run `jellyclaw run "..."` as normal. Stop Chrome with
   `./scripts/jellyclaw-chrome-stop.sh` when done.

**Chrome 136+ note:** Google blocked `--remote-debugging-port` against the default
profile in March 2025. The dedicated profile path is mandatory — `jellyclaw-chrome.sh`
handles it correctly.

---

## Flow 3 — Ephemeral Chromium (default for headless CI)

No host Chrome needed. Playwright manages its own bundled Chromium.

1. Add to `~/.jellyclaw/jellyclaw.json`:
   ```json
   {
     "mcp": [
       {
         "transport": "stdio",
         "name": "playwright",
         "command": "npx",
         "args": ["-y", "@playwright/mcp@latest"]
       }
     ]
   }
   ```
2. First run downloads ~120 MB of bundled Chromium at
   `~/Library/Caches/ms-playwright/mcp-<workspace-hash>`.
3. No persistent state between runs unless you pass `--user-data-dir <path>`.

---

## Tools your agent gains

Core (always on): `browser_navigate`, `browser_click`, `browser_type`, `browser_snapshot`,
`browser_take_screenshot`, `browser_evaluate`, `browser_fill_form`, `browser_press_key`,
`browser_wait_for`, `browser_tabs`, `browser_resize`, `browser_drag`, `browser_hover`,
`browser_select_option`, `browser_file_upload`, `browser_handle_dialog`,
`browser_console_messages`, `browser_network_requests`, `browser_run_code`,
`browser_navigate_back`, `browser_close`.

Opt-in via `--caps`:
- `storage` — cookie + localStorage + sessionStorage tools
- `network` — request mocking + routing
- `devtools` — tracing + video + locator picker
- `vision` — raw XY mouse events
- `pdf` — PDF save
- `testing` — locator generation + verification

By default, **three tools always prompt for confirmation** regardless of
`--permission-mode`:

- `browser_evaluate` — runs arbitrary JS in the page context
- `browser_run_code` — runs Playwright script code server-side
- `browser_file_upload` — uploads a local file to the page

See `docs/permissions.md` for how to adjust these.

Rate limit: `browser:60/min` (burst 10) applies to every `browser_*` tool across
all MCP servers. Override via `~/.jellyclaw/settings.json` `ratelimits.browser`.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `jellyclaw doctor` says CDP not listening | Chrome not running in debug mode | `./scripts/jellyclaw-chrome.sh` |
| `browser_evaluate` always pauses for confirmation | Intentional carve-out | See permissions doc; set explicit permission if you want bypass |
| `rate_limited` tool errors | 60/min burst exceeded | Wait or increase bucket in settings |
| Extension path not working | Extension not installed | Install from Chrome Web Store link above |
| "Chrome not found" in doctor | Chrome not at `/Applications/Google Chrome.app` | `brew install --cask google-chrome` |
| Cache taking up space | Playwright-managed Chromium | `rm -rf ~/Library/Caches/ms-playwright` (safe) |

See also:
- `docs/mcp.md` — MCP subsystem overview
- `docs/playwright-setup.md` — test-harness Chrome (port 9333 test mode)
- `patches/004-playwright-mcp-pin.md` — version-pin policy
```

### `engine/templates/mcp.default.json` additions

Extend the template from T0-02 to include ready-to-uncomment Chrome entries:

```json
{
  "$schema": "https://jellyclaw.dev/schemas/jellyclaw.json",
  "mcp": [
    {
      "_comment": "Echo test server — safe to keep, illustrates stdio transport",
      "transport": "stdio",
      "name": "echo",
      "command": "bun",
      "args": ["./test/fixtures/mcp/echo-server.ts"]
    },
    {
      "_comment": "DISABLED — Chrome MCP (Flow 2: dedicated debug profile). Uncomment and run scripts/jellyclaw-chrome.sh first.",
      "_disabled": true,
      "transport": "stdio",
      "name": "playwright",
      "command": "npx",
      "args": ["-y", "@playwright/mcp@latest",
               "--browser", "chrome",
               "--cdp-endpoint", "http://127.0.0.1:9333"]
    },
    {
      "_comment": "DISABLED — Chrome MCP (Flow 1: Web Store extension). Uncomment after installing Playwright MCP Bridge.",
      "_disabled": true,
      "transport": "stdio",
      "name": "playwright-extension",
      "command": "npx",
      "args": ["-y", "@playwright/mcp@latest", "--extension"]
    }
  ]
}
```

Note: `_disabled: true` is an advisory marker — the loader must strip any server with `_disabled: true` before passing to `McpRegistry`. Either extend the loader from T0-01 to do this (one-line filter), or use a `//` jsonc comment convention (requires jsonc parser — heavier lift). Pick the filter approach.

### `docs/mcp.md` rewrite

The existing `docs/mcp.md` likely has a pre-T0-02 Chrome/Playwright section. Replace it with a one-paragraph redirect:

```markdown
## Driving a real browser — Chrome MCP

See `docs/chrome-setup.md` for the end-to-end setup. Quick summary:

- Primary: Microsoft `@playwright/mcp@^0.0.70` — navigate, click, snapshot, screenshot
- Optional secondary: Google `chrome-devtools-mcp` (Lighthouse + performance; see T3-02)
- Three flows: Chrome Web Store extension (Flow 1), dedicated debug profile (Flow 2), ephemeral Chromium (Flow 3)

Both `browser_evaluate` and `browser_run_code` always prompt for confirmation regardless of `--permission-mode`.
Rate limit: 60/min with burst 10 on every `browser_*` tool.
```

Strip any reference to `~/.jellyclaw/mcp.json` (legacy shape killed in T0-02).

### README.md update

Add to the features list:

```markdown
- **Chrome browsing** via Playwright MCP — [`docs/chrome-setup.md`](./docs/chrome-setup.md)
```

### Shell commands

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine
bun run typecheck    # templates + docs shouldn't break typecheck but confirm
bun run lint         # biome checks on any updated TS; docs don't count
bun run build

# Spot-check doc rendering
head -100 docs/chrome-setup.md
```

### Expected output

- `docs/chrome-setup.md` exists, renders cleanly as Markdown, documents all 3 flows
- `docs/mcp.md` Chrome section is a short redirect to `chrome-setup.md`
- `docs/playwright-setup.md` cross-links to `chrome-setup.md`
- `engine/templates/mcp.default.json` has echo + two disabled Playwright entries
- `README.md` features list mentions Chrome browsing
- No reference to `~/.jellyclaw/mcp.json` anywhere in `docs/`
- The loader from T0-01 strips `_disabled: true` entries before passing to `McpRegistry`

### Tests to add

- `engine/src/cli/mcp-config-loader.test.ts` — new case: `_disabled: true` entries are filtered out

### Verification

```bash
grep -R "~/.jellyclaw/mcp.json" docs/
# Expect: 0 hits

grep -c "chrome-setup.md" docs/ README.md
# Expect: >= 3 (at least one in each of mcp.md, playwright-setup.md, README.md)

# Test the _disabled filter
echo '{"mcp":[{"_disabled":true,"transport":"stdio","name":"x","command":"echo"}]}' \
  > /tmp/disabled-test.json
./engine/bin/jellyclaw mcp list --config /tmp/disabled-test.json
# Expect: empty list (no active servers)
rm /tmp/disabled-test.json
```

### Common pitfalls

- **Don't bikeshed the extension-bridge UX.** Microsoft controls it; we just document what exists. If the Chrome Web Store ID changes, update the link; don't re-engineer the flow.
- **Don't duplicate content between `mcp.md`, `chrome-setup.md`, and `playwright-setup.md`.** Each should have a single clear job. `chrome-setup.md` is the deep dive; the others cross-link.
- **Keep `docs/playwright-setup.md`** — the test-harness (port 9333 test mode) documentation there is still valid. Don't delete; annotate.
- **`_disabled` is jellyclaw-specific.** Upstream `JellyclawConfig.mcp` zod schema may not know the field — make sure the loader strips it BEFORE zod parse, or extend the schema with `.passthrough()`. Test both directions.
- **Screenshots of the Chrome Web Store** live with the caller; we don't check them in.
- **Keep the troubleshooting table short.** 5-8 rows, each with a concrete symptom + fix. Don't over-document edge cases.

## Closeout

1. Update `COMPLETION-LOG.md` with `07.5.T3-01 ✅`.
2. Update `STATUS.md` to point at `T3-02` (if doing secondary) or mark Phase 07.5 DONE if deferring it.
3. Print `DONE: T3-01`.

On fatal failure: `FAIL: T3-01 <reason>`.
