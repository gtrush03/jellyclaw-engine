# Jellyclaw Engine — Completion Log

**Last updated:** 2026-04-15
**Current phase:** Phase 02 — Config + provider layer (next)

## Overall progress

[██░░░░░░░░░░░░░░░░░░] 2/20 phases complete (10%)

## Phase checklist

### Foundation
- [x] ✅ Phase 00 — Repo scaffolding
- [x] ✅ Phase 01 — OpenCode pinning and patching
- [ ] Phase 02 — Config + provider layer
- [ ] Phase 03 — Event stream adapter
- [ ] Phase 04 — Tool parity
- [ ] Phase 05 — Skills system
- [ ] Phase 06 — Subagent system + hook patch

### Core engine
- [ ] Phase 07 — MCP client integration
- [ ] Phase 08 — Permission engine + hooks
- [ ] Phase 09 — Session persistence + resume
- [ ] Phase 10 — CLI + HTTP server + library
- [ ] Phase 11 — Testing harness

### Genie integration
- [ ] Phase 12 — Genie integration behind flag
- [ ] Phase 13 — Make jellyclaw default in Genie
- [ ] Phase 14 — Observability + tracing

### Desktop + ecosystem
- [ ] Phase 15 — Desktop app MVP (Tauri 2)
- [ ] Phase 16 — Desktop app polish
- [ ] Phase 17 — Integration into jelly-claw video-calling app
- [ ] Phase 18 — Open-source release
- [ ] Phase 19 — Post-launch stabilization (ongoing)

## Phase completion details

### Phase 00 — Repo scaffolding
- **Status:** ✅ Complete
- **Started:** 2026-04-15
- **Completed:** 2026-04-15
- **Duration (actual):** 0.5 hour
- **Session count:** 1
- **Commits:** 6644aaf
- **Tests passing:** 6/6
- **Notes:** Scaffold verified end-to-end. Deviations from PHASE-00 spec (CLAUDE.md wins):
  bun workspaces instead of pnpm (no `pnpm-workspace.yaml`, no `shared/`), no `.nvmrc`/`.npmrc`,
  no `.github/workflows/ci.yml`. Drift fixes: added `desktop/package.json` and
  `integration/package.json` stubs (empty workspaces blocked `bun install`); migrated
  `biome.json` to Biome 2 schema (`files.includes`, `assist.actions.source.organizeImports`,
  `useAwait` moved to `suspicious`); zod v4 fix in `engine/src/config.ts` (`z.record` 2-arg),
  added `export type` aliases for `AnthropicProviderConfig`/`OpenRouterProviderConfig`;
  removed duplicate shebang in `engine/src/cli.ts` (tsup banner adds it); added
  `biome-ignore useYield` on provider stream stubs. `bun install` / `typecheck` / `lint` /
  `test` / `build` all exit 0 from a fresh `rm -rf node_modules dist`. Tag `v0.0.0-scaffold` set.

