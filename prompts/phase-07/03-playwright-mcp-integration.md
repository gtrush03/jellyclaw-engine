# Phase 07 — MCP client integration — Prompt 03: Playwright MCP via CDP

**When to run:** After Phase 07 prompts 01 + 02 are both ✅ in `COMPLETION-LOG.md`.
**Estimated duration:** 2–3 hours
**New session?** Yes — always start a fresh Claude Code session per prompt
**Model:** Claude Opus 4.6 (1M context)

<!-- BEGIN: paste from /Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/STARTUP-TEMPLATE.md -->
<!-- STOP if 07.01 or 07.02 not ✅. -->
<!-- END paste -->

## Research task

1. Re-read `/Users/gtrush/Downloads/jellyclaw-engine/phases/PHASE-07-mcp.md`, Step 6 (Playwright sanity test).
2. Read `/Users/gtrush/Downloads/jellyclaw-engine/patches/004-playwright-mcp-pin.md` — why `@playwright/mcp@0.0.41` specifically. Do not float the version.
3. Use context7 to fetch `@playwright/mcp@0.0.41` docs — what CLI flags it accepts, especially `--cdp-endpoint`, `--browser`, `--user-data-dir`, `--isolated`.
4. Read `/Users/gtrush/Downloads/jellyclaw-engine/engine/SECURITY.md` — the explicit warning about never touching CDP port `9222` in tests; George's real browser (with logged-in sessions, cookies, bank tabs) runs there.
5. Read `/Users/gtrush/Downloads/jellyclaw-engine/integration/GENIE-INTEGRATION.md` if it mentions Playwright — the integration should be **config-only**, not code.
6. Read Phase 02 config loader to confirm the MCP config shape supports all fields Playwright needs.

## Implementation task

Wire `@playwright/mcp@0.0.41` to jellyclaw **via config only** — zero code added to `engine/src/`. Add a test profile on port **9333** for CI; document that **CDP:9222 is reserved for George's real browser and tests must never touch it**.

### Files to create/modify

