# Chrome MCP Integration Plan

**Status:** DRAFT (2026-04-17) — autobuild-ready, not yet approved.
**Owner:** George.
**Goal:** jellyclaw agents drive a real Chrome browser on macOS — navigate, click, snapshot, screenshot, extract — through the existing MCP substrate, with no fork of OpenCode, no paid keys, no hostile UX.

---

## TL;DR

1. **Primary:** `@playwright/mcp@^0.0.70` with Microsoft's "Playwright MCP Bridge" Chrome Web Store extension. One-click install, preserves user's default profile + logins, zero Chrome restart.
2. **Secondary:** `chrome-devtools-mcp@^0.21.0` (Google, Puppeteer-based) as opt-in for Lighthouse audits + CPU/network throttling + performance traces.
3. **Blocking prerequisite:** MCP is not wired into `jellyclaw run` (`engine/src/cli/run.ts:172-181` has a commented-out TODO — `mcp` stays `undefined`). Nothing Chrome-related works end-to-end until this lands. Fix is ~20 LOC.
4. **Pin bump:** `0.0.41 → 0.0.70` is one year overdue. No tool renames, no breaking CLI changes beyond the reverted `--no-sandbox` flag and the in-memory-profile default (v0.0.64).
5. **Chrome 136+ caveat:** `--remote-debugging-port` is blocked against Chrome's default profile since March 2025. The CDP "just flip a flag" flow is dead for default profiles. The extension bridge bypasses this cleanly; the dedicated-profile path is the fallback.
6. **Shape:** 7 prompts in 4 autobuild tiers (T0 prereq → T1 Chrome wire-up → T2 safety + test → T3 polish + optional secondary). Each prompt is self-contained and writes `DONE: <ID>` on success per the `scripts/autobuild-simple/run.sh` protocol.

---

## 1. Primary-source research receipts (verified 2026-04-17)

| Claim | Source |
|-------|--------|
| `@playwright/mcp@0.0.70` is npm `latest`, shipped 2026-04-01 | `registry.npmjs.org/@playwright/mcp` + `github.com/microsoft/playwright-mcp/releases` |
| "Playwright MCP Bridge" Chrome extension v0.1.0, 20k users, updated 2026-04-07 | `chromewebstore.google.com/detail/playwright-mcp-bridge/mmlmfjhmonkocbjadbfplnigmagldckm` |
| `chrome-devtools-mcp@0.21.0`, Google-maintained, Puppeteer-based, Apache-2.0 | `github.com/ChromeDevTools/chrome-devtools-mcp` + `registry.npmjs.org/chrome-devtools-mcp/latest` |
| Chrome 136 blocks default-profile CDP | `developer.chrome.com/blog/remote-debugging-port` |
| `hangwin/mcp-chrome` exists (11.2k★, MIT, v1.0.0, native-messaging bridge) | `github.com/hangwin/mcp-chrome` |
| `AgentDeskAI/browser-tools-mcp` abandoned by maintainer | repo README banner |

Tool-surface confirmation (verbatim from Playwright MCP HEAD README, matches the runtime MCP tool names Claude Code surfaces today):

- Core: `browser_navigate`, `browser_click`, `browser_type`, `browser_snapshot`, `browser_take_screenshot`, `browser_evaluate`, `browser_fill_form`, `browser_press_key`, `browser_wait_for`, `browser_tabs`, `browser_resize`, `browser_drag`, `browser_hover`, `browser_select_option`, `browser_file_upload`, `browser_handle_dialog`, `browser_console_messages`, `browser_network_requests`, `browser_run_code`, `browser_navigate_back`, `browser_close`.
- Opt-in `--caps`: storage, network, devtools, vision, pdf, testing.

---

## 2. Current repo state (evidence)

