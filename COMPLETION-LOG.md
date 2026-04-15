# Jellyclaw Engine — Completion Log

**Last updated:** 2026-04-15
**Current phase:** Phase 05 — Skills system (in progress, prompt 01 done)

## Overall progress

[█████░░░░░░░░░░░░░░░] 5/20 phases complete (25%)

## Phase checklist

### Foundation
- [x] ✅ Phase 00 — Repo scaffolding
- [x] ✅ Phase 01 — OpenCode pinning and patching
- [x] ✅ Phase 02 — Config + provider layer
- [x] ✅ Phase 03 — Event stream adapter
- [x] ✅ Phase 04 — Tool parity
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
- **Status:** ✅ Complete
- **Started:** 2026-04-15
- **Completed:** 2026-04-15
- **Duration (actual):** 1 day (2 sessions — schemas + adapter/emitter via team-of-2)
- **Session count:** 2
- **Commits:** 338bb6e (schemas), (this commit: adapter + emitter + golden + scratch)
- **Tests passing:** 242/242 (63 new in Phase 03 total: 32 schemas + 7 adapter + 54 emitter + 2 golden-replay — vitest expands parametric cases)
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
  - ✅ Prompt 02 (adapter + emitter + golden) — executed via a 2-agent
    parallel team, reconciled in the main session.
    - **Adapter** (`engine/src/adapters/opencode-events.ts`, ~940 lines):
      `createAdapter(opts)` HTTP wrapper (`fetch` + `eventsource-parser`)
      + `createAdapterFromSource(opts)` test-friendly entry that
      consumes `AsyncIterable<string>` of raw `data:` payloads.
      Synthesises `system.init` → `system.config` (via
      `redactConfig()` from `@jellyclaw/shared`) prelude before any
      upstream frame. Per-`tool_use_id` ordering buffer holds any
      `.end` whose matching `.start` has not emitted; on
      `orderingTimeoutMs` (default 2000ms) fires a synthesised `.start`
      plus a `hook.fire{decision:"adapter.synthesize_start"}` notice.
      Streaming tool-input coalescing: `tool.call.delta(partial_json)`
      on every intermediate `message.part.updated`, `tool.call.start`
      once `part.state === "completed"`, dedupe by `(messageID, partID)`.
      Subagent stack with `task` auto-push/pop + test-only
      `pushSubagent`/`popSubagent` on the returned `AdapterHandle`.
      Rolling usage ledger emits `cost.tick` every N tool-ends (default
      5) and on every `assistant.message`. Terminal `result` always
      synthesised — `success` on normal close, `cancelled` on abort or
      `global.disposed`, `error` on upstream `session.error`,
      `max_turns` on `MaxTurnsExceeded`. Parse-error tolerance emits
      `hook.fire{event:"adapter.parse_error", decision:"adapter.drop"}`
      and continues. Every outbound event `Event.safeParse`-validated
      before yield. Clock injection throughout — zero `Date.now` or
      `new Date` outside docstrings.
      7 unit tests (happy path, late-start ordering, orphan-end
      timeout with `vi.useFakeTimers`, parse-error tolerance,
      subagent nesting, AbortController cancellation, backpressure via
      2000-frame slow-consumer loop).
    - **Emitter** (`engine/src/stream/emit.ts`, ~200 lines):
      `writeEvent(stream, event)` awaits `drain` when `write` returns
      `false` via `once("drain")` Promise; order-safe under sequential
      `await emit()` calls. `StreamEmitter` holds per-`session_id`
      delta buffers in a `Map`; on `assistant.message`, rewrites
      `message.content` to `[{type:"text", text: concat}]` using the
      coalesced deltas (or the original content if no deltas
      buffered). `finish()` flushes orphan delta buffers as a
      synthetic `assistant.message` with `ZERO_USAGE`. Stateless
      `downgrade(event, format)` helper for one-shot translation.
      `claude-code-compat` drops
      `system.config`/`tool.call.*`/`subagent.*`/`hook.fire`/
      `permission.request`/`session.update`/`cost.tick`; passes
      `system.init`/`user`/`result`; coalesces deltas into
      `assistant.message`. `claurst-min` writes flat
      `{type:"text",value}` and `{type:"result",status,duration_ms}`
      shapes — documented as the one format that bypasses the
      jellyclaw `Event` shape on the wire. 54 vitest cases (9
      behavioural + parametric `downgrade()` matrix across 15 events ×
      3 formats).
    - **Golden replay** (`test/golden/replay.test.ts` +
      `test/golden/hello.opencode.jsonl` (8 frames) +
      `test/golden/hello.jellyclaw.jsonl` (10 events)): pumps the
      OpenCode fixture through `createAdapterFromSource`, normalises
      `ts`/`session_id`/`duration_ms`/`stats.duration_ms`, asserts
      byte-equality with the jellyclaw fixture. `GOLDEN_UPDATE=1`
      regenerates the expected file from the current adapter. Second
      test mutates a payload field (`text:"hi"→"HI"`) and asserts the
      match breaks — proves the normaliser is narrow and won't mask
      real drift. No live capture this session (no
      `ANTHROPIC_API_KEY`); fixture shape is 1:1 with the in-memory
      adapter unit tests and with the upstream shapes documented in
      `engine/opencode-research-notes.md` §4.6.
    - **Scratch smoke** (`engine/scratch/emit-hello.ts`, gitignore
      allowlisted): drives the adapter + emitter end-to-end against
      the fixture and prints NDJSON for any of the three formats.
      Hand-verified that `jellyclaw-full` shows all 10 events;
      `claude-code-compat` produces `system.init` → coalesced
      `assistant.message` with `content:[{type:"text",text:"I'll list
      files. Done."}]` → `result`; `claurst-min` produces two
      `{type:"text",value}` lines + one `{type:"result",status,
      duration_ms}` line. All three are distinct and correct.
    - **Dep:** `eventsource-parser@^3.0.6` added to root
      `package.json`. `bun.lock` committed.
  - Gates on full repo: `bun run typecheck` ✅,
    `bunx biome check engine/src/adapters/ engine/src/stream/ shared/ engine/scratch/emit-hello.ts test/golden/replay.test.ts` ✅
    (four targeted `biome-ignore` comments: useAwait on generators in
    the scratch + golden test files, matching the house style used in
    provider tests), `bun run test` 242/242 ✅ (63 new).
  - Scope fully closed. Phase 03 Prompt 03 (backpressure deep-dive +
    live-capture golden) folded into Prompt 02 via the adapter's own
    backpressure test and the `GOLDEN_UPDATE=1` path.

