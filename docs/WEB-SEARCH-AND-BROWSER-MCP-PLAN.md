# Plan — Web Search + Browser MCP integration

**Status:** DRAFT (2026-04-17) — investigation synthesis, not yet approved.
**Owner:** George.
**Inputs:** four parallel Opus-UltraThink agent runs (repo map, CLI trace, live interaction, candidate research).
**Scope:** add inline web search and Chrome/browser automation to jellyclaw **without forking OpenCode** and **without paid API keys by default**.

---

## 0. TL;DR

1. Web search → **wire Exa hosted MCP at `https://mcp.exa.ai/mcp` over HTTP transport**. No auth, no install, MIT-backed, and it is exactly what OpenCode already does internally. DuckDuckGo MCP (`uvx duckduckgo-mcp-server`) is the documented fallback for users who want zero third-party dependency.
2. Browser → **keep `@playwright/mcp`, bump the pin from `0.0.41` → `0.0.70`** (one year stale). Add `jae-jae/fetcher-mcp` as an optional lightweight companion for Readability-style page extraction.
3. **Neither feature ships until two blocking bugs land first** — the run path ignores `~/.jellyclaw/credentials.json`, and the run path doesn't instantiate `McpRegistry` at all. Both are ~20-line fixes but they block every MCP feature end-to-end.
4. Execution plan is config-first: the server-tool route (Anthropic's `web_search_20250305`) is documented as an optional upgrade but **not** the default because it requires an SDK bump, an adapter rewrite, and provider lock-in.

---

## 1. What exists today (empirically verified, 2026-04-17)

### 1.1 Engine state

| Area | State | Evidence |
|------|-------|----------|
| Build | clean under bun 1.3.5 | `bun run typecheck` 0; `bun run build` 0 |
| Tests | 1889 / 16 failing (all stale tests vs. autobuild, not broken runtime) | `bun run test` exit 1 |
| CLI entry | `engine/bin/jellyclaw` → `engine/dist/cli/main.js` (Commander) | `engine/bin/jellyclaw:5`, `engine/src/cli/main.ts:72-441` |
| Tool registry | 24 built-in tools, all in-process (not through OpenCode HTTP) | `engine/src/tools/index.ts:35-60` |
| Cache breakpoints | 3 of SPEC's 4 planted at `system` / `tools.last()` / `memory.skills` | `engine/src/providers/cache-breakpoints.ts:65` |
| MCP stack | full: stdio + HTTP (Streamable) + SSE + OAuth + token store | `engine/src/mcp/*` |
| MCP in the run hot path | **not wired** (`let mcp: McpRegistry \| undefined`) | `engine/src/cli/run.ts:172-181` |
| `WebSearch` tool | registered but throws `WebSearchNotConfiguredError` | `engine/src/tools/websearch.ts:29-40`, `engine/src/tools/index.ts:58` |
| `@playwright/mcp` | pinned `0.0.41` in **root** `package.json` devDeps only | `package.json:68` |
| Default `mcp.json` | none ships; `docs/playwright-setup.md` tells user to hand-edit | — |
| Tauri desktop | panics on launch (`plugins.shell.scope` removed in Tauri v2) | `desktop/src-tauri/tauri.conf.json:46-55`, crash at `desktop/src-tauri/src/main.rs:108` |

### 1.2 Three blocking papercuts for any MCP feature

| # | Where | Symptom | Fix shape |
|---|-------|---------|-----------|
| A | `engine/src/cli/run.ts:137-140` | Ignores `~/.jellyclaw/credentials.json`; requires `ANTHROPIC_API_KEY` env | Call `loadCredentials()` + `selectAuth()` (both already exist) |
| B | `engine/src/cli/run.ts:172-181` | `mcp` left `undefined`, so no MCP tool ever reaches the model via `jellyclaw run` | Load config, `new McpRegistry`, `await mcp.start(configs)`, pass to `runAgentLoop` |
| C | Three MCP-config shapes/paths (`config.ts` array, `doctor.ts` `{servers}`, `mcp-cmd.ts` array) | Unclear which file a user should edit | Pick `<cwd>/jellyclaw.json` + `~/.jellyclaw/jellyclaw.json` (both merged); delete the `{servers}` shape in `doctor.ts` |

These three must land in the same PR as Feature A or as a "wiring" PR immediately before.

### 1.3 SPEC drift worth knowing (do not fix as part of this work)

- SPEC §2 forbids a TUI; `engine/src/tui/*` (~30 files) ships one. Leave it alone — not our problem for this feature.
- SPEC §4/§11 describe tools executing via an OpenCode HTTP server on `127.0.0.1:<random>`. Reality: tools run in-process and `startOpenCode()` has no production caller. Leave alone.
- SPEC §13 says the permission gate is in the "provider wrapper." Reality: it's in the agent loop (`engine/src/agents/loop.ts:566-581`). Semantically correct, spec wording is stale.
- `engine/src/cli/run.ts:247` hard-codes `claude-opus-4-6`. Overrides `--model`. Out of scope for this plan; note and move on.

---

## 2. Feature A — Web search

### 2.1 Decision: Exa hosted MCP (primary), DuckDuckGo MCP (fallback)

| Candidate | Transport | Cost | Install | License | Verdict |
|-----------|-----------|------|---------|---------|---------|
| **Exa hosted MCP** `https://mcp.exa.ai/mcp` | HTTP (Streamable) | Free w/ rate limit; bring-your-own-Exa-key lifts it | **none** | MIT server / TOS-bound hosted | **Primary** |
| `nickclyde/duckduckgo-mcp-server` | stdio | Free, 30 req/min built-in | `uvx duckduckgo-mcp-server` (Python) | MIT | **Documented fallback** |
| `deedy5/ddgs[mcp]` | stdio | Free | `pip` | MIT | Rejected — scrapes Google/Bing, ToS risk |
| Brave MCP / Tavily / Kagi / Exa-with-key | various | paid or key-bound | various | MIT | Rejected — violates "free, no key" rule |
| SearxNG MCPs | stdio | Free but needs self-hosted SearxNG | extra service | AGPL-3.0 (SearxNG) | Rejected — operational overhead, licensing taint if bundled |
| `@modelcontextprotocol/server-brave-search` | — | — | — | — | Archived upstream |

Why Exa is the right default, in one paragraph: OpenCode's own `packages/opencode/src/tool/mcp-exa.ts` already hits `https://mcp.exa.ai/mcp` with no Authorization header — meaning the endpoint is genuinely free, genuinely open, and the contract is battle-tested by the substrate we already depend on. jellyclaw's `McpRegistry` supports HTTP transport today (`engine/src/mcp/client-http.ts`). The integration is literally a config entry — zero new code, zero new dependencies — and the upgrade path to paid is "add an `Authorization` header."

### 2.2 Integration — config only

Add to a new default template `engine/templates/mcp.default.json` (and document it in `docs/mcp.md`):

```jsonc
{
  "mcp": [
    {
      "transport": "http",
      "name": "exa",
      "url": "https://mcp.exa.ai/mcp"
      // Production limits: set EXA_API_KEY and add
      // "headers": { "Authorization": "Bearer ${EXA_API_KEY}" }
    }
  ]
}
```

Tools the model sees after this lands (via `engine/src/agents/loop.ts:1004-1018`):

- `mcp__exa__web_search_exa`
- `mcp__exa__get_code_context_exa`

### 2.3 The `WebSearch` stub

Today: `engine/src/tools/websearch.ts` registers `WebSearch` which always throws. This causes the model to see two overlapping tools (`WebSearch` broken, `mcp__exa__web_search_exa` working). Two options:

**Option 2.3a (recommended, minimal) — delete the stub.** Remove `websearchTool` from `builtinTools` at `engine/src/tools/index.ts:58`. Remove `engine/src/tools/websearch.ts`. Delete `WebSearchNotConfiguredError` from `engine/src/tools/types.ts:276-285`. Update `test/unit/tools/parity.test.ts` expectations (it already fails per §1.1). The model will see only the working MCP variants.

**Option 2.3b (future, not now) — implement `WebSearch` as a native tool that dispatches to the configured MCP internally.** More invasive. Defer to a later phase.

### 2.4 Anthropic server-tool route (`web_search_20250305`) — documented but NOT default

Appending `{ type: "web_search_20250305", name: "web_search", max_uses: N }` to the Anthropic `tools` array would let the MODEL invoke Anthropic's own search with no local execution at all. It is cheaper per call than MCP and requires no MCP plumbing. Costs:

1. `@anthropic-ai/sdk` is pinned `^0.40.0` (`engine/package.json:54`). Server-tool types landed post-0.40. Must bump to 0.71+ (co-installed via transitive already) and widen `ProviderRequest.tools: Anthropic.Messages.Tool[]` → `ToolUnion[]` at `engine/src/providers/types.ts:35`.
2. Cache breakpoint planner at `engine/src/providers/cache-breakpoints.ts:88-104` puts `cache_control` on `tools.at(-1)`. Must special-case "skip server-tool entries" or append server-tools BEFORE the last built-in.
3. `engine/src/providers/adapter.ts` doesn't translate `server_tool_use` or `web_search_tool_result` SSE event shapes. Needs two new branches.
4. Provider lock-in: only works on Anthropic-direct, not on OpenRouter. Contradicts jellyclaw's provider-neutral posture.

**Verdict:** document in `docs/tools.md` as an opt-in via `config.providers.anthropic.webSearch.serverTool: true`, but ship the MCP route as default. Revisit when SDK bump happens for unrelated reasons.

---

## 3. Feature B — Browser MCP

### 3.1 Decision: keep `@playwright/mcp`, unpin `0.0.41` → `0.0.70`

`patches/004-playwright-mcp-pin.md` justifies `0.0.41` because "tool definitions are missing from the server manifest in newer releases." Upstream README for v0.0.70 (released 2025-04-01, one year before today) explicitly documents every tool the pin doc names (`browser_fill_form`, `browser_select_option`, `browser_run_code`, `browser_tabs`). Pin rationale is stale. Microsoft ships monthly releases, 31k★, Apache-2.0.

Secondary option: `jae-jae/fetcher-mcp` (Playwright-backed fetch-only, Mozilla Readability + Turndown). Cheaper per call for "give me the rendered text of this URL" use cases. Optional add-on, not a replacement.

Rejected:

- `@modelcontextprotocol/server-puppeteer` — archived upstream.
- `AgentDeskAI/browser-tools-mcp` — "no longer active" per its own README; also needs Chrome extension (wrong architecture for headless agents).
- `co-browser/browser-use-mcp-server`, `Saik0s/mcp-browser-use` — mandatory extra `OPENAI_API_KEY`. Second per-token cost on top of the user's primary Anthropic/OpenRouter spend. Breaks provider neutrality.
- `browser-use` raw lib — not an MCP; wrapping it is days of work.
- Stagehand — not an MCP; Browserbase-leaning.

### 3.2 Verification step before bumping the pin

Before updating `patches/004-playwright-mcp-pin.md` + the actual version string:

1. `npx @playwright/mcp@0.0.70 --help` — confirm install on macOS arm64.
2. `bun run engine/scripts/mcp-list.ts` against a temporary `~/.jellyclaw/jellyclaw.json` with the v0.0.70 entry — confirm all tools listed in `patches/004-playwright-mcp-pin.md` are present.
3. Run `test/integration/playwright-mcp.test.ts` with `JELLYCLAW_PW_MCP_TEST=1` — the existing smoke test is the regression gate.
4. If clean: update the pin string + the patch-doc rationale (per CLAUDE.md "update the previous phase doc instead of silently fixing the symptom").

### 3.3 Integration — config + doctor

Add to the default template alongside Exa:

```jsonc
{
  "transport": "stdio",
  "name": "playwright",
  "command": "npx",
  "args": [
    "-y", "@playwright/mcp@0.0.70",
    "--browser", "chrome",
    "--cdp-endpoint", "http://127.0.0.1:9333"
  ]
}
```

Doctor check additions (`engine/src/cli/doctor.ts`):

- `chromium` installed? (`npx playwright install chromium --dry-run` or equivalent)
- `CDP:9333` reachable? (already probed by `test/integration/playwright-mcp.test.ts`)

### 3.4 Rate-limit + permissions posture

Playwright tools are powerful and destructive (`browser_evaluate`, `browser_run_code`, `browser_file_upload`). Default policy should be `ask` via `permissions.rules` under a new key:

```jsonc
"permissions": {
  "mcp__playwright__browser_evaluate": "ask",
  "mcp__playwright__browser_run_code": "ask",
  "mcp__playwright__browser_file_upload": "ask"
}
```

Rate limiter (`engine/src/ratelimit/`) should get a `browser` bucket — 60 req/min default. Prevents runaway loops.

---

## 4. Pre-work: the three blocking fixes

All three are required before Feature A or B can be tested end-to-end through `jellyclaw run`.

### 4.1 Fix A — wire `loadCredentials()` into the run path

File: `engine/src/cli/run.ts:137-140`.

Sketch:

```ts
// before (today):
const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) throw new ExitError(1, "jellyclaw: ANTHROPIC_API_KEY not set…");

// after:
const creds = await loadCredentials(); // engine/src/cli/credentials.ts
const auth = selectAuth(creds, parseRole(opts));
if (auth.kind === "none") {
  throw new ExitError(1, "jellyclaw: no credentials. Run `jellyclaw auth login` or `jellyclaw key set`.");
}
// then pass `auth` into new AnthropicProvider({ auth, … })
```

Matches what `engine/src/cli/auth-cmd.ts`, `engine/src/cli/doctor.ts`, `engine/src/cli/tui.ts` already do.

Test: add `engine/src/cli/run.test.ts` case — `~/.jellyclaw/credentials.json` with only `anthropicApiKey` and unset env, `jellyclaw run "hi" --max-turns 1` succeeds.

### 4.2 Fix B — instantiate `McpRegistry` on the run path

File: `engine/src/cli/run.ts:172-181`.

Sketch:

```ts
// before:
let mcp: McpRegistry | undefined;
// TODO(T2-05): Load MCP config from settings.json

// after:
const mcpConfigs = await loadMcpConfigs(opts.mcpConfig, opts.configDir, opts.cwd);
const mcp = mcpConfigs.length > 0 ? new McpRegistry({ logger }) : undefined;
if (mcp) await mcp.start(mcpConfigs);
```

Where `loadMcpConfigs` resolves and merges:

1. `--mcp-config <path>` if set (already parsed at `cli/main.ts:95`, currently ignored).
2. `<cwd>/jellyclaw.json` (array shape at `.mcp`).
3. `~/.jellyclaw/jellyclaw.json` (same shape).

And passes `mcp` to `runAgentLoop` at `cli/run.ts:350`.

Same fix for `engine/src/server/run-manager.ts:609-622` (the `serve` path).

Teardown: already handled — `realRunFn`'s `finally` at `cli/run.ts:355-362` calls `mcp?.stop()`.

### 4.3 Fix C — canonicalize the MCP config path

File: `engine/src/cli/doctor.ts:411-432` reads `~/.jellyclaw/mcp.json` with shape `{servers: {name: cfg}}`. Nothing else uses that path or that shape.

Action: make `doctor` read the same `jellyclaw.json` + `.mcp[]` array as §4.2. Delete the `{servers}` reader. Update `docs/mcp.md` to show one path, one shape.

This is also the right moment to delete `~/.jellyclaw/mcp.json` references from SPEC §8 (spec drift correction).

---

## 5. Execution sequence

Phases below are sized in "prompt-days" for the autobuild rig at `scripts/autobuild-simple/run.sh`. Each phase lands as one PR on a branch George cuts himself (per George's branching discipline — no autonomous branches).

| # | Phase | Files touched | Tests |
|---|-------|---------------|-------|
| 1 | **Pre-work fixes A + B + C** (see §4) | `engine/src/cli/run.ts`, `engine/src/server/run-manager.ts`, `engine/src/cli/doctor.ts`, new `engine/src/cli/mcp-config-loader.ts`, docs update | `engine/src/cli/run.test.ts` cred-file case, `engine/src/cli/mcp-config-loader.test.ts`, update `cli-flags.test.ts` expectations |
| 2 | **Template + default mcp.json** | new `engine/templates/mcp.default.json`, `engine/src/cli/doctor.ts` to suggest it, `docs/mcp.md` rewrite | snapshot test on template |
| 3 | **Exa MCP shipped as default** (optional auto-enrol on first `jellyclaw run` when no MCP configured) | `engine/src/cli/mcp-config-loader.ts` (merge-with-default logic), `docs/tools.md` WebSearch section rewrite | `engine/src/cli/mcp-config-loader.test.ts` merge behaviour |
| 4 | **Delete `WebSearch` stub** (Option 2.3a) | remove `engine/src/tools/websearch.ts`, edit `engine/src/tools/index.ts:58`, edit `engine/src/tools/types.ts:276-285`, update parity test fixture | `test/unit/tools/parity.test.ts` |
| 5 | **Playwright pin bump** (see §3.2) | `package.json:68`, `patches/004-playwright-mcp-pin.md`, `engine/templates/mcp.default.json` | `test/integration/playwright-mcp.test.ts` (existing smoke) under `JELLYCLAW_PW_MCP_TEST=1` |
| 6 | **Doctor + permissions for Playwright** (see §3.4) | `engine/src/cli/doctor.ts` chromium/CDP checks, `engine/src/permissions/rules.ts` default ask rules for dangerous tools, `engine/src/ratelimit/policies.ts` browser bucket | `engine/src/cli/doctor.test.ts` new cases, rate-limit unit test |
| 7 | **Optional: `fetcher-mcp` companion** | add to `engine/templates/mcp.default.json` (commented by default), `docs/tools.md` explanation | none |
| 8 | **Optional later: Anthropic `web_search_20250305` server-tool** (§2.4) | `@anthropic-ai/sdk` bump, `engine/src/providers/types.ts:35`, `engine/src/providers/anthropic.ts` tool array, `engine/src/providers/adapter.ts` SSE translation, `engine/src/providers/cache-breakpoints.ts` special-case | new adapter branch tests |

Phases 1-6 are the "ship web search + browser" deliverable. Phase 7 is polish. Phase 8 is deferred.

Each phase ends with `bun run typecheck && bun run build && bun run test`. Phase 1 will also need to update the 16 stale tests that are currently failing — surface area overlap with our work, so no double-handling.

---

## 6. Risks and open questions

### 6.1 Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Exa free tier throttles hard in production | Medium | Document `EXA_API_KEY` bring-your-own-key upgrade; have DDG MCP documented as one-line swap |
| Exa hosted endpoint deprecated or paywalled | Low-Medium | DDG fallback is documented; switching is a one-line mcp.json edit |
| Playwright v0.0.70 has a new regression that the pin doc's tool list doesn't cover | Low | §3.2 verification step runs before the pin bump. The existing integration test is the gate |
| DDG MCP requires Python + `uvx` which users on fresh macOS may not have | Medium | `jellyclaw doctor` detects missing `uvx` and suggests `brew install uv`; or default to Exa (which needs nothing) |
| `browser_run_code` with `ask` permissions still feels dangerous in a batch `--permission-mode bypassPermissions` run | High | Add a hard-coded safety: any tool matching `mcp__*__browser_run_code|browser_evaluate|browser_file_upload` is `ask` irrespective of `--permission-mode` (mirror the existing Bash exception) |
| SDK bump for server-tool route (Phase 8) touches cache breakpoints, risks cache-hit-rate regression | High | Phase 8 deferred until needed; separate PR; telemetry check on cache hit rate before/after |
| Tauri desktop still crashes on startup (unrelated but user-visible) | Known | Flag to George as a separate follow-up — not our scope but worth fixing in parallel |
| Autobuild landed 82 modified + 128 new files in one commit with stale tests | Known | Phase 1 picks up the 16 test fixes as part of the wiring work; does not try to remove unrelated drift |

### 6.2 Open questions for George

1. **Default enablement.** Should the Exa MCP be on by default for every new jellyclaw install (i.e., `jellyclaw mcp list` in a fresh install returns Exa even with no user config), or only surface in the template? Default-on trades privacy for UX. My recommendation: opt-in, but print a boot-time hint `[jellyclaw] no web search configured. Add Exa: see docs/mcp.md#exa`.
2. **DDG or Brave as secondary.** DDG MCP is the cleanest "no key, no scraping" default. Brave MCP has better results but needs a free-tier key. Pick one as the documented fallback. Recommendation: DDG.
3. **Do we delete `engine/src/tools/websearch.ts` (Option 2.3a) or keep it as a dispatch shim that forwards to the configured MCP (Option 2.3b)?** 2.3a ships today, 2.3b is cleaner UX (the model sees a stable `WebSearch` name regardless of backend). Recommendation: 2.3a for Phase 4, punt 2.3b to a later "unify tool naming" pass.
4. **Tauri desktop — scope or defer?** Crashes at `plugins.shell.scope` before a window opens. One-line fix in `tauri.conf.json`. Not blocking for web search / browser MCP but user-visible. Defer or bundle?
5. **`claude-opus-4-6` hard-code at `engine/src/cli/run.ts:247`.** Should the CLI honour `--model`? Probably yes; trivial fix; out of scope but noted.

---

## 7. Concrete file:line reference sheet

For whichever Claude Code session picks this up next — these are the exact seams.

### Feature A (web search)

- Stub to delete (or keep, per §2.3): `engine/src/tools/websearch.ts:29-40`
- Built-in registration slot: `engine/src/tools/index.ts:58`
- Error class to delete: `engine/src/tools/types.ts:276-285`
- Allow-list mention: `engine/src/cli/run.ts:269-288`
- Tool array assembly: `engine/src/agents/loop.ts:989-1025`
- Anthropic request body: `engine/src/providers/anthropic.ts:145-154`
- Cache breakpoint planner: `engine/src/providers/cache-breakpoints.ts:88-104`

### Feature B (browser MCP)

- Pin location: `package.json:68`
- Pin-rationale doc: `patches/004-playwright-mcp-pin.md`
- Setup doc: `docs/playwright-setup.md`
- Integration test: `test/integration/playwright-mcp.test.ts` (gated `JELLYCLAW_PW_MCP_TEST=1`)
- Test fixture: `test/fixtures/mcp/playwright.test-config.json`

### Pre-work (the blocking fixes)

- Env-only auth bug: `engine/src/cli/run.ts:137-140`
- MCP-not-instantiated TODO: `engine/src/cli/run.ts:172-181`
- Same TODO on serve path: `engine/src/server/run-manager.ts:609-622`
- Three-shape drift: `engine/src/config.ts:80-129`, `engine/src/cli/doctor.ts:411-432`, `engine/src/cli/mcp-cmd.ts:67-69`
- `loadCredentials()` to reuse: `engine/src/cli/credentials.ts:83-100`
- `selectAuth()` to reuse: `engine/src/providers/subscription-auth.ts`

### MCP plumbing (read-only, for context)

- Registry: `engine/src/mcp/registry.ts`
- HTTP transport (Exa needs this): `engine/src/mcp/client-http.ts`
- stdio transport (Playwright/DDG need this): `engine/src/mcp/client-stdio.ts`
- Namespacing (`mcp__<server>__<tool>`): `engine/src/mcp/namespacing.ts`
- OAuth (for future Exa paid tier): `engine/src/mcp/oauth.ts`
- Registry failure mode: warn-and-continue with 30s backoff — `engine/src/mcp/registry.ts:113-130, 257-291`

### Agent loop (read-only, for context)

- MCP tool dispatch branch: `engine/src/agents/loop.ts:617-626, 776-end`
- Permission gate (SPEC §5.1 Layer B, actual location): `engine/src/agents/loop.ts:566-581`
- Tool handler invocation: `engine/src/agents/loop.ts:678-680`

---

## 8. Appendix — what investigation showed that is NOT in this plan

- Tauri v2 plugin-shell config panic at `desktop/src-tauri/tauri.conf.json:46-55`. Trivial fix, out of scope.
- `--permission-mode bypassPermissions` doesn't bypass `Bash`. Separate permissions bug.
- `--model` flag ignored. Hard-coded at `engine/src/cli/run.ts:247`. Separate bug.
- `doctor` reports false-positive "missing patches" for SPEC-§15-deferred patches. Cosmetic.
- `doctor` reports false-positive "no MCP servers configured" even with `~/.jellyclaw/jellyclaw.json` set. Fixed by §4.3.
- The autobuild's `.github/` directory (Tauri DMG release workflow) is untracked. Not our concern.
- Two coexisting config schemas (`engine/src/config.ts` vs `engine/src/config/schema.ts`). Consolidation is a separate phase.

---

*End of plan. Nothing has been written outside this document. No branches. No commits.*
