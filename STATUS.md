# Jellyclaw — Status

> Living doc. Update at the start and end of every working day.
> If this file is stale, don't trust it.

**Last updated:** 2026-04-15 (Phase 99 Prompt 05 ✅ — demolished vendored OpenCode TUI (899M), slim HTTP client landed)
**Current phase:** Phase 99 — Unfucking (5/8 prompts complete; Phase 11 queued behind it).
**Current milestone target:** M1 (Engine works) — projected week of May 18
**Engine on:** n/a (not yet bootable)
**Genie dispatcher:** Claurst (unchanged)

---

## Blockers

None.

Pre-flight questions that should be answered before Phase 02 starts (see
`MASTER-PLAN.md` §10):

- [ ] Q1: Genie hook taxonomy — any hooks outside Claude Code's set?
- [ ] Q2: Monthly Anthropic API budget ceiling for tests + burn-in
- [ ] Q3: jelly-claw IPC surface (sidecar vs child process)
- [ ] Q4: License choice — MIT or Apache-2.0
- [ ] Q5: Apple Developer ID / notarization readiness
- [ ] Q6: Telemetry opt-in vs opt-out policy

---

## Wins this week

- **JellyJelly brand refresh** landed via 4-agent Opus ultrathink sprint:
  brand brief → 9-letter JELLYCLAW stencil wordmark (cyan→violet gradient,
  5 rows, readable) → deep-sea theme JSON (`#3BA7FF`/`#9E7BFF`/`#FFB547`/
  `#0A1020`) → spinner amber heartbeat → in-TUI API key capture
  (`~/.jellyclaw/credentials.json` 0600) + `jellyclaw key` rotation + pino
  redact. tsc clean; 67/67 TUI tests + 17 credentials tests pass; build
  green. 8 pre-existing `tui.test.ts` spawn-timeouts untouched.
- Repo skeleton created under `/Users/gtrush/Downloads/jellyclaw-engine/`
- Five parallel documentation agents dispatched
- `engine/SPEC.md`, `engine/SECURITY.md`, `engine/CVE-MITIGATION.md` landed
- `phases/README.md` + first 4 phase runbooks landed
- Master plan, status, roadmap produced

---

## Burn rate

| Category | This week | Cumulative |
|----------|-----------|------------|
| Anthropic API | $0.00 | $0.00 |
| OpenRouter | $0.00 | $0.00 |
| Infra (Fly, Vercel, etc.) | $0.00 | $0.00 |
| Signing / notarization | $0.00 | $0.00 |
| **Total** | **$0.00** | **$0.00** |

Budget ceiling for v1.0 (Phases 00–18): **TBD — pending Q2 answer.**

---

## Tests

| Metric | Count |
|--------|-------|
| Unit tests passing | 24/25 library (1 skipped = consumer smoke, gated on JELLYCLAW_LIB_CONSUMER_TEST=1) + prior ~1101 default / 1107 opt-in suites intact (+14 skipped, +2 benches under BENCH=1, +5 Playwright under JELLYCLAW_PW_MCP_TEST=1, +6 HTTP E2E under JELLYCLAW_HTTP_E2E=1) |
| Integration tests passing | 11 (subagent hook-fire regression) |
| Unit tests failing | 0 |
| Integration tests passing | 0 |
| Golden-prompt regression tests | 0 / 5 target |
| CI green streak (days) | n/a |

---

## Deploys

| Surface | Version | Status |
|---------|---------|--------|
| npm (`jellyclaw`) | unpublished | — |
| brew (`jellyclaw`) | unpublished | — |
| GitHub repo | private | — |
| Desktop `.dmg` | unbuilt | — |
| Docs site | unbuilt | — |

---

## Phase progress

- [x] ✅ Phase 00 — Repo scaffolding
- [x] ✅ Phase 01 — OpenCode pinning + patching
- [x] ✅ Phase 02 — Config + provider layer
- [x] ✅ Phase 03 — Event stream adapter
- [x] ✅ Phase 04 — Tool parity
- [x] ✅ Phase 05 — Skills system
- [x] ✅ Phase 06 — Subagents + hook patch
- [x] ✅ Phase 07 — MCP client integration
- [x] ✅ Phase 08 — Permission engine + hooks
- [x] ✅ Phase 09 — Session persistence + resume
- [x] ✅ Phase 10 — CLI + HTTP server + library
- [x] ✅ Phase 10.5 — Interactive TUI (4/4 prompts — 01 ✅, 02 ✅, 03 ✅, 04 ✅)
- [ ] 🔄 Phase 99 — Unfucking (5/8 — 01 ✅ adapter, 02 ✅ loop, 03 ✅ wire, 04 ✅ claude-stream-json, 05 ✅ demolish vendored)
- [ ] Phase 11 — Testing harness
- [ ] Phase 12 — Genie integration behind flag
- [ ] Phase 13 — Make jellyclaw default in Genie
- [ ] Phase 14 — Observability + tracing
- [ ] Phase 15 — Desktop MVP
- [ ] Phase 16 — Desktop polish
- [ ] Phase 17 — jelly-claw integration
- [ ] Phase 18 — Open-source release
- [ ] Phase 19 — Post-launch stabilization (ongoing)

