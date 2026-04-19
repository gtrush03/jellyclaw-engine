---
phase: "07.5"
name: "Chrome MCP"
duration: "3 days"
depends_on: [07]
blocks: [12, 16]
---

# Phase 07.5 — Chrome MCP

## Dream outcome

A user runs `jellyclaw run "open example.com, click the About link, take a screenshot"` and a real Chrome browser on their Mac navigates, clicks, and saves a PNG. The agent sees the page DOM, screenshots, and console output as MCP tool results. No paid API keys, no fork of OpenCode, no ship of a custom Chrome — just MCP configuration that drops Microsoft's `@playwright/mcp` (primary) and Google's `chrome-devtools-mcp` (opt-in secondary) into jellyclaw's already-built MCP substrate.

Two bring-your-own-Chrome (BYOC) flows are supported: (1) the Chrome Web Store extension "Playwright MCP Bridge" for users who want their real Chrome profile with all existing logins, and (2) a dedicated debug profile at `~/Library/Application Support/jellyclaw-chrome-profile` for users who want a scripted, sandboxed Chrome. A headless ephemeral Chromium path is the default for CI.

## Deliverables

- `engine/src/cli/mcp-config-loader.ts` — merges `--mcp-config`, `<cwd>/jellyclaw.json`, `~/.jellyclaw/jellyclaw.json` into a single `McpServerConfig[]`
- `engine/src/cli/run.ts` — wires `McpRegistry` into the run path (the load-bearing TODO closure)
- `engine/src/server/run-manager.ts` — wires `McpRegistry` into the HTTP serve path
- `engine/templates/mcp.default.json` — canonical default MCP template with Playwright MCP commented stanza
- `scripts/jellyclaw-chrome.sh` — Chrome launcher helper for BYOC Flow 2
- `test/integration/chrome-mcp.test.ts` — env-gated E2E that drives `jellyclaw run` → Chrome → screenshot
- `docs/chrome-setup.md` — user-facing quickstart for both BYOC flows
- Updated `docs/mcp.md` Chrome section
- Updated `patches/004-playwright-mcp-pin.md` with v0.0.70 receipts
- Rate-limit bucket + permission defaults for dangerous browser tools

## Tool audit

**Primary MCP:** `@playwright/mcp@^0.0.70` (Microsoft, Apache-2.0).
**Secondary MCP (optional):** `chrome-devtools-mcp@^0.21.0` (Google, Apache-2.0, Puppeteer-based).

Playwright MCP tool surface (always-on core, exact names):
- Navigation: `browser_navigate`, `browser_navigate_back`, `browser_tabs`, `browser_wait_for`, `browser_close`
- Interaction: `browser_click`, `browser_type`, `browser_hover`, `browser_drag`, `browser_press_key`, `browser_select_option`, `browser_fill_form`, `browser_file_upload`, `browser_handle_dialog`, `browser_resize`
- Observation: `browser_snapshot`, `browser_take_screenshot`, `browser_console_messages`, `browser_network_requests`
- Execution (DANGEROUS, default `ask`): `browser_evaluate`, `browser_run_code`

Opt-in `--caps` surfaces: storage, network, devtools, vision, pdf, testing.

## Step-by-step

### Step 1 — T0-01 — Wire MCP into `jellyclaw run`

Close the `// TODO(T2-05)` block at `engine/src/cli/run.ts:172-181`. Introduce `engine/src/cli/mcp-config-loader.ts` that merges up to three sources: `--mcp-config <path>` CLI flag (parsed at `cli/main.ts:95`, currently dropped), `<cwd>/jellyclaw.json` `.mcp[]`, and `~/.jellyclaw/jellyclaw.json` `.mcp[]`. Pass `mcp` into `runAgentLoop`. Mirror the fix into `engine/src/server/run-manager.ts:609-622` so the HTTP `serve` path gets parity. Fix the existing `ANTHROPIC_API_KEY`-only credential check at `cli/run.ts:137-140` to use `loadCredentials()` from `engine/src/cli/credentials.ts`.

