# Jellyclaw Engine — Completion Log

**Last updated:** 2026-04-15
**Current phase:** Phase 03 — Event stream adapter (next)

## Overall progress

[███░░░░░░░░░░░░░░░░░] 3/20 phases complete (15%)

## Phase checklist

### Foundation
- [x] ✅ Phase 00 — Repo scaffolding
- [x] ✅ Phase 01 — OpenCode pinning and patching
- [x] ✅ Phase 02 — Config + provider layer
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
- **Status:** ✅ Complete
- **Started:** 2026-04-15
- **Completed:** 2026-04-15
- **Duration (actual):** 1 day (3 sessions — research + anthropic + openrouter-via-team)
- **Session count:** 3
- **Commits:** 53cf19d (research), ca2ec15 (anthropic), (this commit: openrouter + router + gate + pool + docs)
- **Tests passing:** 147/147 (99 new in Phase 02 total: 24 schema/loader, 13 cache-breakpoints, 8 anthropic provider, 14 openrouter, 13 router, 15 gate, 12 credential-pool)
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
  - ✅ Prompt 03 (openrouter provider + router/fallback + gate + pool + docs)
    — executed via a 5-agent team in parallel:
    - `engine/src/providers/openrouter.ts` (659 lines) — `OpenRouterProvider`
      with hand-rolled SSE parser (no new deps), recursive `stripCacheControl`
      (zero emits — test walks the captured body and asserts), OpenAI-compat
      body translation (tool schema `input_schema`→`parameters`, tool_use↔
      tool_calls, tool_result→tool role), Anthropic-shape chunk emission so
      the Phase 03 event adapter doesn't branch, module-level `warned` guard
      with exported reset for tests, 402-added-to-non-retryable, mirror
      Anthropic retry loop (3/30s/jitter/Retry-After).
    - `engine/src/providers/router.ts` (147 lines) — provider-agnostic
      `ProviderRouter` with pre-stream-only failover (tracks
      `yieldedFromPrimary`), duck-typed error classification, AbortError
      propagation without failover, `shouldFailover(err)` helper exported.
    - `engine/src/providers/gate.ts` (40 lines) — `enforceCachingGate(config,
      model)` with explicit model arg (not config.model) for
      dispatch-time override checks. Reuses existing `CachingGateError` from
      `config/loader.ts`.
    - `engine/src/providers/credential-pool.ts` (216 lines) — contiguous
      `_1..N` scan, config-key beats env-pool, round-robin skipping dead
      slots, `rotateOnRateLimit()` + `markCurrentDead()`, `AllKeysDeadError`,
      keys in closure so `JSON.stringify(pool)` cannot leak.
    - `docs/providers.md` (658 lines) — selection matrix, caching matrix,
      breakpoint rules, `anthropic-beta` header, OR caveat with issue URLs,
      `acknowledgeCachingLimits` gate decision table, pooling docs,
      retry/failover rules, 3 JSON config examples, 8 pitfalls, 10 FAQ.
    - `engine/src/providers/index.ts` (barrel) extended. `engine/src/types.ts`
      gained `"router"` to the provider name union. `engine/src/index.ts`
      `makeProvider` now maps openrouter the same way it maps anthropic.
  - Gates: typecheck ✅, biome ✅ (clean on all provider files post-autofix
    + a handful of biome-ignore comments on async generators in tests where
    the rule misfires), vitest 147/147 ✅ (incl. live opencode-ai e2e), build ✅.