### Phase 04 — Tool parity
- **Status:** ✅ Complete
- **Started:** 2026-04-15
- **Completed:** 2026-04-15
- **Duration (actual):** 1 day (5 sessions — one per prompt)
- **Session count:** 5
- **Commits:** 4d1a0d0 (prompt 01), 8a7d71c (prompt 02), 53b734a (prompt 03), 2efd998 (prompt 04), (this commit, prompt 05)
- **Tests passing:** 423/423 + 2 bench (181 new in Phase 04 — Bash 16 + Read 13 + Write 9 + Edit 18 + Edit-property 2 + Edit-diagnostics 7 + Glob 12 + Grep 17 + WebFetch 19 + WebSearch 9 + TodoWrite 15 + Task 10 + NotebookEdit 18 + Parity 16)
- **Notes:**
  - ✅ Prompt 05 (TodoWrite + Task + NotebookEdit + parity suite +
    docs round-out) — executed via a 3-agent parallel Opus team
    against a pre-authored contract: extended `ToolContext` with
    optional `session?: SessionHandle` and `subagents?: SubagentService`
    handles, added `engine/src/subagents/{types,stub}.ts` (`SubagentService`
    interface + `stubSubagentService` that always throws), added 6 new
    error classes (`MultipleInProgressError`, `SessionUnavailableError`,
    `SubagentsNotImplementedError`, `SubagentsUnavailableError`,
    `NotebookEditRequiresReadError`, `InvalidNotebookError`), authored
    3 schema fixtures + `parity-allowed-drift.json`, installed
    `zod-to-json-schema@^3.25`.
  - **TodoWrite** (`engine/src/tools/todowrite.ts`, 15 unit tests).
    Full-list replace semantics (NOT delta — Claude Code parity).
    Single in_progress invariant enforced with `MultipleInProgressError`.
    Delegates state via `ctx.session.update({ todos })` which the
    engine session writer (Phase 09+) will turn into outbound
    `session.update` events. Empty list valid (clears todos).
    `id` field normalized for `exactOptionalPropertyTypes` — omitted
    rather than `undefined`.
  - **Task** (`engine/src/tools/task.ts`, 10 unit tests). Thin
    pass-through: zod-parse → check `ctx.subagents` → delegate to
    `dispatch({ subagent_type, description, prompt })`. With the
    Phase-04 stub: throws `SubagentsNotImplementedError` with a
    clear "Phase 06 required" hint. With a real `SubagentService`
    (mock in tests; real in Phase 06): returns the dispatcher's
    `{ summary, status, usage }` result verbatim.
  - **NotebookEdit** (`engine/src/tools/notebook-edit.ts`, 18 unit
    tests). nbformat v4 enforced (`InvalidNotebookError` for v3+).
    Three edit modes: `replace` (preserves outputs + execution_count
    unless `clear_outputs: true`; changing cell_type resets both),
    `insert` (after located cell or at end; requires `cell_type` +
    `new_source`; auto-generates `id` via `crypto.randomUUID()`),
    `delete` (splice). Locator: `cell_id` (preferred) or
    `cell_number` (0-indexed). Read-before-edit invariant
    (`NotebookEditRequiresReadError`). Atomic write via
    `<path>.jellyclaw.tmp` → `renameSync`. Index signature
    `[key: string]: unknown` on cells preserves unknown notebook
    fields (kernelspec, language_info, metadata extensions) through
    round-trip.
  - **Parity suite** (`test/unit/tools/parity.test.ts`, 16 tests):
    asserts (a) registry has exactly 11 tools, (b) names match the
    Claude Code canon (Bash/Edit/Glob/Grep/NotebookEdit/Read/Task/
    TodoWrite/WebFetch/WebSearch/Write), (c) every tool overrides
    the OpenCode builtin and has a non-empty description, (d) the
    `parity-allowed-drift.json` list is empty (Phase 04 ships zero
    deviations), and (e) per-tool: `tool.inputSchema` deep-equals
    the JSON fixture in
    `test/fixtures/tools/claude-code-schemas/<name>.json`.
  - **`docs/tools.md`** rounded out with the 11-tool matrix table
    (Claude Code | OpenCode | jellyclaw with status legend) at the
    top, plus dedicated sections for TodoWrite, Task, and
    NotebookEdit alongside the existing WebFetch + WebSearch
    sections.
  - **All 11 tools registered** alphabetically in
    `engine/src/tools/index.ts` (3 agents coordinated via
    re-read-before-edit on a shared file): bash → edit → glob →
    grep → notebook-edit → read → task → todowrite → webfetch →
    websearch → write.
  - **No deviations from Claude Code schemas** — parity-allowed-drift
    is empty.
  - Gates: `bunx tsc --noEmit` ✅, `bunx biome check` ✅,
    `bun run test` 423 passed + 2 skipped ✅ (59 new in this prompt
    — 15 + 10 + 18 + 16). Benches still green under `BENCH=1`.
  - **Phase 04 ✅ COMPLETE.** Foundation group now 5/7 (00-04 done,
    05-06 remaining).
  - ✅ Prompt 04 (WebFetch + WebSearch) — executed via a 2-agent parallel
    Opus team against a pre-authored contract (deps `undici@^8.1`,
    `turndown@^7.2`, `ipaddr.js@^2.3`, `@types/turndown@^5` installed;
    new error classes `SsrfBlockedError`, `WebFetchProtocolError`,
    `WebFetchSizeError`, `WebSearchNotConfiguredError` added to
    `engine/src/tools/types.ts`; `{webfetch,websearch}.json` schema
    fixtures authored; engine package.json updated).
  - **WebFetch** (`engine/src/tools/webfetch.ts`, 19 unit tests). Input
    `{ url, prompt }`. URL must be `http:` or `https:` — `file:`,
    `data:`, `javascript:`, `gopher:`, `ftp:` rejected with
    `WebFetchProtocolError`. SSRF preflight via
    `dns.promises.lookup({ all: true, verbatim: true })` + `ipaddr.js`
    range labels: blocks `loopback`, `private`, `linkLocal`,
    `uniqueLocal`, `unspecified`, `multicast`, `reserved`. IPv4-mapped
    IPv6 unwrapped before classification. **Loopback-only override**
    via `webfetch.localhost` permission key — RFC1918, link-local,
    ULA are NEVER skippable, by design. `undici.request()` with
    `maxRedirections: 0`; manual redirect loop (≤5 hops) re-runs
    SSRF preflight on every hop (closes redirect-SSRF). Outgoing
    headers whitelist: only User-Agent
    (`jellyclaw/0.x (+https://github.com/gtrush03/jellyclaw-engine)`)
    + Accept — `authorization`, `cookie`, `proxy-authorization` never
    leave the process. Streaming size cap 10MB enforced from chunk
    counters (no trust in `Content-Length`); 30s timeouts. Content-type
    dispatch: `text/html` → Turndown (atx headings, fenced code) →
    Markdown; `text/plain`/`text/markdown`/`application/json`/
    `application/ld+json`/`application/xml`/`text/xml` (incl.
    `+json`/`+xml` suffixes) → passthrough; anything else →
    `ToolError("UnsupportedContentType")`. Returns
    `{ content, final_url, content_type, bytes }`. `prompt` field
    accepted for schema parity but only logged at debug level.
    Discarded response bodies drained via `body.dump()` to avoid
    AbortError noise.
  - **WebSearch** (`engine/src/tools/websearch.ts`, 9 unit tests).
    Stub tool — handler always throws `WebSearchNotConfiguredError`
    UNCONDITIONALLY (zod `.parse()` deliberately skipped so even
    invalid input still gets the actionable hint pointing to MCP
    config). Exports `emitWebSearchRegistrationWarning(logger)`
    helper that fires-once-per-process via a closure flag and is
    suppressed by `JELLYCLAW_WARN_WEBSEARCH=false` env. Companion
    `_resetWebSearchWarning()` test helper. `index.ts` carries a
    TODO to wire the warning into the engine bootstrap when
    Phase 10 lands (kept off module-load to avoid library
    import side effects).
  - **Registry** (`engine/src/tools/index.ts`): both tools added
    alphabetically (bash → edit → glob → grep → read → webfetch →
    websearch → write). Two agents coordinated via re-read-before-edit;
    no conflicts.
  - **`docs/tools.md`** created with `## WebFetch` (purpose, schema,
    SSRF guarantees + blocked-range list, override key semantics,
    size + timeout caps, content-type dispatch, header whitelist
    policy) and `## WebSearch` (why-stub, MCP wiring example,
    shadowing note for future phase work, `JELLYCLAW_WARN_WEBSEARCH`
    env). Future prompts (05) will append Glob/Grep/Bash/etc.
    sections to bring full tool matrix.
  - **DNS-rebinding caveat:** preflight resolves once and undici
    resolves again on connect — TOCTOU window theoretically open.
    Mitigation requires a custom dispatcher with fixed-IP connect
    override; punted to a follow-up phase (low practical risk for
    a developer-machine engine).
  - Gates: `bunx tsc --noEmit` ✅, `bunx biome check` ✅,
    `bun run test` 364 passed + 2 skipped ✅ (28 new — 19 + 9).
  - Remaining Phase 04 prompts: 05 (TodoWrite + Task stub +
    NotebookEdit + parity fixture + docs/tools.md round-out) — one
    final prompt closes Phase 04.
  - ✅ Prompt 03 (Glob + Grep) — executed via a 2-agent parallel Opus team
    against a pre-authored contract (tinyglobby + @vscode/ripgrep
    installed, schema fixtures `{glob,grep}.json` authored, engine
    package.json updated).
  - **Glob** (`engine/src/tools/glob.ts`, 12 unit tests + 1 bench).
    Input `{ pattern, path? }`. Pattern guard rejects `..` path
    segments (prevents `../../../etc/passwd` escapes even when `path`
    is inside cwd). Cwd jail with `glob.outside_cwd` override.
    Validates search root exists + is a directory. Reads `.gitignore`
    line-by-line at the search root and passes patterns via
    tinyglobby's `ignore` option (simplified: no negation `!` support
    — documented inline). Tinyglobby called with `{ absolute: true,
    dot: false, onlyFiles: true }`. Stats matches with concurrency 64,
    sorts by `mtimeMs` desc, silently drops stat races. Bench (BENCH=1
    gated, skipped otherwise): matched 100 `.md` files across 10k in
    **7ms** (budget 500ms).
  - **Grep** (`engine/src/tools/grep.ts`, 17 unit tests + 1 bench).
    Full Claude-Code-parity input schema including hyphenated keys
    (`"-i"`, `"-n"`, `"-A"`, `"-B"`, `"-C"`) preserved in the zod
    schema via quoted property names; `context`/`-A`/`-B`/`-C`
    capped at 50 per spec. Shells out to `rgPath` from
    `@vscode/ripgrep` via `spawn(rgPath, argv[])` — never shell
    string (load-bearing for safety: pattern comes from the model
    and may contain metachars; test asserts `$(whoami)` doesn't
    execute). Extra hardening: `--` argv terminator before pattern
    so leading-dash patterns aren't parsed as rg flags. Content
    mode uses `--json` with a partial-line buffer; file/count modes
    use the respective `--files-with-matches`/`--count-matches`
    flags. Discriminated-union output
    `{ mode: "content"|"files_with_matches"|"count", ... }` with
    `truncated?: boolean`. 50_000-char output truncation via
    **O(log n) binary search** over prefix length (initial O(n)
    implementation timed out on 20k-match inputs — replaced).
    rg exit 0/1 both treated as success (no matches is not an
    error); exit ≥ 2 → `ToolError("GrepFailed", stderr)`. Bench
    (BENCH=1): 100k files, 986 needle hits, **1937ms** (budget 3000ms).
  - **Registry** (`engine/src/tools/index.ts`): both agents
    coordinated via re-read-before-edit on a shared file;
    alphabetical order preserved (bash → edit → glob → grep → read
    → write). Both `export { ... }` block additions landed.
  - **Deviation:** Glob agent modified `vitest.config.ts` to add
    `test/**/*.bench.ts` to the include glob — necessary because the
    existing pattern matched only `*.test.ts` and the spec mandated
    the `.bench.ts` extension. Benches are gated by `BENCH=1` via
    `describe.skipIf` so CI cost remains zero by default. Full suite
    counts reflect the 2 skipped benches (23 passed + 2 skipped files).
  - **Deps:** `tinyglobby@^0.2.16`, `@vscode/ripgrep@^1.17.1` added to
    root + engine/package.json.
  - Gates: `bunx tsc --noEmit` ✅, `bunx biome check` ✅, `bun run test`
    336 passed + 2 skipped ✅, `BENCH=1 bun run test test/perf/`
    2 passed ✅ (both under budget).
  - Remaining Phase 04 prompts: 04 (WebFetch + TodoWrite + Task stub
    + NotebookEdit), 05 (parity fixture + docs/tools.md).
  - ✅ Prompt 02 (Edit tool + diagnostics + property tests) — executed via a
    single Opus agent against a shared contract authored in main session
    (new error classes `EditRequiresReadError`, `NoMatchError`,
    `AmbiguousMatchError`, `NoOpEditError` added to `engine/src/tools/types.ts`;
    `test/fixtures/tools/claude-code-schemas/edit.json` authored;
    `diff@^9.0.0` + `@types/diff@^8.0.0` + `fast-check@^4.6.0` installed
    and wired into engine/package.json).
  - **Edit** (`engine/src/tools/edit.ts`, 18 unit tests). Input
    `{ file_path, old_string, new_string, replace_all?: false }`.
    Preconditions: absolute path, cwd jail (with `edit.outside_cwd`
    override), `readCache` membership (or `EditRequiresReadError`),
    file existence (Edit never creates — use Write), `old ≠ new` (or
    `NoOpEditError`), and `replace_all + empty old_string` rejected
    as infinite match. Replacement uses occurrence counting via
    `split(old).length - 1` (avoids regex-metachar pitfalls); single
    replacement via `indexOf` + slice (handles `$` in new_string
    safely); `replace_all` via `split().join()`. EOF newline
    preserved in both directions. Atomic write via
    `<path>.jellyclaw.tmp` → `renameSync` with tmp cleanup on
    failure. `diff_preview` is a 6-line body extract from
    `createPatch` (header stripped) — 6-line body from `diff`
    package's unified-diff output. Returns
    `{ file_path, occurrences_replaced, diff_preview }`.
  - **Diagnostics** (`engine/src/tools/edit-diagnostics.ts`, 7 tests).
    Pure `explainMissingMatch(content, oldString)` helper with six
    ordered branches: empty old_string, line-number-prefix hint
    (matches `^\d+\t`), CRLF-in-file-vs-LF-in-old, LF-in-file-vs-
    CRLF-in-old, whitespace-only mismatch (via `\s+` collapse), and
    a genuinely-absent fall-through. Diagnostic is bounded ≤ 400
    chars regardless of file size (privacy — no raw file contents
    leaked into error messages).
  - **Property tests** (`test/unit/tools/edit.property.test.ts`,
    fast-check seeded `{ seed: 42, numRuns: 100 }`). Property 1:
    unique-marker replacement correctness — for random `prefix`,
    `suffix`, `marker ∈ [A-Z]{3,10}`, `replacement`, Edit returns
    `prefix + replacement + suffix`. Property 2: ambiguous-match
    count correctness — for random `marker` and `k ∈ [2, 8]`,
    content `(marker + " ").repeat(k)` raises `AmbiguousMatchError`
    with `.count === k`. Real disk I/O per iteration via tmp dir
    setup/teardown in the property body (≤ ~2s total).
  - **Registry** (`engine/src/tools/index.ts`): `editTool` registered
    alphabetically between bash and read; `export { editTool }`
    added. `getTool("Edit")` smoke-tested.
  - **Minor deviation from spec:** agent reworded the line-number-
    prefix diagnostic from the literal ``` `${lineNo}\t${content}` ```
    template-placeholder string (which trips Biome's
    `noTemplateCurlyInString` rule) to `"<lineNo>\t<content>"` —
    semantics unchanged, tests assert the `"line-number prefix"`
    substring so callers see the same hint.
  - Gates: `bunx tsc --noEmit` ✅, `bunx biome check` ✅,
    `bun run test` 307/307 ✅ (27 new — 18 + 2 + 7).
  - Remaining Phase 04 prompts: 03 (Glob + Grep), 04 (WebFetch +
    TodoWrite + Task stub + NotebookEdit), 05 (parity fixture +
    docs/tools.md) — each on its own fresh session.
  - ✅ Prompt 01 (Bash + Read + Write) — executed via a 3-agent parallel Opus
    team. Shared `engine/src/tools/types.ts` (Tool/ToolContext/PermissionService
    interfaces + typed error taxonomy: ToolError, InvalidInputError,
    BlockedCommandError, CwdEscapeError, TimeoutError, WriteRequiresReadError,
    PermissionDeniedError, StaleReadError) + `engine/src/tools/permissions.ts`
    (`allowAll`/`denyAll`/`fromMap` helpers) authored in main session before
    dispatch so all three agents coded against the same contract. Three
    Claude-Code JSON-Schema fixtures landed under
    `test/fixtures/tools/claude-code-schemas/{bash,read,write}.json` —
    each tool imports its fixture via ESM `with { type: "json" }` and the
    parity tests assert `inputSchema` deep-equals the fixture.
  - **Bash** (`engine/src/tools/bash.ts`, 16 tests). Input
    `{ command, description?, timeout?, run_in_background? }` (default
    120s / max 600s). Pre-exec blocklist rejects `rm -rf /`, `rm -rf /*`,
    `rm -rf ~/`, `rm -rf $HOME`, `curl|sh`/`wget|sh`, fork bomb, and
    `dd if=… of=/dev/sd*`; bypass guard catches `bash -c 'rm -rf /'`.
    Env scrub whitelist (PATH, HOME, USER, LANG, LC_ALL, TERM, TMPDIR,
    SHELL, PWD) — never leaks `ANTHROPIC_API_KEY` even when present in
    parent env (test asserts). Foreground spawn via
    `child_process.spawn({ shell: "/bin/bash", cwd, signal, timeout })`
    with 30_000-char stdout/stderr truncation + `[truncated N chars]`
    marker. SIGKILL fallback beside the built-in timeout guarantees
    `TimeoutError` across platforms. Background mode: spawn detached
    with fd-backed log; log renamed to `~/.jellyclaw/bash-bg/<pid>.log`
    after pid is known; `child.unref()` + returns `{ pid, tail_url }`
    immediately. `cd ..` substring refused unless `permissions.isAllowed("bash")`.
  - **Read** (`engine/src/tools/read.ts`, 13 tests). Input
    `{ file_path, offset?, limit?, pages? }`. Absolute-path required;
    cwd jail via `resolved === cwd || startsWith(cwd + sep)`; override
    gated by `read.outside_cwd` permission. Dispatch by extension:
    `.ipynb` → JSON parse, cells + outputs preserved, offset/limit over
    cell count; `.pdf` → `pdfjs-dist/legacy/build/pdf.mjs` with
    `disableWorker: true`, range parsing (`"1-5"`/`"3"`), >10-page
    PDFs without `pages` throw `InvalidInputError`, span >20 rejected,
    end>total silently clamped; images
    (`.png/.jpg/.jpeg/.gif/.webp`) → `{ source: { type: "base64",
    media_type, data } }`; text default → cat-n formatted
    `${lineNo}\t${content}`, 1-indexed, default 2000 lines, empty-file
    system-reminder notice. On success populates `ctx.readCache`.
    PDF fixtures (2-page + 20-page) synthesised into `os.tmpdir()`
    at `beforeAll` via a hand-rolled `buildPdfBytes` helper rather
    than committing opaque binaries — spec permitted, tests clean up
    in `afterAll`.
  - **Write** (`engine/src/tools/write.ts`, 9 tests). Input
    `{ file_path, content }`. Absolute-path required. Cwd jail gated
    by `write.outside_cwd`. Read-before-overwrite invariant: if the
    target exists on disk AND `resolve(file_path)` is not in
    `ctx.readCache` → `WriteRequiresReadError`; new-file creation
    always allowed. Atomic write: `<path>.jellyclaw.tmp` → `renameSync`;
    failure cleans up the tmp. Trailing-newline preservation matches
    Claude Code (auto-append `\n` when prior file ended in `\n` and
    new content does not; debug-log `write.trailing_newline_preserved`).
    StaleReadError mtime check deferred (readCache is `Set<string>`,
    not `Map<path, mtime>` — TODO left inline for a future readCache
    upgrade). Atomic-rename failure test uses a pre-created blocker
    directory rather than `vi.spyOn(fs)` because ESM namespace
    spying is not supported in this vitest/ESM config — the
    load-bearing invariant (original file untouched on failure) is
    still exercised.
  - **Registry** (`engine/src/tools/index.ts`): `builtinTools` array +
    `listTools()` + `getTool(name)` + re-exports of the three tools,
    types, and permission helpers. Biome passes: targeted
    `biome-ignore useAwait` on `bashTool.handler` and
    `writeTool.handler` (Tool contract demands `async` even where
    the body is sync fs I/O).
  - **Deps:** `pdfjs-dist@^5.6.0` added to both root and
    `engine/package.json`. No other new deps.
  - Gates: `bunx tsc --noEmit` ✅, `bunx biome check engine/src/tools
    test/unit/tools test/fixtures/tools` ✅ (3 pre-existing
    template-literal-regex warnings in the PDF builder, orthogonal),
    `bun run test` 280/280 ✅ (38 new). Remaining Phase 04 prompts
    (02 Edit + Glob + Grep, 03 WebFetch + TodoWrite + Task stub, 04
    NotebookEdit, 05 parity fixture + docs) run on subsequent
    sessions — Phase 04 stays open.