### Step 2 — T0-02 — Canonicalize the MCP config path

Kill the `~/.jellyclaw/mcp.json` + `{servers:…}` reader in `engine/src/cli/doctor.ts:411-432` and the different-shape reader in `engine/scripts/mcp-list.ts:27,33`. Unify on `<cwd>/jellyclaw.json` + `~/.jellyclaw/jellyclaw.json` with the `.mcp[]` array shape validated by the existing zod schema at `engine/src/config.ts:80-129`. Ship `engine/templates/mcp.default.json` as the user-facing template referenced by docs.

### Step 3 — T1-01 — Bump `@playwright/mcp` pin

Bump `package.json:68` from `@playwright/mcp@0.0.41` to `@playwright/mcp@^0.0.70`. Verify tool-list parity via `bun run engine/scripts/mcp-list.ts` before touching anything else. Rewrite `patches/004-playwright-mcp-pin.md` with current receipts (npm registry + GitHub releases) and add a "Chrome Web Store extension" subsection explaining Flow 1 (BYOC via `--extension`). Also move `@playwright/mcp` from root `package.json` devDep into `engine/package.json` so `npm install @jellyclaw/engine` brings it along.

### Step 4 — T1-02 — Chrome launch helper (Flow 2)

Ship `scripts/jellyclaw-chrome.sh` that launches Chrome with `--remote-debugging-port=9333 --user-data-dir="$HOME/Library/Application Support/jellyclaw-chrome-profile"`. Respects the Chrome 136+ default-profile block. Add a doctor check in `engine/src/cli/doctor.ts` that probes `http://127.0.0.1:9333/json/version` and reports whether a debuggable Chrome is reachable. Doctor should also verify `/Applications/Google Chrome.app` exists; if missing, suggest `brew install --cask google-chrome` or the Chrome Web Store extension path.

### Step 5 — T2-01 — Autonomous allowlist + rate limit

Add `mcp__playwright__*` and `mcp__playwright-extension__*` to the DEFAULT allow patterns in `engine/src/permissions/rules.ts`. Wildcard match covers every current + future Playwright MCP tool. NO carve-outs — `browser_evaluate`, `browser_run_code`, `browser_file_upload` all run autonomously. This matches the Claude Code pattern (`"mcp__plugin_compound-engineering_pw__*"` + `defaultMode: "dontAsk"` in `~/.claude/settings.json`). Add a `browser:60/min` burst 10 rate-limit bucket in `engine/src/ratelimit/policies.ts` — the ONLY safety gate on the browser path. Emits `tool.error code="rate_limited"` on exhaustion. Wire it into the MCP dispatch branch at `engine/src/agents/loop.ts:617-680`.

### Step 6 — T2-02 — Integration test

Add `test/integration/chrome-mcp.test.ts` gated behind `JELLYCLAW_CHROME_MCP_TEST=1`. Spawns `jellyclaw run "navigate to https://example.com and take a screenshot"` with a test fixture at `test/fixtures/mcp/chrome-test-config.json`. Asserts: MCP tools register (`mcp__playwright__browser_*` present in `listTools()`), `browser_navigate` + `browser_take_screenshot` both return `isError: false`, PNG artifact exists at `${tmpdir()}/jellyclaw-test-artifacts/chrome-mcp-*.png`, teardown kills Chrome + removes profile dir cleanly. Forbid port `9222` per the existing convention at `test/integration/playwright-mcp.test.ts:43`.

### Step 7 — T3-01 — Docs + templates

Rewrite `docs/mcp.md` Chrome subsection. New file `docs/chrome-setup.md` with three-flow walkthrough (extension bridge, dedicated profile, ephemeral CI). Update `engine/templates/mcp.default.json` with commented-out Playwright MCP stanza. Link from `docs/mcp.md` and from README.

### Step 8 — T3-02 — Optional: `chrome-devtools-mcp` secondary