| Observation | Evidence |
|-------------|----------|
| Phase 07.03 (Playwright MCP via CDP:9333) shipped — but only wires MCP into `jellyclaw mcp list` and the gated integration test, NOT `jellyclaw run` | `phases/PHASE-07-mcp.md:64-75`, `test/integration/playwright-mcp.test.ts:37-228`, `engine/src/cli/mcp-cmd.ts:24, 190-207` |
| `run.ts` leaves `mcp` as `undefined` via commented-out TODO block | `engine/src/cli/run.ts:172-181` — verbatim `// TODO(T2-05): Load MCP config from settings.json…` |
| `server/run-manager.ts` has ZERO MCP code | grep -n mcp across whole file returns nothing |
| `@playwright/mcp@0.0.41` pinned in root `package.json` (devDep), NOT in `engine/package.json` — so `npm install @jellyclaw/engine` does NOT bring Playwright MCP | `package.json:68` |
| Three conflicting MCP config shapes/paths exist | `engine/src/config.ts:80-129` (array in `jellyclaw.json`), `engine/src/cli/doctor.ts:411-432` (`{servers:…}` in `~/.jellyclaw/mcp.json`), `engine/scripts/mcp-list.ts:27,33` (object map in `~/.jellyclaw/jellyclaw.json`) |
| No default MCP template ships | `find -name mcp.json` outside `node_modules` returns only the test fixture |
| Engine source has ZERO Chrome-specific code — all Chrome coupling lives in `test/`, `scripts/`, `docs/`, `prompts/` (by design) | `phases/README.md:11`, `prompts/phase-07/03-playwright-mcp-integration.md:134-135` |

The "engine knows nothing about Chrome" pillar means this whole integration is config + tests + docs — no new `engine/src/mcp/chrome*.ts` files.

---

## 3. Phase structure

**Slot:** `PHASE-07.5-chrome-mcp.md` — mirrors the `PHASE-10.5-tui.md` half-phase insert convention. Adjacent to Phase 07 (MCP client integration). Prompts in `prompts/phase-07.5/`.

**Prompt naming:** Autobuild-compatible `T<tier>-<seq>-<slug>.md` so the rig at `scripts/autobuild-simple/run.sh` can chain them with one PROMPTS_DIR swap.

**Tiers:**

| Tier | Purpose | Gating |
|------|---------|--------|
| T0 | Prereq wiring — unblocks every MCP feature, not just Chrome | Must land before T1 |
| T1 | Chrome MCP wire-up — Playwright MCP@0.0.70 + Chrome-launch helper | T0 complete |
| T2 | Safety — permissions + rate limit + integration test | T1 complete |
| T3 | Polish — docs + optional chrome-devtools-mcp secondary | T2 complete |

**Full prompt list:**

| ID | File | Summary |
|----|------|---------|
| T0-01 | `T0-01-wire-mcp-run-path.md` | Wire `McpRegistry` into `cli/run.ts` + `server/run-manager.ts`. Load from `--mcp-config` flag, `<cwd>/jellyclaw.json`, `~/.jellyclaw/jellyclaw.json`. Pass to `runAgentLoop`. |
| T0-02 | `T0-02-canonicalize-mcp-config.md` | Kill doctor.ts's `~/.jellyclaw/mcp.json` + `{servers:…}` shape. One path, one shape. Ship `engine/templates/mcp.default.json`. |
| T1-01 | `T1-01-bump-playwright-mcp-pin.md` | Bump `@playwright/mcp` 0.0.41 → 0.0.70. Update `patches/004-playwright-mcp-pin.md` with verification receipts + Chrome Web Store extension note. Reverify tool parity via `engine/scripts/mcp-list.ts`. |
| T1-02 | `T1-02-chrome-launch-helper.md` | `scripts/jellyclaw-chrome.sh` — launches Chrome on dedicated profile (`~/Library/Application Support/jellyclaw-chrome-profile`), respecting Chrome 136+ default-profile block. Doctor check that detects CDP reachability. |
| T2-01 | `T2-01-browser-permissions-and-ratelimit.md` | Default permission rules: `browser_evaluate`, `browser_run_code`, `browser_file_upload` → `ask` regardless of `--permission-mode`. Rate-limit bucket `browser:60/min`. |
| T2-02 | `T2-02-chrome-mcp-integration-test.md` | `JELLYCLAW_CHROME_MCP_TEST=1` gated test: `jellyclaw run "navigate to example.com and screenshot"` end-to-end. Asserts PNG artifact + MCP teardown clean. |
| T3-01 | `T3-01-docs-and-templates.md` | `docs/mcp.md` Chrome section rewrite. New `docs/chrome-setup.md` covering Flow 1 (extension) + Flow 2 (dedicated profile) + troubleshooting. Example entries added to `engine/templates/mcp.default.json`. |
| T3-02 | `T3-02-chrome-devtools-mcp-optional.md` | OPTIONAL: add `chrome-devtools-mcp@^0.21.0` as secondary for Lighthouse + performance. Document as `--caps devtools` opt-in. |

---

## 4. Flow choices explained

### Flow 1 — Chrome Web Store extension bridge (default recommendation)

