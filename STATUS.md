# Jellyclaw — Status

> Living doc. Update at the start and end of every working day.
> If this file is stale, don't trust it.

**Last updated:** 2026-04-15 (Phase 05 prompt 01 landed — skills discovery + loader)
**Current phase:** Phase 05 — Skills system (in progress)
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
| Unit tests passing | 449 (+2 benches under BENCH=1) |
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
- [ ] Phase 05 — Skills system
- [ ] Phase 06 — Subagents + hook patch
- [ ] Phase 07 — MCP client integration
- [ ] Phase 08 — Permission engine + hooks
- [ ] Phase 09 — Session persistence + resume
- [ ] Phase 10 — CLI + HTTP server + library
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

### 2026-04-15
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