Add `chrome-devtools-mcp@^0.21.0` as a second MCP stanza in the template, commented out by default. Document as opt-in for Lighthouse audits + performance traces. Note that it uses Puppeteer + CDP (not Playwright), launches its own Chrome unless given `--browserUrl`, and expects `--user-data-dir` for Chrome 136+ compatibility. Disable `--performance-crux` and `--usage-statistics` telemetry by default in the template.

## Acceptance criteria

- [ ] `jellyclaw run` loads MCP config from `--mcp-config` / `<cwd>/jellyclaw.json` / `~/.jellyclaw/jellyclaw.json` and exposes namespaced tools (`mcp__playwright__browser_*`) to the model
- [ ] `jellyclaw serve` parity: HTTP run-manager also loads MCP
- [ ] `@playwright/mcp` pin is `^0.0.70`, shipped as `engine/` dependency (not just root devDep)
- [ ] `patches/004-playwright-mcp-pin.md` updated with 2026-04 receipts
- [ ] `scripts/jellyclaw-chrome.sh` launches Chrome on 9333 with dedicated profile, survives Chrome 136+ default-profile block
- [ ] `mcp__playwright__*` tools run autonomously — NO `permission.requested` / `permission.granted` events for any browser tool call (matches Claude Code pattern)
- [ ] `browser:60/min` (burst 10) rate limit applies to all `mcp__*__browser_*` tool calls; 70 rapid calls yield 60 successes + 10 `rate_limited` errors
- [ ] `JELLYCLAW_CHROME_MCP_TEST=1 bun run test chrome-mcp` passes end-to-end with a real screenshot artifact
- [ ] `docs/chrome-setup.md` exists with both BYOC flows walked through
- [ ] `engine/templates/mcp.default.json` has Playwright + chrome-devtools entries
- [ ] `bun run typecheck && bun run build && bun run lint` green
- [ ] No new files under `engine/src/mcp/chrome*.ts` — engine stays Chrome-agnostic (design pillar)

## Risks + mitigations

- **Chrome 136+ default-profile block** → shipped dedicated-profile flow (Flow 2) respects it; document extension bridge (Flow 1) as the upgrade for users who want their real profile
- **Playwright 1.60-alpha transitive dep in 0.0.70** → not a blocker but flag in the pin-rationale doc; monitor the `next` dist-tag for a stable 1.60 release
- **`browser_run_code` blast radius even with `ask`** → consider flipping to `deny` default, require explicit user config to `ask`; T2-01 makes the call
- **Three conflicting MCP config shapes today** → T0-02 collapses to one; doctor and mcp-list commands both use the same loader
- **Tauri webview just fixed but cosmetic** → out of scope; Phase 16 owns it

## Dependencies to install

```
@playwright/mcp@^0.0.70            # engine/package.json (bumped from root 0.0.41 devDep)
chrome-devtools-mcp@^0.21.0        # engine/package.json (optional, T3-02)
```

No new engine-side source deps required beyond these MCP servers.

## Files touched

- `engine/src/cli/run.ts` (T0-01, T2-01)
- `engine/src/server/run-manager.ts` (T0-01)
- `engine/src/cli/mcp-config-loader.ts` (new, T0-01)
- `engine/src/cli/doctor.ts` (T0-02, T1-02)
- `engine/src/config.ts` (T0-02)
- `engine/src/permissions/rules.ts` (T2-01)
- `engine/src/ratelimit/policies.ts` (T2-01)
- `engine/src/agents/loop.ts` (T2-01 — wire rate limiter into tool dispatch)
- `engine/templates/mcp.default.json` (new, T0-02 + T3-01)
- `scripts/jellyclaw-chrome.sh` (new, T1-02)
- `package.json` + `engine/package.json` (T1-01)
- `patches/004-playwright-mcp-pin.md` (T1-01)
- `test/integration/chrome-mcp.test.ts` (new, T2-02)
- `test/fixtures/mcp/chrome-test-config.json` (new, T2-02)
- `docs/mcp.md` (T3-01)
- `docs/chrome-setup.md` (new, T3-01)
- `COMPLETION-LOG.md` + `STATUS.md` (per-prompt, existing convention)