### Phase 05 — Skills system
- **Status:** 🔄 In progress
- **Started:** 2026-04-15
- **Completed:** —
- **Duration (actual):** —
- **Session count:** 1
- **Commits:** (pending)
- **Tests passing:** 449/449 + 2 skipped (26 new in Phase 05)
- **Notes:**
  - ✅ Prompt 01 (discovery + loader) — `engine/src/skills/{types,parser,discovery,registry,index}.ts` +
    matching `*.test.ts` files + `engine/scripts/skills-dump.ts` smoke script. Frontmatter Zod
    schema (`name` kebab-case, `description` 1..1536, optional `trigger` + `allowed_tools`).
    Body cap 8 KB **measured in bytes** (not chars). Discovery walks three roots in order
    (`~/.jellyclaw/skills → cwd/.jellyclaw/skills → cwd/.claude/skills`), supports both
    dir-per-skill (`<name>/SKILL.md`) and flat (`<name>.md`) layouts; dir-per-skill wins
    inside a single root. Registry first-wins across sources with per-shadow warn log
    (`{kept, shadowed, keptSource, shadowedSource}`); per-file parse errors are caught
    and warned without aborting `loadAll`. `loadAll` kept async with biome-ignore to
    preserve the contract for prompt 02's chokidar watcher. Deps added: `gray-matter@^4.0.3`,
    `chokidar@^4.0.0` (chokidar pinned now, wired in prompt 02). Smoke script verified loads
    the user-root `hello` skill. Typecheck ✅, biome ✅ on skills/, vitest 449/449 + 2 skipped ✅
    (26 new: discovery 9, parser 10, registry 7). Progressive disclosure, `$ARGUMENTS`
    substitution, and watcher land in prompt 02.

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
| 2026-04-15 | 14 | 05 | 01-discovery-and-loader | 🔄 Phase 05 Prompt 01 landed. `engine/src/skills/{types,parser,discovery,registry,index}.ts` + three `*.test.ts` + `engine/scripts/skills-dump.ts` smoke. Zod frontmatter (`name` kebab-case, `description` ≤1536), 8 KB body cap measured in **bytes**. Discovery walks `~/.jellyclaw/skills` → `cwd/.jellyclaw/skills` → `cwd/.claude/skills` (legacy), supporting both `<name>/SKILL.md` and `<name>.md` shapes with dir-per-skill winning inside a single root. Registry first-wins across sources with per-shadow warn log; per-file parse failures are caught + warned, rest of load proceeds. `loadAll` kept async (biome-ignore) for prompt 02's chokidar seam. Deps: `gray-matter@^4.0.3`, `chokidar@^4.0.0`. Smoke loads `~/.jellyclaw/skills/hello` as source=user. Typecheck ✅, biome ✅ on skills/, vitest 449/449 + 2 skipped ✅ (26 new: discovery 9, parser 10, registry 7). |
| 2026-04-15 | 13 | 04 | 05-todowrite-task | ✅ **Phase 04 COMPLETE.** 3-agent parallel Opus team delivered TodoWrite (15 tests, full-list replace + single in_progress invariant + session.update delegation), Task (10 tests, thin pass-through to ctx.subagents.dispatch with Phase-04 stub `SubagentsNotImplementedError`), NotebookEdit (18 tests, nbformat v4 enforced, replace/insert/delete with output preservation + cell_type-change reset + atomic rename + read-before-edit invariant). Pre-authored contract: extended ToolContext with `session?` + `subagents?`, added `engine/src/subagents/{types,stub}.ts`, 6 new error classes, 3 schema fixtures + parity-allowed-drift.json. Parity suite (16 tests) asserts all 11 tools registered + names match Claude Code canon + every inputSchema deep-equals its JSON fixture + drift list empty. `docs/tools.md` rounded out with full 11-tool matrix + per-tool sections. Deps: `zod-to-json-schema@^3.25`. Typecheck ✅, biome ✅, vitest 423/423 + 2 skipped ✅ (59 new). Foundation group now 5/7. |
| 2026-04-15 | 12 | 04 | 04-webfetch-websearch | 🔄 Phase 04 Prompt 04 landed via 2-agent parallel Opus team. `engine/src/tools/webfetch.ts` (19 tests): undici `request()` with manual redirect loop (≤5 hops, per-hop SSRF re-check), `ipaddr.js`-backed range classification (blocks loopback/private/link-local/ULA/multicast/unspecified/reserved with IPv4-mapped IPv6 unwrap), 10MB streaming cap from chunk counters, 30s timeouts, header whitelist (UA + Accept only — no auth/cookies), Turndown HTML→Markdown, text/JSON/XML (incl. +json/+xml) passthrough. Loopback-only override via `webfetch.localhost` permission. `engine/src/tools/websearch.ts` (9 tests): stub throws `WebSearchNotConfiguredError` unconditionally with MCP-config hint; one-time registration-warning helper exported for Phase 10 bootstrap. New error classes: `SsrfBlockedError`, `WebFetchProtocolError`, `WebFetchSizeError`, `WebSearchNotConfiguredError`. Registry updated alphabetically. `docs/tools.md` created with WebFetch + WebSearch sections. Deps: `undici@^8.1`, `turndown@^7.2`, `ipaddr.js@^2.3`, `@types/turndown@^5`. Typecheck ✅, biome ✅, vitest 364/364 + 2 skipped ✅. |
| 2026-04-15 | 11 | 04 | 03-glob-grep | 🔄 Phase 04 Prompt 03 landed via 2-agent parallel Opus team. `engine/src/tools/glob.ts` (12 tests + 1 bench): tinyglobby-backed with `..`-segment refusal, `.gitignore` line-by-line filter (no negation), mtime-desc sort, cwd jail. `engine/src/tools/grep.ts` (17 tests + 1 bench): @vscode/ripgrep via spawn(argv[]) never shell, `--` terminator hardening, content/files_with_matches/count modes with discriminated union, O(log n) binary-search truncation at 50k chars, context cap 50. Registry updated alphabetically by both agents via re-read-before-edit coordination. Vitest config gained `test/**/*.bench.ts` include. Deps: `tinyglobby@^0.2`, `@vscode/ripgrep@^1.17`. Typecheck ✅, biome ✅, vitest 336/336 + 2 skipped ✅. Bench (BENCH=1) Glob 7ms (10k files, budget 500ms) + Grep 1937ms (100k files, budget 3000ms). |
| 2026-04-15 | 10 | 04 | 02-edit | 🔄 Phase 04 Prompt 02 landed. 1 Opus agent delivered `engine/src/tools/edit.ts` (unique-match invariant + `replace_all` + atomic rename + EOF newline preservation + 6-line unified-diff preview), `engine/src/tools/edit-diagnostics.ts` (pure `explainMissingMatch` with 6 ordered branches, bounded ≤400 chars), and 3 test files: `edit.test.ts` (18), `edit.property.test.ts` (2 props × 100 runs, seed 42), `edit-diagnostics.test.ts` (7). New error classes `EditRequiresReadError / NoMatchError / AmbiguousMatchError / NoOpEditError` added to `types.ts`. Registry updated alphabetically. Deps: `diff@^9` + `@types/diff@^8` + `fast-check@^4`. Typecheck ✅, biome ✅, vitest 307/307 ✅ (27 new). |
| 2026-04-15 | 9 | 04 | 01-bash-read-write | 🔄 Phase 04 Prompt 01 landed. 3-agent parallel Opus team delivered `engine/src/tools/{bash,read,write}.ts` + matching tests in `test/unit/tools/` (Bash 16 + Read 13 + Write 9 = 38 new tests). Shared `types.ts` + `permissions.ts` + 3 Claude-Code JSON-Schema fixtures pre-authored for contract alignment. Registry `engine/src/tools/index.ts` exports `listTools()` / `getTool()`. Bash: blocklist (rm-rf, curl|sh, fork bomb, dd), bash-c bypass guard, env scrub, 30k-char truncation, background mode with `~/.jellyclaw/bash-bg/<pid>.log`. Read: absolute-path jail, ipynb + PDF (pdfjs-dist) + image + text dispatch, pages range with >10-page gate + >20-page refusal, readCache population. Write: read-before-overwrite invariant, atomic rename, trailing-newline preservation, outside-cwd gate. Deps: `pdfjs-dist@^5.6.0`. Typecheck ✅, biome ✅, vitest 280/280 ✅. Remaining Phase 04 prompts queued. |
| 2026-04-15 | 8 | 03 | 02-implement-adapter | ✅ Phase 03 COMPLETE. 2-agent parallel team delivered `engine/src/adapters/opencode-events.ts` (940 lines, 7 tests — happy path + late-start ordering + orphan-end timeout + parse-error tolerance + subagent nesting + AbortController + backpressure) and `engine/src/stream/emit.ts` (200 lines, 54 vitest cases — writeEvent/drain, all 3 format downgrades, claude-code-compat delta coalescing, claurst-min flat-shape rewrite, stateless `downgrade()` matrix, backpressure). Golden replay via `test/golden/replay.test.ts` + `hello.opencode.jsonl` + `hello.jellyclaw.jsonl` (regenerable via `GOLDEN_UPDATE=1`; narrow normaliser proven by mutation test). Scratch smoke `engine/scratch/emit-hello.ts` hand-verified all 3 output formats produce distinct correct output. `eventsource-parser@^3` added. Main session reconciled: added 4 targeted `biome-ignore useAwait` comments on async generators. Typecheck ✅, biome ✅, vitest 242/242 ✅. |
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
