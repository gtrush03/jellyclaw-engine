# Playwright MCP — setup

jellyclaw connects to `@playwright/mcp@0.0.70` as an ordinary stdio MCP server
(see `docs/mcp.md`). Zero jellyclaw code is added to support it — the
integration is entirely config-driven.

> **User-facing setup:** For a quickstart on how to drive your real Chrome
> with jellyclaw, see [`docs/chrome-setup.md`](./chrome-setup.md). This doc
> covers the **test harness** (port 9333) used by the integration suite.

> **Version pin is deliberate.** See `patches/004-playwright-mcp-pin.md`.
> We pin to `^0.0.70` for stability. The "missing tool" regression documented
> in earlier versions has been fixed upstream.

## Two modes: production vs tests

**Port `9222` is reserved for your real browser.** The production setup below
assumes you deliberately launched your daily Chrome with
`--remote-debugging-port=9222` so jellyclaw can drive it. Tests **must not**
touch `9222` — they use an isolated headless Chrome on `9333` with a
throwaway user-data-dir.

## Production — drive your real Chrome on `9222`

### 1. Launch Chrome with CDP enabled

Quit Chrome fully first, then:

```sh
# macOS
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --remote-debugging-address=127.0.0.1

# Linux
google-chrome --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1
```

Binding to `127.0.0.1` is non-negotiable — exposing CDP on `0.0.0.0` or a LAN
IP would let any other machine on your network drive your logged-in browser.

### 2. Add the server to `~/.jellyclaw/jellyclaw.json`

```json
{
  "mcp": [
    {
      "transport": "stdio",
      "name": "playwright",
      "command": "bunx",
      "args": [
        "@playwright/mcp@0.0.70",
        "--browser", "chrome",
        "--cdp-endpoint", "http://127.0.0.1:9222"
      ]
    }
  ]
}
```

### 3. Verify

```sh
bun run engine/scripts/mcp-list.ts
# expect: mcp: 1 live, 0 dead, 0 retrying
# followed by ~21 namespaced tools, e.g.:
#   mcp__playwright__browser_navigate
#   mcp__playwright__browser_take_screenshot
#   mcp__playwright__browser_fill_form
```

If Chrome is not running with CDP on `9222`, the MCP server fails to connect
and the registry logs a `warn`-level message naming the endpoint — it does NOT
crash the engine.

## Tests — isolated Chrome on `9333`

The integration test `test/integration/playwright-mcp.test.ts` spawns a
dedicated headless Chrome on port `9333` with a temp profile directory.
Reviewers can grep any test line for `9333` to confirm isolation; any
occurrence of `9222` in test paths is rejected by `assertNoForbiddenPort()`.

### Manual test Chrome

```sh
scripts/playwright-test-chrome.sh start
# prints: pid=<n> datadir=<tmp-dir> port=9333

# … do stuff against http://127.0.0.1:9333/json/version …

scripts/playwright-test-chrome.sh stop
# kills the Chrome process and rm -rf's the temp datadir
```

The helper refuses any attempt to bind `9222`:

```sh
JELLYCLAW_TEST_CHROME_PORT=9222 scripts/playwright-test-chrome.sh start
# stderr: refusing: 9222 is reserved for the user's real browser
# exit: 64
```

### Run the integration test

The Playwright suite is opt-in via `JELLYCLAW_PW_MCP_TEST=1` — it spawns a
real Chrome (~45 s wall time) and would otherwise starve the opencode-server
e2e's internal 20 s startup timeout when run in parallel in the default suite.

```sh
JELLYCLAW_PW_MCP_TEST=1 bun run test test/integration/playwright-mcp.test.ts
# expect: 5 passed
#   - refuses to launch if config names port 9222
#   - registers playwright tools under the mcp__playwright__ namespace
#   - navigates + screenshots example.com end-to-end
#   - cleans up the temp user-data-dir after stop
#   - does not open a session to CDP:9222 from the test process

# Full-suite opt-in (includes every test):
JELLYCLAW_PW_MCP_TEST=1 bun run test
```

The test writes its screenshot artifact under
`${TMPDIR}/jellyclaw-test-artifacts/playwright-mcp-<timestamp>.png` so a human
reviewer can eyeball the output.

## Common pitfalls

- **Chrome was already running when you launched with `--remote-debugging-port`.**
  Chrome refuses to honor the flag if another instance is already using the
  same profile directory. Quit fully first, or launch with
  `--user-data-dir=<throwaway>` to sidestep the default profile.
- **`bunx @playwright/mcp@0.0.70` hangs on first run.** `bunx` fetches the package
  on the initial call; this can take 30 s+ on a cold cache. The package is
  already installed via `engine/package.json`, or set a longer
  `connectTimeoutMs` per server.
- **macOS `/tmp` symlink.** Chrome sometimes rejects paths under `/tmp/` because
  macOS symlinks them to `/private/tmp/`. The helper script uses `mktemp -d -t`
  which resolves to the real path.
- **Orphan Chrome processes.** If the test or helper is killed mid-run, a stale
  Chrome can keep `9333` occupied. `pkill -f "jellyclaw-test-chrome"` clears them.

## Tool surface expected by Genie / jellyclaw

Per `patches/004-playwright-mcp-pin.md`, the load-bearing tools are:

- `browser_navigate`, `browser_navigate_back`
- `browser_click`, `browser_type`, `browser_press_key`
- `browser_fill_form`, `browser_select_option`
- `browser_take_screenshot`, `browser_snapshot`
- `browser_tabs`, `browser_close`, `browser_wait_for`
- `browser_network_requests`, `browser_console_messages`
- `browser_hover`, `browser_drag`, `browser_file_upload`
- `browser_handle_dialog`, `browser_evaluate`, `browser_resize`

The integration test logs the full namespaced list to stderr at run time so
upstream renames surface as a diff instead of a cryptic test miss.
