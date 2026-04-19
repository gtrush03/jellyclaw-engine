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

1. Add to `~/.jellyclaw/jellyclaw.json`:
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
2. Run `jellyclaw run "..."` as normal. **Chrome is auto-launched** — when jellyclaw
   detects a `--cdp-endpoint http://127.0.0.1:<port>` in your MCP config, it
   automatically invokes `scripts/jellyclaw-chrome.sh` if Chrome isn't already
   running on that port. You no longer need to start Chrome manually.
3. Stop Chrome with `./scripts/jellyclaw-chrome-stop.sh` when done (optional — Chrome
   can safely stay running between sessions).

**Note:** If you prefer manual control, you can still launch Chrome yourself:
   ```bash
   ./scripts/jellyclaw-chrome.sh
   ```
   This opens Chrome on CDP port 9333 with a dedicated profile at
   `~/Library/Application Support/jellyclaw-chrome-profile`. jellyclaw will detect
   Chrome is already running and skip the auto-launch.

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
| Heavy-JS sites (configurators, WebGL apps) now capture reliably | Animations frozen before capture | The engine freezes animations + hides canvases before the screenshot — artifact appears within 10 s instead of timing out at 60 s |
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