### Phase 01 — OpenCode pinning and patching
- **Status:** ✅ Complete
- **Started:** 2026-04-15
- **Completed:** 2026-04-15
- **Duration (actual):** ~1 day (2 sessions — research + implementation)
- **Session count:** 2
- **Commits:** dcb0601, 06d7d8a, 8a380dd, (doc-pivot commit)
- **Tests passing:** 48/48 (38 new plugin + bootstrap + 10 pre-existing)
- **Notes:**
  - ✅ Prompt 01 (research) — `engine/opencode-research-notes.md` landed (950 lines).
    Pin target confirmed: `opencode-ai@1.4.5` (dist-tag latest, commit dfc72838).
    Two CVEs documented (22812 unauth RCE, 22813 web-UI XSS→RCE). Issue #5894
    audited against v1.4.5: auto-closed with no PR; hooks already fire for
    subagents (plugins are Instance-scoped). Original SPEC §5.1 patch plan
    obsolete; revised plan targeted `packages/opencode/src/session/prompt.ts`
    at three sites, adding `agent` context to the hook envelope.
  - ✅ Prompt 02 (implementation) — **major pivot discovered and executed mid-session.**
    On `bun install` against the `opencode-ai@1.4.5` pin, we learned the npm
    tarball ships a **compiled Bun standalone binary** (`bin/opencode` is a
    ~170-line Node launcher that execs `opencode-darwin-arm64/bin/opencode`
    or equivalent). There is no TypeScript source in the installed tree —
    `packages/opencode/src/session/prompt.ts` exists only in the GitHub repo
    at tag v1.4.5, not in what consumers install. `patch-package` cannot
    operate on this.
  - **Pivot:** all three would-be source patches reimplemented as first-class
    jellyclaw code:
    - 001-subagent-hook-fire → `engine/src/plugin/agent-context.ts` (hook
      envelope enrichment with agent / parentSessionID / agentChain; 9 tests).
    - 002-bind-localhost-only → `engine/src/bootstrap/opencode-server.ts`
      (hostname locked to 127.0.0.1; port pre-allocated from ephemeral range
      because opencode's `--port 0` actively falls back to 4096; 4 tests
      including live e2e against real opencode-ai@1.4.5).
    - 003-secret-scrub-tool-results → `engine/src/plugin/secret-scrub.ts`
      (13-rule regex redactor + extraLiterals + recursive tool-result walk;
      29 tests).
  - Docs synced to the new reality: SPEC §5.1 + §15 rewritten, CVE-MITIGATION
    added §1.4 for CVE-22813 and updated §2.1 to match the v1.4.5 reality,
    patches/README rewritten ("zero active patches; patch-package retained for
    future non-binary deps"), three `.patch` files renamed to `.design.md` as
    historical design-intent archive with "STATUS: superseded" blocks.
    phases/PHASE-01-opencode-pinning.md deliverables + acceptance criteria
    updated.
  - Repro `engine/scratch/repro-5894.ts` exercises the two plugins end-to-end
    against synthetic envelopes (live subagent-spawn e2e lands in Phase 06
    when the `task` tool is wired).
  - Deps pinned exactly: opencode-ai@1.4.5, @anthropic-ai/sdk^0.40.0,
    zod^3.23.0, patch-package^8.0.0. `bun.lock` committed.
  - Postinstall flipped from `patch-package || true` to
    `patch-package --patch-dir patches --error-on-fail` per research §6.6
    (silent patch failures are security regressions).
  - **Deviations from the phase doc worth noting for future phases:**
    (1) patch-package stays in the toolchain but currently applies zero
    patches; do not assume it is load-bearing for opencode-ai;
    (2) any future "patch opencode" work needs a fork-from-source path
    (vendor submodule + rebuild) — patch-package alone cannot help;
    (3) port ephemeralization must be caller-side — `--port 0` does NOT do
    what the name suggests in this binary.

### Phase 02 — Config + provider layer
- **Status:** 🔄 In progress (Prompts 01+02 ✅; 03 remaining)
- **Started:** 2026-04-15
- **Completed:** —
- **Duration (actual):** —
- **Session count:** 2 (ongoing)
- **Commits:** 53cf19d (research), (this commit: anthropic provider)
- **Tests passing:** 93/93 (45 new in Prompt 02: 24 schema/loader, 13 cache-breakpoints, 8 anthropic provider)
- **Notes:**
  - ✅ Prompt 02 (anthropic provider) — `engine/src/config/{schema,loader}.ts`
    + `engine/src/providers/{types,cache-breakpoints,anthropic,index}.ts`
    + matching tests landed. New config schema matches SPEC §9 exactly
    (single `provider` enum + `model` + `anthropic`/`openrouter` blocks +
    `cache`/`server`/`telemetry`/`permissions` + `acknowledgeCachingLimits`
    gate). Loader implements resolution order defaults ← global ← local ←
    env ← CLI with deep-merge, `ConfigParseError` on malformed JSON, and
    separate `assertCredentials` + `assertCachingGate` helpers (zod cannot
    enforce env-fallback or cross-field gating natively).
    `planBreakpoints` is a pure function covering all 4 SPEC §7 slots
    (system/tools/CLAUDE.md/skills) with byte-identical stability semantics
    and the `anthropic-beta: extended-cache-ttl-2025-04-11` header auto-set
    when any breakpoint carries `ttl:"1h"`. AnthropicProvider uses
    `maxRetries:0` on the SDK and owns its own retry loop (3 attempts /
    30s budget / exponential+jitter / Retry-After honored) per
    research-notes §4.3. SDK `CacheControlEphemeral` type in 0.40.1 lacks
    the `ttl` field — isolated cast documented inline.
    Legacy `engine/src/config.ts` kept in place (index.ts still imports
    it); Phase 10 consolidates the two config surfaces.
    Logger redact list gained `headers.x-api-key` entries.
    Scope left for Prompt 03: OpenRouter wrapper + router/fallback +
    docs/providers.md (+ possible credential-pool implementation).
  - ✅ Prompt 01 (research) — `engine/provider-research-notes.md` landed
    (1753 lines, 10 sections + 2 appendices). Every section populated;
    every caching-related claim has a source URL. Key confirmations from
    live doc fetch: beta header `extended-cache-ttl-2025-04-11` still
    current (April 2026) for 1h TTL; min-cacheable-tokens table updated
    per model tier (Opus 4.6 = 4096, Sonnet 4.6 = 2048, Haiku 4.5 = 4096,
    older Sonnet/Opus family = 1024); max 4 breakpoints per request;
    lookback = 20 positions. OR issue trail reconciled: "#1245" spans
    sst/opencode#1245 (closed via downstream fix) + upstream root cause
    OpenRouterTeam/ai-sdk-provider#35 (still open) + independent reproductions
    in pydantic-ai, Zed. "#17910" is anomalyco/opencode#17910 — Anthropic
    server-side change on 2026-03-17 rejects cache_control on OAuth auth;
    root cause is Anthropic-side, not OR, but OR routes share the blast
    radius. §10 decision table: `acknowledgeCachingLimits` gate (default
    false) blocks `anthropic/*` models via OR unless explicitly flipped;
    non-Anthropic via OR proceeds with cache_control strip.
  - Prompts 02 (anthropic provider), 03 (openrouter provider), 04
    (router/fallback), 05 (config schema + loader), 06 (tests + docs)
    remain.

### Phase 03 — Event stream adapter
- **Status:** ⏳ Not started
- **Started:** —
- **Completed:** —
- **Duration (actual):** —
- **Session count:** —
- **Commits:** —
- **Tests passing:** —
- **Notes:** —

### Phase 04 — Tool parity
- **Status:** ⏳ Not started
- **Started:** —
- **Completed:** —
- **Duration (actual):** —
- **Session count:** —
- **Commits:** —
- **Tests passing:** —
- **Notes:** —

### Phase 05 — Skills system
- **Status:** ⏳ Not started
- **Started:** —
- **Completed:** —
- **Duration (actual):** —
- **Session count:** —
- **Commits:** —
- **Tests passing:** —
- **Notes:** —

### Phase 06 — Subagent system + hook patch
- **Status:** ⏳ Not started
- **Started:** —
- **Completed:** —
- **Duration (actual):** —
- **Session count:** —
- **Commits:** —
- **Tests passing:** —
- **Notes:** —

### Phase 07 — MCP client integration
- **Status:** ⏳ Not started
- **Started:** —
- **Completed:** —
- **Duration (actual):** —
- **Session count:** —
- **Commits:** —
- **Tests passing:** —
- **Notes:** —

### Phase 08 — Permission engine + hooks
- **Status:** ⏳ Not started
- **Started:** —
- **Completed:** —
- **Duration (actual):** —
- **Session count:** —
- **Commits:** —
- **Tests passing:** —
- **Notes:** —

### Phase 09 — Session persistence + resume
- **Status:** ⏳ Not started
- **Started:** —
- **Completed:** —
- **Duration (actual):** —
- **Session count:** —
- **Commits:** —
- **Tests passing:** —
- **Notes:** —

### Phase 10 — CLI + HTTP server + library
- **Status:** ⏳ Not started
- **Started:** —
- **Completed:** —
- **Duration (actual):** —
- **Session count:** —
- **Commits:** —
- **Tests passing:** —
- **Notes:** —

### Phase 11 — Testing harness
- **Status:** ⏳ Not started
- **Started:** —
- **Completed:** —
- **Duration (actual):** —
- **Session count:** —
- **Commits:** —
- **Tests passing:** —
- **Notes:** —

### Phase 12 — Genie integration behind flag
- **Status:** ⏳ Not started
- **Started:** —
- **Completed:** —
- **Duration (actual):** —
- **Session count:** —
- **Commits:** —
- **Tests passing:** —
- **Notes:** —

### Phase 13 — Make jellyclaw default in Genie
- **Status:** ⏳ Not started
- **Started:** —
- **Completed:** —
- **Duration (actual):** —
- **Session count:** —
- **Commits:** —
- **Tests passing:** —
- **Notes:** —

### Phase 14 — Observability + tracing
- **Status:** ⏳ Not started
- **Started:** —
- **Completed:** —
- **Duration (actual):** —
- **Session count:** —
- **Commits:** —
- **Tests passing:** —
- **Notes:** —

### Phase 15 — Desktop app MVP (Tauri 2)
- **Status:** ⏳ Not started
- **Started:** —
- **Completed:** —
- **Duration (actual):** —
- **Session count:** —
- **Commits:** —
- **Tests passing:** —
- **Notes:** —

### Phase 16 — Desktop app polish
- **Status:** ⏳ Not started
- **Started:** —
- **Completed:** —
- **Duration (actual):** —
- **Session count:** —
- **Commits:** —
- **Tests passing:** —
- **Notes:** —

### Phase 17 — Integration into jelly-claw video-calling app
- **Status:** ⏳ Not started
- **Started:** —
- **Completed:** —
- **Duration (actual):** —
- **Session count:** —
- **Commits:** —
- **Tests passing:** —
- **Notes:** —

### Phase 18 — Open-source release
- **Status:** ⏳ Not started
- **Started:** —
- **Completed:** —
- **Duration (actual):** —
- **Session count:** —
- **Commits:** —
- **Tests passing:** —
- **Notes:** —

### Phase 19 — Post-launch stabilization (ongoing)
- **Status:** ⏳ Not started
- **Started:** —
- **Completed:** —
- **Duration (actual):** —
- **Session count:** —
- **Commits:** —
- **Tests passing:** —
- **Notes:** —

## Session log

| Date | Session # | Phase | Sub-prompt | Outcome |
|---|---|---|---|---|
| 2026-04-15 | 1 | 00 | 01-verify-scaffolding | ✅ Phase 00 complete — toolchain green, tag v0.0.0-scaffold, commit 6644aaf |
| 2026-04-15 | 2 | 01 | 01-research | 🔄 Research note landed (engine/opencode-research-notes.md, 950 lines). Commit dcb0601. Phase 01 NOT complete — awaits Prompt 02 implementation. |
| 2026-04-15 | 5 | 02 | 02-anthropic-provider | 🔄 Config schema+loader, Provider interface, pure `planBreakpoints`, `AnthropicProvider` with real SDK streaming + SPEC §7 cache_control placement + `anthropic-beta` 1h header + own retry loop all landed. 93/93 tests green (45 new). Phase 02 still open — Prompt 03 (OpenRouter + router/fallback + docs) remains. |
| 2026-04-15 | 4 | 02 | 01-research | 🔄 `engine/provider-research-notes.md` landed (1753 lines). Beta header `extended-cache-ttl-2025-04-11` verified current. Min-cache-tokens table refreshed. OR #1245 + #17910 deep-dives completed with primary + mirror citations. `acknowledgeCachingLimits` gate decision table authored (§10). Phase 02 NOT complete — Prompts 02-06 still ahead. |
| 2026-04-15 | 3 | 01 | 02-implement | ✅ Phase 01 complete via PIVOT. opencode-ai@1.4.5 is a compiled binary → three planned source patches reimplemented as engine/src/plugin/{agent-context,secret-scrub}.ts + engine/src/bootstrap/opencode-server.ts. 48/48 tests green (incl. live e2e against opencode-ai child). SPEC §5.1/§15 + CVE-MITIGATION §1.4/§2.1 + patches/README + phases/PHASE-01 synced. Commits 06d7d8a (pin+lock), 8a380dd (code), (this commit) (docs+log). |

## Blockers & decisions

(running list)

**2026-04-15 — Phase 01 architectural pivot.** `opencode-ai@1.4.5` on npm ships
a compiled Bun standalone binary, not TypeScript source. The original
patch-package-based plan for SPEC §5.1 Layer A is unexecutable as written —
there is nothing to patch. Decision: move all three would-be patches into
first-class jellyclaw code (plugin modules + bootstrap assertions). Layer B
(provider-wrapper permission ruleset) remains the load-bearing safety net.
This pivot should inform every future phase that discusses "patching opencode":
the only real option is a fork-from-source vendor submodule, which we are NOT
doing unless a specific future need justifies the cross-platform build matrix.