### Phase 03 — Event stream adapter
- **Status:** 🔄 In progress (Prompt 01 of 3 complete)
- **Started:** 2026-04-15
- **Completed:** —
- **Duration (actual):** ~0.5 day for Prompt 01
- **Session count:** 1
- **Commits:** (pending)
- **Tests passing:** 179/179 (32 new in `shared/`)
- **Notes:**
  - ✅ Prompt 01 (research + types) — `@jellyclaw/shared` workspace created.
    `shared/src/events.ts` — 15-variant `z.discriminatedUnion` matching the
    Phase 03 spec exactly (`system.init`, `system.config`, `user`,
    `assistant.delta`, `assistant.message`, `tool.call.{start,delta,end}`,
    `subagent.{start,end}`, `hook.fire`, `permission.request`,
    `session.update`, `cost.tick`, `result`). Shared `Usage` schema with
    defaults for `cache_creation_input_tokens`, `cache_read_input_tokens`,
    `cost_usd`. Minimal `Message`/`Block` (text/tool_use/tool_result)
    shapes used by the `user` and `assistant.message` payloads. Type
    guards generated via a `makeGuard<T>(type)` factory + generic
    `isEvent(e, type)`. `EVENT_TYPES` canonical ordering + `parseEvent`
    boundary helper. `redactConfig` pure recursive scrubber (key-name
    patterns for `apiKey`/`api_key`/`*token`/`*password`/`*secret`/
    `OPENCODE_SERVER_PASSWORD`; string-value patterns for `sk-ant-...`,
    `sk-or-...`, `AKIA[0-9A-Z]{16}`, `github_pat_*`, `gh[pous]_*`).
    `OUTPUT_FORMAT_EVENTS: Record<OutputFormat, ReadonlySet<EventType>>`
    encodes the three downgrades (`jellyclaw-full` / `claude-code-compat`
    / `claurst-min`) that Prompt 03's emitter will consult.
  - `shared/src/events.test.ts` (32 tests): per-variant round-trip via
    hand-written golden samples, unknown-discriminator rejection,
    missing-required-field rejection, negative-`ts` rejection, Usage
    defaults fill, guard narrowing (both typed and generic), compile-time
    exhaustive-switch check over all 15 variants (`const _: never = e`),
    redactor covering (a) key-name patterns at any nesting depth,
    (b) string-value patterns under unrecognised keys, (c) purity (no
    input mutation), (d) non-secret passthrough. Output-format matrix
    asserts the exact membership of each of the three sets.
  - `docs/event-stream.md` (357 lines): rationale; shape + when-emitted
    for each of the 15 events; upstream-mapping table covering every
    OpenCode bus event from `engine/opencode-research-notes.md` §4.6
    (`server.connected`, `server.heartbeat`, `global.disposed`,
    `session.updated`, `session.error`, `message.updated`,
    `message.part.updated` text/tool-use/tool-result, `tool.permission.ask`,
    `project.updated`) plus jellyclaw-native rows (plugin hooks,
    permission decisions, task-tool spawn/return, usage roll-up); each
    upstream event either maps to a jellyclaw event or is explicitly
    marked dropped with reason. §4 output-format downgrade matrix (tick
    table). §5 ordering invariants (system.init first → system.config
    second → result terminal → tool.call.start before .end →
    subagent.start before nested tool events → monotonic ts →
    assistant.message after its deltas). §6 redaction rule list aligned
    with `redactConfig()` implementation. §7 forward-references Phase
    09/10/14 follow-ups.
  - Live-sample capture deferred: `test/golden/opencode-raw-samples.jsonl`
    path documented in §3.1 with the curl one-liner, but a live capture
    was not performed this session (schemas stand on their own; Prompt
    02 will replay captured frames through the adapter).
  - Workspace integration: root `package.json` `workspaces` +
    `tsconfig.json` `paths` (`@jellyclaw/shared` + `@jellyclaw/shared/*`)
    + `vitest.config.ts` `alias` all updated. Smoke import from engine
    side proven via `engine/src/stream/smoke-import.ts` (imports
    `Event`, `EventType`, `EVENT_TYPES`, `parseEvent` from
    `@jellyclaw/shared`; placeholder until Prompt 02's adapter lands).
  - Gates: `bun install` ✅, `bun run typecheck` ✅,
    `bunx biome check shared/ engine/src/stream/` ✅ (autofix applied
    once for formatter line-joining), `bun run test shared/` ✅
    (32 new), full `bun run test` ✅ (179/179 total). `bun run lint`
    at root still fails on the untracked `dashboard/` directory —
    orthogonal to this phase.
  - Scope remaining for Phase 03: Prompt 02 (adapter — OpenCode SSE →
    jellyclaw events, ordering buffer, redaction of `system.config`
    payload), Prompt 03 (emitter — `writeLine` + output-format
    downgrades + backpressure + golden-replay tests).

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
| 2026-04-15 | 7 | 03 | 01-research-and-types | 🔄 `@jellyclaw/shared` workspace created: 15-variant `z.discriminatedUnion` + `Usage` + `Message`/`Block` + `redactConfig` + factory type guards + `OUTPUT_FORMAT_EVENTS` downgrade table. 32 new tests (179 total). `docs/event-stream.md` maps every observed OpenCode bus event to a jellyclaw event or marks it dropped with reason; §4 downgrade matrix; §5 ordering invariants; §6 redaction rules. Smoke import from engine verified. Phase 03 still open — Prompts 02 (adapter) + 03 (emitter) remain. |
| 2026-04-15 | 1 | 00 | 01-verify-scaffolding | ✅ Phase 00 complete — toolchain green, tag v0.0.0-scaffold, commit 6644aaf |
| 2026-04-15 | 2 | 01 | 01-research | 🔄 Research note landed (engine/opencode-research-notes.md, 950 lines). Commit dcb0601. Phase 01 NOT complete — awaits Prompt 02 implementation. |
| 2026-04-15 | 6 | 02 | 03-openrouter-provider | ✅ Phase 02 COMPLETE. 5-agent parallel team produced `openrouter.ts` (with SSE parser + cache_control strip + warn-once) + `router.ts` + `gate.ts` + `credential-pool.ts` + `docs/providers.md`. Main session reconciled barrel exports, updated `engine/src/index.ts` `makeProvider`, fixed 5 linter misfires on async generators in tests. 147/147 tests green (54 new). Typecheck ✅, build ✅, biome ✅. |
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
