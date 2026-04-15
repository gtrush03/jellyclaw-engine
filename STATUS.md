# Jellyclaw — Status

> Living doc. Update at the start and end of every working day.
> If this file is stale, don't trust it.

**Last updated:** 2026-04-15 (Phase 02 research ✅ + Anthropic provider ✅; OpenRouter pending)
**Current phase:** Phase 02 — Config + provider layer (Prompts 01+02 ✅, Prompt 03 ⏳)
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
| Unit tests passing | 93 |
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
- [ ] Phase 02 — Config + provider layer
- [ ] Phase 03 — Event stream adapter
- [ ] Phase 04 — Tool parity
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
- Next action: Phase 02 Prompt 03 — OpenRouter provider + router/fallback + docs.
  Fresh Claude session.
