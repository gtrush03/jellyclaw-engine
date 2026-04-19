# Patch 004 — `@playwright/mcp` version pin

**Status:** Active pin.
**Current pin:** `^0.0.70` (previously `0.0.41`, bumped 2026-04-17 in T1-01).
**Location:** `engine/package.json` (moved from root `package.json:68` devDeps in this bump).

## Why we pin at all

The Microsoft `@playwright/mcp` server ships weekly releases. Between 0.0.41 and 0.0.70,
the tool surface stabilized and the "missing tool" regression documented in the previous
pin rationale was fixed upstream.

## Tool parity verified against 0.0.70

Core tool names — unchanged from 0.0.41:

- `browser_navigate` — navigate to URL
- `browser_navigate_back` — go back in history
- `browser_tabs` — list/create/close/select tabs
- `browser_wait_for` — wait for text or time
- `browser_close` — close the page
- `browser_click` — click element
- `browser_type` — type text into element
- `browser_hover` — hover over element
- `browser_drag` — drag and drop
- `browser_press_key` — press keyboard key
- `browser_select_option` — select dropdown option
- `browser_fill_form` — fill multiple form fields
- `browser_file_upload` — upload files
- `browser_handle_dialog` — handle browser dialogs
- `browser_resize` — resize browser window
- `browser_snapshot` — capture accessibility snapshot
- `browser_take_screenshot` — capture screenshot
- `browser_console_messages` — get console messages
- `browser_network_requests` — get network requests
- `browser_evaluate` — evaluate JavaScript (DANGEROUS)
- `browser_run_code` — run Playwright code (DANGEROUS)

## Chrome Web Store extension — new path added in v0.0.67

Microsoft shipped the "Playwright MCP Bridge" extension on the Chrome Web Store
(ID `mmlmfjhmonkocbjadbfplnigmagldckm`). With the `--extension` flag,
the MCP server connects to the user's real Chrome (default profile, real logins)
without exposing `--remote-debugging-port`. See `docs/chrome-setup.md`.

## Verification receipts (2026-04-17)

- npm registry: `@playwright/mcp@0.0.70` — published 2026-04-01
- GitHub release: v0.0.70 — "Maintenance release off 1.59 branch point"
- Bundled Playwright dep: `playwright@1.60.0-alpha-1774999321000` per the npm manifest dependencies

## Smoke test

```bash
bun run engine/scripts/mcp-list.ts --config test/fixtures/mcp/playwright.test-config.json
# Expect: playwright server ready; tools include browser_navigate, browser_snapshot, etc.
```

Run before merging any future bump.

## Integration test

```bash
JELLYCLAW_PW_MCP_TEST=1 bun run test test/integration/playwright-mcp.test.ts
# Expect: 5 passed
```

The test drives a real Chrome on port 9333 (never 9222) and asserts tool
registration, navigation, and screenshot capture.

## How to override

Users who need a different version can override in their personal config:

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

When overriding, run `jellyclaw doctor --mcp` to verify tools are present.

## When we bump again

We bump under two conditions:

1. Upstream releases a version with meaningful improvements or security fixes.
2. Our integration test at `test/integration/playwright-mcp.test.ts` passes.

This document will be updated with new receipts (not removed — we always document the pin).

## Related

- `test/integration/playwright-mcp.test.ts` — regression gate
- `docs/playwright-setup.md` — user-facing setup guide
- `SECURITY.md` §3.4 — security rationale for pinning MCP dependencies