---

## Daily log

### 2026-04-14
- Initial scaffold. No code. No tests. Baseline captured.
- Next action: George executes the 10-item checklist at the end of
  `MASTER-PLAN.md`.

### 2026-04-15 (Phase 08.02 session)
- Phase 08 Prompt 02 (hooks engine — 10 event kinds) landed via 3-agent
  parallel Opus team against pre-authored `engine/src/hooks/types.ts`
  (frozen contract: 10 event payload interfaces, `HookConfig`,
  `CompiledHook`, `HookOutcome`, `HookRunResult`, `HookAuditEntry`,
  `BLOCKING_EVENTS`, `MODIFIABLE_EVENTS`). Agent A: `runner.ts` + 18 tests
  via 11 bash fixtures — `spawn` with `shell:false` NO INTERPOLATION,
  argv-only, SIGTERM→SIGKILL 1s grace, 1MB stdout/stderr cap, 30s default
  (120s max), exit 2 = deny only on blocking events, `modify` only on
  Pre/UserPromptSubmit, never throws. Agent B: `events.ts` (10 `.strict()`
  Zod schemas + `truncateToolResultForHook` 256KB, 28 tests) +
  `registry.ts` (`HookRegistry` reusing permissions matcher grammar,
  `runHooksWith(runner, opts)` test seam; first-deny-wins +
  last-write-wins modify + non-blocking PostToolUse fire-and-forget,
  17 tests) + `index.ts` barrel. Agent C: `audit-log.ts` (50MB×5
  rotation, 0600 file mode, 14 tests) + config `HookConfigSchema`/
  `HooksBlock` (+7 tests) + `permissions/engine.ts` added
  `decideWithHooks()` as PURE SUPERSET — existing `decide()` unchanged;
  hook-deny authoritative, hook-modify rebuilds ToolCall, hook-allow
  advisory; bypass still fires hook for deny-wins + perms-integ 10 tests
  + e2e 4 real-bash tests + `docs/hooks.md` (~280 lines). Typecheck ✅,
  vitest 822/830 ✅ (+98 new), biome 0 errors on owned files. **Deferred
  to Phase 10:** registry's default audit sink is a local no-op — CLI
  bootstrap will wire `defaultHookAuditSink` explicitly. Next: 08.03
  rate limiter + secret scrub + config-check rule linter.

### 2026-04-15 (Phase 08.01 session)
- Phase 08 Prompt 01 (permission modes + rule matcher) landed via 2-agent
  parallel Opus team against a pre-authored `engine/src/permissions/types.ts`
  contract. Agent A: `rules.ts` + `rules.test.ts` (39 tests) — picomatch
  `{dot:true, nonegate:true}`, naked-tool identity predicate, MCP
  server-exact wildcards, per-tool arg-string derivation with
  `path.normalize`; bad rules → warnings not errors. Agent B: `engine.ts` +
  `prompt.ts` + `index.ts` + `engine.test.ts` (28 tests) + `config/schema.ts`
  REPLACED record-shape with structured `PermissionsBlock` +
  `schema.test.ts` (+5) + `docs/permissions.md` + `engine/scripts/permissions-matrix.ts`
  (128-row dump). **Deny-wins invariant** with dedicated regression test.
  Ask-flow denies on no-handler/throw/non-TTY — never silent allow.
  `defaultAuditSink` writes to `~/.jellyclaw/logs/permissions.jsonl`;
  `redactInputForAudit` mirrors Phase-07 credential scrubbing. Deps:
  `picomatch@^4`, `@types/picomatch`. Typecheck ✅, vitest 724/732 ✅
  (+72 new), biome clean on owned files. **Documented deviation:**
  picomatch `*` doesn't cross `/` — `Bash(rm *)` matches `rm foo` but NOT
  `rm -rf /`; test suite pins Claude-Code-parity semantics, docs call it out.
  Next: 08.02 hooks engine (8 event kinds + stdin/stdout JSON contract).