- `/Users/gtrush/Downloads/jellyclaw-engine/docs/mcp.md` — add a "Playwright / browser automation" section with the exact config snippet users paste.
- `/Users/gtrush/Downloads/jellyclaw-engine/docs/playwright-setup.md` — step-by-step for both production (user's real Chrome on 9222) and tests (isolated Chrome on 9333).
- `/Users/gtrush/Downloads/jellyclaw-engine/test/fixtures/mcp/playwright.test-config.json` — jellyclaw config fixture targeting port 9333.
- `/Users/gtrush/Downloads/jellyclaw-engine/test/integration/playwright-mcp.test.ts` — integration test that:
  1. Spawns an isolated headless Chrome on `127.0.0.1:9333` with a throwaway `--user-data-dir` in `os.tmpdir()`.
  2. Loads the test-config, starts the MCP registry, asserts `mcp__playwright__*` tools show up.
  3. Calls `mcp__playwright__browser_navigate` to `http://example.com`.
  4. Calls `mcp__playwright__browser_take_screenshot`; asserts a PNG file is produced.
  5. Tears down Chrome, removes temp user-data-dir.
- `/Users/gtrush/Downloads/jellyclaw-engine/scripts/playwright-test-chrome.sh` — helper that launches the isolated test Chrome on port 9333 (used by the test setup).
- `/Users/gtrush/Downloads/jellyclaw-engine/package.json` — `devDependencies: { "@playwright/mcp": "0.0.41" }` — exact pin, no caret.

### Production config (documented; not code)

`~/.jellyclaw/jellyclaw.json`:

```json
{
  "mcp": {
    "playwright": {
      "transport": "stdio",
      "command": "npx",
      "args": [
        "@playwright/mcp@0.0.41",
        "--browser", "chrome",
        "--cdp-endpoint", "http://127.0.0.1:9222"
      ]
    }
  }
}
```

### Test config (hard-coded port 9333)

`test/fixtures/mcp/playwright.test-config.json`:

```json
{
  "mcp": {
    "playwright": {
      "transport": "stdio",
      "command": "npx",
      "args": [
        "@playwright/mcp@0.0.41",
        "--browser", "chrome",
        "--cdp-endpoint", "http://127.0.0.1:9333"
      ]
    }
  }
}
```

### Test isolation guarantees (non-negotiable)

1. The test **MUST** assert the target CDP endpoint is `127.0.0.1:9333` before launching anything. If it sees `9222` in config, fail the test immediately with `"refusing to run Playwright MCP tests against CDP:9222 — that port is reserved for the user's real browser"`.
2. Test Chrome is spawned with:
   - `--remote-debugging-port=9333`
   - `--user-data-dir=<tmpdir>/jellyclaw-test-chrome-<random>`
   - `--no-first-run --no-default-browser-check --headless=new`
   - `--disable-extensions`
3. On test teardown (including failures — use try/finally): kill the Chrome process and `rm -rf` the temp user-data-dir.
4. The test script registers a SIGINT/SIGTERM handler that kills Chrome if the process is interrupted.
5. The helper script `playwright-test-chrome.sh` must `grep`-refuse if `9222` appears anywhere in its args or env.

### Shell commands

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine
bun add -d @playwright/mcp@0.0.41
bun run typecheck
bun run test test/integration/playwright-mcp.test.ts
bun run lint
```

### Expected output

- Test spawns isolated Chrome on 9333, navigates to example.com, writes a screenshot file, exits clean.
- Registry logs show `playwright` connected, tools namespaced `mcp__playwright__<name>` (e.g. `mcp__playwright__browser_navigate`, `mcp__playwright__browser_take_screenshot`).
- Zero traffic hits `127.0.0.1:9222` (verify with `lsof -i :9222` before and after — no new connections from our process).

### Tests to add

- `test/integration/playwright-mcp.test.ts`:
  1. Port-guard test: load test config, assert endpoint is 9333, not 9222. Mutate config to 9222 in a separate case and assert the loader/runner refuses.
  2. Full round trip: navigate + screenshot.
  3. Teardown test: confirm user-data-dir removed after run.
  4. (Optional, skipped by default) CDP-not-running test: without launching Chrome, assert the MCP client reports a friendly error naming `127.0.0.1:9333` — not a stack trace.

### Verification

```bash
# Dry run: ensure no CDP:9222 contact.
lsof -iTCP:9222 -sTCP:LISTEN || echo "9222 not listening (good for CI)"

bun run test test/integration/playwright-mcp.test.ts   # expect: green

# Inspect screenshot artifact
ls -la /tmp/jellyclaw-test-artifacts/    # expect: at least one .png
```

### Common pitfalls

- **NEVER** default the test fixture to `9222`. Every reviewer must be able to glance at any test line and see `9333`.
- `npx @playwright/mcp@0.0.41` resolves via npm; with a strict firewall, pre-install: `bun add -d @playwright/mcp@0.0.41` and reference via `./node_modules/.bin/mcp-server-playwright` if you need offline determinism.
- Chrome headless: `--headless=new` (not the old `--headless`); old mode produces unstable CDP sessions.
- User-data-dir in `/tmp`: macOS symlinks `/tmp → /private/tmp`; Chrome sometimes rejects symlinked paths. Use `os.tmpdir()` and `realpathSync`.
- Leftover Chrome processes: if the test is killed mid-run, orphan Chrome instances squat the port. Teardown must `kill -9` by pgid on failure.
- Do NOT add Playwright as a runtime dependency of the engine — it's config-only + devDependency.
- Do NOT add ANY code under `engine/src/mcp/playwright*.ts` — the whole point is zero coupling. If you find yourself needing engine code for Playwright, stop and ask: it means the MCP abstraction is wrong.
- The MCP tool names must be exactly what `@playwright/mcp@0.0.41` exposes today (`browser_navigate`, `browser_click`, `browser_take_screenshot`, etc.). Fetch the tool list at test startup and log it so upstream renames are caught immediately.

<!-- BEGIN: paste from /Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/COMPLETION-UPDATE-TEMPLATE.md -->
<!-- On success: Phase 07 fully ✅, next prompt = prompts/phase-08/01-permission-modes.md. -->
<!-- END paste -->