```
[jellyclaw run]
   ↓ spawns
[npx @playwright/mcp@0.0.70 --extension]
   ↓ connects via PLAYWRIGHT_MCP_EXTENSION_TOKEN
[User's Chrome (normal profile, logins intact)]
   ↓ tab-picker on first use
[active tab: agent can navigate / click / snapshot]
```

**Pros:** zero Chrome restart, default profile, real logins, Microsoft-signed ext from Web Store.
**Cons:** one-time extension install, user sees a tab-picker prompt on first connection.
**Security:** per-profile token — reinstall ext to rotate.

### Flow 2 — Dedicated debug profile (fallback for extension-averse users)

```
[jellyclaw-chrome.sh]
   ↓ launches
[Google Chrome --remote-debugging-port=9333 \
                --user-data-dir=~/Library/Application Support/jellyclaw-chrome-profile]
   ↓
[jellyclaw run]
   ↓
[npx @playwright/mcp@0.0.70 --cdp-endpoint http://127.0.0.1:9333]
```

**Pros:** no ext, fully scripted.
**Cons:** second Chrome dock icon, user must log in again inside jellyclaw-chrome-profile (once; persists thereafter). Chrome 136+ hard requirement.

### Flow 3 — auto-launched ephemeral Chrome (for CI / headless)

```
[jellyclaw run --browser-isolated]
   ↓
[npx @playwright/mcp@0.0.70]   # no --extension, no --cdp-endpoint
   ↓
[Playwright-managed Chromium at ~/Library/Caches/ms-playwright/mcp-<hash>]
```

**Pros:** zero user interaction, clean state every run.
**Cons:** no user sessions — purely throwaway.