### 2026-04-15 (earlier)
- Phase 00 verified. `bun install / typecheck / lint / test / build` all green from a
  fresh `rm -rf node_modules dist`. 6/6 smoke tests pass. Git initialized, first commit
  `6644aaf` created, tag `v0.0.0-scaffold` set. Minor drift fixes: workspace stubs,
  Biome 2 migration, zod v4 `z.record` 2-arg, type aliases, duplicate shebang removed.
- Phase 01 Prompt 01 (research) landed: `engine/opencode-research-notes.md`
  (950 lines, commit `dcb0601`). Pin target `opencode-ai@1.4.5`. Issue #5894
  rescoped to add `agent` context to hook envelope; SPEC §5.1 drift flagged
  (refers to `processor.ts`; real target is `prompt.ts`).
- Phase 01 Prompt 02 (implementation) complete via PIVOT — opencode-ai@1.4.5
  ships a compiled Bun binary, no source to patch. All three planned patches
  reimplemented as first-class jellyclaw code. 48/48 tests green.
- Phase 02 Prompt 01 (research) landed: `engine/provider-research-notes.md`
  (1753 lines). Anthropic streaming + tool use + caching + retry fully
  documented; OpenRouter endpoint contract + tool mapping + both caching
  regressions (#1245, #17910) deep-dived; `acknowledgeCachingLimits` gate
  decision table authored.
- Phase 02 Prompt 02 (Anthropic provider) landed: `engine/src/config/{schema,loader}.ts`
  + `engine/src/providers/{types,cache-breakpoints,anthropic,index}.ts` + tests.
  SPEC §9 config shape authoritative; SPEC §7 cache_control plan pure-function;
  `anthropic-beta: extended-cache-ttl-2025-04-11` header auto-set on 1h TTL;
  own retry loop (3 attempts / 30s / jitter / Retry-After honored). 93/93 tests.
- Phase 02 Prompt 03 (OpenRouter provider + router/fallback + gate + pool + docs)
  landed via a 5-agent parallel team. `openrouter.ts` (SSE hand-parsed,
  cache_control stripped unconditionally, warn-once for anthropic/* models),
  `router.ts` (pre-stream-only failover), `gate.ts`, `credential-pool.ts`,
  `docs/providers.md` (658 lines). 147/147 tests ✅. **Phase 02 ✅ COMPLETE.**
- Phase 03 Prompt 01 (schemas + mapping) landed: `@jellyclaw/shared` workspace
  created (`shared/src/events.ts` — 15-variant `z.discriminatedUnion` + `Usage` +
  minimal `Message`/`Block` shapes + `redactConfig` + factory-generated type
  guards + `OUTPUT_FORMAT_EVENTS` downgrade table). `shared/src/events.test.ts`
  (32 tests — round-trip per variant, unknown-type rejection, Usage defaults,
  guard narrowing, exhaustive-switch compile-check, redactor). `docs/event-stream.md`
  (upstream mapping table covering every observed OpenCode bus event + explicit
  dropped-with-reason entries, output-format matrix, ordering invariants,
  redaction rule list). Root `package.json` workspaces + `tsconfig.json` paths +
  `vitest.config.ts` alias all updated. Smoke import from engine verified via
  `engine/src/stream/smoke-import.ts`. 179/179 tests green, typecheck ✅,
  `biome check shared/ engine/src/stream/` ✅.
- Phase 03 Prompt 02 (adapter + emitter + golden replay) landed via a 2-agent
  parallel team. `engine/src/adapters/opencode-events.ts` (940 lines, 7 tests —
  happy-path sequence, late-start ordering, orphan-end timeout with fake timers,
  parse-error tolerance, subagent nesting, AbortController cancellation,
  backpressure under slow-consumer load). `engine/src/stream/emit.ts` (200 lines,
  54 vitest cases — drain-aware `writeEvent`, stateless `downgrade()` matrix
  across 15 events × 3 formats, `claude-code-compat` delta coalescing with
  synthetic-message flush on `finish()`, `claurst-min` flat-shape rewrite).
  Golden replay via `test/golden/replay.test.ts` + `hello.opencode.jsonl` +
  `hello.jellyclaw.jsonl` (regenerable via `GOLDEN_UPDATE=1`; narrow normaliser
  strips only `ts`/`session_id`/`duration_ms`/`stats.duration_ms`, proven
  narrow by a mutation test). `engine/scratch/emit-hello.ts` scratch smoke
  hand-verified all three output formats produce distinct correct output.
  `eventsource-parser@^3` added. Main-session reconcile: 4 targeted
  `biome-ignore useAwait` comments on async generators + wrapper functions.
  242/242 tests green, typecheck ✅, biome ✅ on all Phase 03 files.
  **Phase 03 ✅ COMPLETE.**
- Phase 04 Prompt 01 (Bash + Read + Write) landed via a 3-agent parallel Opus
  team. Shared `engine/src/tools/types.ts` (Tool/ToolContext/PermissionService
  + typed error taxonomy) + `permissions.ts` + 3 Claude-Code JSON-Schema
  fixtures authored up-front so all three agents coded against the same
  contract. Bash: blocklist + bash-c bypass guard + env scrub + 30k-char
  truncation + background mode (`~/.jellyclaw/bash-bg/<pid>.log`). Read:
  absolute-path jail + ipynb/PDF/image/text dispatch via pdfjs-dist
  (legacy build, disableWorker) + readCache population. Write:
  read-before-overwrite invariant + atomic rename + trailing-newline
  preservation. Registry `engine/src/tools/index.ts` exports
  `listTools()` / `getTool()`. `pdfjs-dist@^5.6.0` added. 280/280 tests ✅
  (38 new: 16 Bash + 13 Read + 9 Write). Typecheck ✅, biome ✅.
- Phase 04 Prompt 02 (Edit + diagnostics + property tests) landed via a
  single Opus agent against a pre-authored contract (new error classes,
  edit.json schema fixture, deps installed). Edit enforces unique-match
  invariant with `replace_all` override, rejects no-ops, refuses to
  create files (that's Write), preserves EOF newline, uses atomic
  rename with tmp cleanup, and returns a 6-line unified-diff preview.
  `explainMissingMatch` diagnoses CRLF, line-number-prefix, and
  whitespace-only mismatches — privacy-bounded ≤400 chars. Property
  tests (fast-check, seed 42, 100 runs) prove unique replacement
  correctness and ambiguous-count correctness. 307/307 tests ✅
  (27 new: 18 + 2 + 7). Typecheck ✅, biome ✅.
- Phase 04 Prompt 03 (Glob + Grep + benches) landed via a 2-agent parallel
  Opus team. Glob (tinyglobby-backed, mtime-desc sort, `.gitignore`
  line-filter, `..`-segment refusal) — 12 tests + bench 7ms/10k files.
  Grep (@vscode/ripgrep via `spawn(argv)` never shell, `--` argv
  terminator, content/files_with_matches/count modes, O(log n)
  binary-search truncation at 50k chars, context cap 50) — 17 tests +
  bench 1937ms/100k files. Deps: `tinyglobby@^0.2`, `@vscode/ripgrep@^1.17`.
  Vitest config gained `test/**/*.bench.ts` include. 336/336 + 2 skipped
  ✅. Typecheck ✅, biome ✅.
- Phase 04 Prompt 04 (WebFetch + WebSearch stub) landed via a 2-agent
  parallel Opus team. WebFetch: undici-backed with full SSRF protection
  via `ipaddr.js` range labels (blocks loopback/private/link-local/ULA/
  multicast/unspecified/reserved), per-hop redirect SSRF re-check (≤5
  hops), 10MB streaming cap, 30s timeouts, header whitelist (UA + Accept
  only — no auth/cookies leak), Turndown HTML→MD + text/JSON/XML
  passthrough. Loopback-only override via `webfetch.localhost`
  permission (RFC1918/link-local/ULA never skippable). WebSearch: stub
  throws `WebSearchNotConfiguredError` unconditionally pointing to MCP
  config; one-time registration-warning helper exported for Phase 10
  bootstrap. Deps: `undici@^8.1`, `turndown@^7.2`, `ipaddr.js@^2.3`,
  `@types/turndown@^5`. `docs/tools.md` created. 364/364 + 2 skipped ✅
  (28 new). Typecheck ✅, biome ✅.
- Phase 04 Prompt 05 (TodoWrite + Task + NotebookEdit + parity suite +
  docs round-out) landed via a 3-agent parallel Opus team. TodoWrite
  enforces full-list replace + single in_progress invariant via
  `ctx.session.update`. Task is a thin pass-through to `ctx.subagents`
  — Phase-04 stub throws `SubagentsNotImplementedError` with a
  Phase-06 hint. NotebookEdit enforces nbformat v4 with
  replace/insert/delete + output preservation + cell_type-change reset
  + atomic rename + read-before-edit invariant. **Parity suite**
  asserts all 11 tools registered + names match Claude Code canon +
  every inputSchema deep-equals its JSON fixture + drift list empty.
  Pre-authored: `engine/src/subagents/{types,stub}.ts`, 6 new error
  classes, 3 fixtures, `parity-allowed-drift.json`,
  `zod-to-json-schema@^3.25`. `docs/tools.md` rounded out with full
  11-tool matrix table + per-tool sections. 423/423 + 2 skipped ✅
  (59 new). Typecheck ✅, biome ✅. **Phase 04 ✅ COMPLETE.**
- Next action: Phase 05 — Skills system. Fresh Claude session.
- Phase 07 Prompt 01 (stdio MCP client) landed via 2-agent parallel Opus team.
  `@modelcontextprotocol/sdk@^1` installed (1.29.0). (A) `credential-strip.ts`
  (12 tests) — `buildCredentialScrubber` over env values, longest-first,
  metachar-escaped, <6-char / empty skipped via `onSkipped`, identity fallback.
  (B) `client-stdio.ts` (6 tests) — SDK `Client` over `StdioClientTransport`,
  serialized `#enqueue`, 10 s connect timeout, cancellable [0.5/1/2/4/8]s × 5
  reconnect → `dead`, SIGTERM→SIGKILL (3 s grace), credential scrubber on
  stderr/errors/timeouts/listener-errors, zero `env` logging.
  (C) `registry.ts` (10 tests) — `McpRegistry` parallel connect, DI
  `clientFactory`, 30 s background retry rebuilds dead clients, snapshot,
  namespaced routing, `McpUnknownServerError`/`McpNotReadyError`. Barrel +
  fixture (`echo-server.ts`) + smoke script (`engine/scripts/mcp-list.ts`,
  verified end-to-end: `mcp: 1 live, 0 dead, 0 retrying` + `mcp__echo__echo`).
  Typecheck ✅, biome ✅, vitest 586/589 + 3 skipped ✅ (+28 new). Root
  `JellyclawConfig.mcp` schema left untouched — Prompt 02 owns the
  transport-discriminant extension with HTTP+SSE + OAuth.
- Phase 07 Prompt 02 (HTTP + SSE + OAuth) landed via 5-agent parallel Opus
  team. Root `JellyclawConfig.mcp` now a `z.discriminatedUnion` on
  `transport: "stdio"|"http"|"sse"` with `OAuthConfig` sub-schema.
  (A) `token-store.ts` (20 tests) — 0600-mode store with pre-read mode
  check, atomic write, token-scrubbed errors. (B) `oauth.ts` (20 tests)
  — SDK `OAuthClientProvider` impl with PKCE S256, loopback callback
  listener `awaitOAuthCallback()`, state-mismatch + port-in-use errors,
  cross-platform browser opener. (C) `client-http.ts` (6 tests) — wraps
  `StreamableHTTPClientTransport`. (D) `client-sse.ts` (6 tests) — wraps
  deprecated `SSEClientTransport`; **SDK limitation**: SSE `onclose`
  does not fire from server-side stream drops, test monkey-patches the
  transport to force the signal. (E) `namespacing.ts` (14 tests) —
  extracted + stricter `[a-z0-9-]+` server names. Fixtures: `http-echo`
  and `oauth-provider`. Registry dispatch extended; `mcp-list.ts` smoke
  passes. `docs/mcp.md` authored. Typecheck ✅, biome ✅, vitest 652/655
  + 3 skipped ✅ (+66 net new). Next: 07.03 Playwright MCP smoke.
- Phase 07 Prompt 03 (Playwright MCP via CDP:9333) landed as
  **config-only** — zero code under `engine/src/mcp/`. `package.json`
  pins `@playwright/mcp@0.0.41` exact.
  `scripts/playwright-test-chrome.sh` spawns headless Chrome on
  `JELLYCLAW_TEST_CHROME_PORT` (default 9333) with a tmp user-data-dir;
  whole-port-token regex refuses 9222 (exit 64).
  `test/integration/playwright-mcp.test.ts` (5 tests): config-9222
  refusal; 21 namespaced tools registered; navigate + screenshot PNG
  end-to-end under `$TMPDIR/jellyclaw-test-artifacts/`; datadir
  cleanup; TCP-probe-9222 never-speaks guard.
  **Deviation**: suite gated behind `JELLYCLAW_PW_MCP_TEST=1` to avoid
  starving opencode-server e2e's 20s startup timeout (mirrors
  `.bench.ts`/`BENCH=1`). Default `bun run test` → 652/660 + 8 skipped;
  `JELLYCLAW_PW_MCP_TEST=1 bun run test` → 657/660 + 3 skipped.
  `docs/playwright-setup.md` authored + `docs/mcp.md` section added.
  **Phase 07 ✅ COMPLETE.** Core-engine group now 1/5. Next: Phase 08
  permission engine + hooks. Fresh Claude session.