The plan ships Flow 2 as the documented BYOC default (Flow 1 is one-paragraph-in-docs because it requires a Web Store install we can't automate). Flow 3 is the default for headless CI and for `jellyclaw run` when no `mcp-config` is user-provided.

---

## 5. Security posture — AUTONOMOUS MODE (locked 2026-04-17)

**Decision locked by George:** the browser MCP runs in FULLY AUTONOMOUS mode. No confirmation prompts, no `ask` carve-outs, no permission dialogs for `browser_evaluate` / `browser_run_code` / `browser_file_upload`. This matches Claude Code's own pattern for this project: wildcard allowlist in `~/.claude/settings.json` (`"mcp__playwright__*"`) + `defaultMode: "dontAsk"`. The agent owns its Chrome window end-to-end; the user logs in once to the dedicated profile and the agent reuses those sessions across every run.

What IS enforced:

- **Rate limiter** — `browser:60/min` burst 10 via existing `engine/src/ratelimit/*`. Gates every `mcp__*__browser_*` call (runaway protection, not authorization). On exhaustion emits `tool.error code="rate_limited"`. This is the ONLY safety gate on the browser path.
- **`--caps` opt-in** — storage/network/devtools/vision capabilities OFF in the default Playwright MCP invocation. User explicitly extends args to unlock if they want them.
- **Secret scrubbing** — screenshots and DOM extracts go through existing `engine/src/security/scrub.ts` before being sent back to the model. Already wired.
- **Profile isolation** — agent-owned Chrome runs on a dedicated `--user-data-dir` (`~/Library/Application Support/jellyclaw-chrome-profile`), entirely separate from the user's default Chrome. User logs in once inside this profile; sessions persist across all runs forever.

What we deliberately do NOT do:

- No `ask` carve-out for "dangerous" tools. George wants the agent to do real work without babysitting.
- No `--allowed-origins` allowlist in the default template. The agent navigates wherever the prompt sends it.
- No per-tool permission rules. The wildcard `mcp__playwright__*` allow is the contract.

---

## 6. Execution — how to autobuild

The existing orchestrator at `scripts/autobuild-simple/run.sh:28` has a hardcoded `PROMPTS_DIR="$REPO/prompts/phase-99b-unfucking-v2"`. Two ways to aim it at Phase-07.5:

**Option A (one-line edit, recommended):**
Change line 28 to:
```bash
PROMPTS_DIR="${PROMPTS_DIR:-$REPO/prompts/phase-99b-unfucking-v2}"
```
Then run:
```bash
PROMPTS_DIR=/Users/gtrush/Downloads/jellyclaw-engine/prompts/phase-07.5 \
  scripts/autobuild-simple/run-phases.sh T0 T1 T2 T3
```

**Option B (no script edit):**
Copy `scripts/autobuild-simple/` to `scripts/autobuild-chrome-mcp/` and change line 28 there. Run `scripts/autobuild-chrome-mcp/run-phases.sh T0 T1 T2 T3`.

Each prompt prints `DONE: <ID>` on success or `FAIL: <ID> <reason>` — the rig gates tier-to-tier on that marker.

Per George's discipline rules: no autonomous branches, no autonomous commits. Each prompt edits files locally; George cuts branches if he likes the result.

---

## 7. Decisions locked (2026-04-17) + remaining risks

### Decisions
1. **Flow 2 (dedicated agent-owned Chrome profile) is THE default.** Matches the jelly-claw app pattern — agent gets its own persistent Chrome window, user logs in once, sessions persist forever. `~/Library/Application Support/jellyclaw-chrome-profile` is the stable path. Flow 1 (Web Store extension) and Flow 3 (ephemeral) remain documented but not default.
2. **`chrome-devtools-mcp` (T3-02) — DEFERRED.** Skip for now. Phase 07.5 closes at T3-01. T3-02 stays in the repo as a future opt-in prompt.
3. **Autonomous mode — NO confirmation prompts for browser tools.** All `mcp__playwright__*` tools run under default allow, matching the Claude Code pattern (`"mcp__plugin_compound-engineering_pw__*"` + `defaultMode: "dontAsk"`). The carve-out for `browser_evaluate` / `browser_run_code` / `browser_file_upload` is removed. T2-01 has been updated to reflect this.
4. **Tauri desktop integration — OUT OF SCOPE.** Phase 07.5 touches zero Tauri files. The desktop can pick up Chrome-MCP status indication in a later phase.
5. **Naming — `chrome-mcp` stays.** Matches George's brief.

### Remaining risks
- **Playwright 1.60-alpha transitive dep in 0.0.70** may clash if jellyclaw later bundles Playwright elsewhere at stable 1.59. Low likelihood; flag at dep-graph review.
- **Chrome 136+ default-profile block** — already handled by the dedicated profile path in `scripts/jellyclaw-chrome.sh`.
- **Runaway loops under autonomous mode** — rate limiter is the only guard (60/min burst 10). If a prompt goes pathological, the user hits the bucket and gets `rate_limited` errors. Worst case user burns 60 Chrome operations per minute — acceptable.
- **Autonomous `browser_run_code`** — the agent can execute arbitrary JS in any page context without prompting. This is explicit design, not an accident. Documented in `docs/chrome-setup.md`.

---

## 8. File inventory — what this plan creates

Files produced by reading this plan (I have already written these):

- `docs/CHROME-MCP-INTEGRATION-PLAN.md` ← this file
- `phases/PHASE-07.5-chrome-mcp.md`
- `prompts/phase-07.5/T0-01-wire-mcp-run-path.md`
- `prompts/phase-07.5/T0-02-canonicalize-mcp-config.md`
- `prompts/phase-07.5/T1-01-bump-playwright-mcp-pin.md`
- `prompts/phase-07.5/T1-02-chrome-launch-helper.md`
- `prompts/phase-07.5/T2-01-browser-permissions-and-ratelimit.md`
- `prompts/phase-07.5/T2-02-chrome-mcp-integration-test.md`
- `prompts/phase-07.5/T3-01-docs-and-templates.md`
- `prompts/phase-07.5/T3-02-chrome-devtools-mcp-optional.md`

Files touched by the autobuild when the prompts execute:

- `engine/src/cli/run.ts` (T0-01, T2-01)
- `engine/src/server/run-manager.ts` (T0-01)
- `engine/src/cli/mcp-config-loader.ts` (new, T0-01)
- `engine/src/cli/doctor.ts` (T0-02, T1-02)
- `engine/src/config.ts` (T0-02)
- `engine/src/permissions/rules.ts` (T2-01)
- `engine/src/ratelimit/policies.ts` (T2-01)
- `engine/templates/mcp.default.json` (new, T0-02, T3-01)
- `scripts/jellyclaw-chrome.sh` (new, T1-02)
- `package.json` (T1-01) — pin bump
- `patches/004-playwright-mcp-pin.md` (T1-01)
- `test/integration/chrome-mcp.test.ts` (new, T2-02)
- `docs/mcp.md` (T3-01)
- `docs/chrome-setup.md` (new, T3-01)
- `engine/src/mcp/registry.ts` (T3-02, if we ship secondary)
- `COMPLETION-LOG.md` + `STATUS.md` (each prompt, per existing convention)

*End of plan. Nothing outside these files is modified. No branches, no commits.*
