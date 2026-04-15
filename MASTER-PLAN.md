# Jellyclaw Engine — Master Plan

> The load-bearing document. If you read one file in this repo, read this one.
> Everything else is referenced from here.

**Status:** Phase 0, Day 1.
**Owner:** George Trushevskiy.
**Last updated:** 2026-04-14.

---

## 1. Project overview

**Jellyclaw** is an open-source Claude Code replacement. It is a thin wrapper
around [OpenCode](https://github.com/sst/opencode) `>=1.4.4` that matches
Anthropic Claude Code's tool surface, skills system, subagent contract,
session server, hook protocol and `stream-json` output format — byte for byte,
where possible.

**Why this exists.** Claurst (Rust reimplementation of the Claude Code
harness) is a single-maintainer fork that George has been feeding. It works.
It does not have a community. It does not have MCP client support battle-
tested against real providers. It does not survive George being hit by a bus.
OpenCode does. The gap is that OpenCode's UX is not Claude Code's UX —
different event names, different tool schemas, different skill semantics,
different provider defaults. Jellyclaw closes that gap with a pin + a patch +
a translation layer.

**Separation from jelly-claw.** The video-calling macOS app at
`/Users/gtrush/Downloads/jelly-claw/` (Tauri + WebRTC) is a separate product.
Jellyclaw *powers* the AI features inside jelly-claw — starting in Phase 17 —
but the two repos are independent. Jellyclaw knows nothing about WebRTC,
cameras, call state. Jelly-claw embeds jellyclaw-as-library the same way a
normal app embeds SQLite.

The naming is deliberate. Users will never see "jellyclaw." They will see
"jelly-claw" (the call app) or "Genie" (the agent runtime). Jellyclaw is
infrastructure.

---

## 2. Current status

Day 1 of Phase 0. Five parallel agents are producing the initial docs and
scaffold right now. At the time of this writing:

**Scaffolded:**
- `engine/SPEC.md` — full engine specification
- `engine/CVE-MITIGATION.md` — CVE-22812 and related write-ups
- `engine/SECURITY.md` — threat model + mitigations
- `phases/README.md` — 20-phase dependency graph
- `phases/PHASE-00-scaffolding.md` through `PHASE-03-event-stream.md`
- This file + `STATUS.md` + `ROADMAP.md`

**Not yet written (expected in-flight):**
- `engine/PROVIDER-STRATEGY.md`
- `phases/PHASE-04-*` through `PHASE-19-*`
- `integration/JELLY-CLAW-APP-INTEGRATION.md`, `integration/AUDIT.md`,
  `integration/BRIDGE-DESIGN.md`, `integration/GENIE-INTEGRATION.md`
- `test/TESTING.md`, `scripts/`, canonical wishes JSON
- `patches/*.patch`
- `README.md`, `package.json`, `tsconfig.json`, `docs/ARCHITECTURE.md`, stub
  source under `engine/src/`

If a link below resolves 404, the producing agent has not landed yet.
Check again tomorrow — or unblock by running the relevant phase.

**Code shipped:** zero lines.
**Tests passing:** zero.
**API spend to date:** $0.

---

## 3. Dream outcome (October 2026)

Six months from today:

- **Genie runs 100% on jellyclaw.** The `GENIE_ENGINE=jellyclaw` flag is
  deleted; jellyclaw is the only dispatcher path. Claurst is archived.
- **jellyclaw-desktop is on `brew install jellyclaw`.** Signed, notarized,
  auto-updating Tauri 2 app. Users run agents without touching Node.
- **jelly-claw ships AI.** A voice trigger inside a live video call
  (`"Jelly, schedule a follow-up"`) fires a jellyclaw agent that reads the
  transcript, drafts the calendar event, shows the overlay. The demo that
  wins the next Tauri/WebRTC hackathon.
- **Open-source community.** GitHub repo public. Discord of ~200 builders.
  Third-party skills registry with ~50 skills. One external contributor has
  landed a non-trivial PR. Someone has written a blog post that George did
  not ghostwrite.
- **Providers plural.** Anthropic direct + OpenRouter + a self-hosted
  Ollama path, all tested nightly, all green.

This is the north star. Every phase gate asks: "does this take us toward
that picture or away from it?"

---

## 4. Phase summary table

All 20 phases. Duration is engineering days (solo). Acceptance gate is the
one test that must pass before the phase is considered closed.

| # | Name | Duration | Depends | Acceptance gate | Doc |
|---|------|----------|---------|-----------------|-----|
| 00 | Repo scaffolding | 0.5 d | — | `pnpm install && pnpm test` runs green with placeholder test | [PHASE-00](phases/PHASE-00-scaffolding.md) |
| 01 | OpenCode pinning + patching | 1 d | 00 | `pnpm opencode --version` prints `1.4.4+jellyclaw`; patches applied idempotently | [PHASE-01](phases/PHASE-01-opencode-pinning.md) |
| 02 | Config + provider layer | 2 d | 01 | `jellyclaw.config.ts` validates; Anthropic + OpenRouter providers resolve | [PHASE-02](phases/PHASE-02-config-providers.md) |
| 03 | Event stream adapter | 2 d | 01, 02 | Golden-file diff of stream-json output matches Claude Code byte-for-byte on 3 prompts | [PHASE-03](phases/PHASE-03-event-stream.md) |
| 04 | Tool parity | 3 d | 01, 02 | All 14 Claude Code built-in tools executable with identical JSON schema | PHASE-04 (pending) |
| 05 | Skills system | 1.5 d | 01 | `.claude/skills/*.md` loaded; Genie's existing skills run unmodified | PHASE-05 (pending) |
| 06 | Subagent system + hook patch | 2 d | 01, 04, 05 | OpenCode issue #5894 patch applied; nested subagents inherit hooks | PHASE-06 (pending) |
| 07 | MCP client integration | 1.5 d | 01, 02 | `playwright-mcp@0.0.41` connects to CDP `127.0.0.1:9222` via config | PHASE-07 (pending) |
| 08 | Permission engine + hooks | 2 d | 02, 04, 06 | PreToolUse/PostToolUse hook contract identical to Claude Code | PHASE-08 (pending) |
| 09 | Session persistence + resume | 2 d | 03 | `jellyclaw --resume <id>` replays last session exactly | PHASE-09 (pending) |
| 10 | CLI + HTTP server + library | 2 d | 02, 03, 08, 09 | Three entry points stable: `bin/jellyclaw`, `localhost:PORT`, `import { Engine }` | PHASE-10 (pending) |
| 11 | Testing harness | 3 d | 02-10 | 5 golden-prompt regression tests + 20 unit tests pass in CI | PHASE-11 (pending) |
| 12 | Genie integration behind flag | 3 d | 10, 11 | `GENIE_ENGINE=jellyclaw genie wish "…"` succeeds on 3 real wishes | PHASE-12 (pending) |
| 13 | Make jellyclaw default in Genie | 2 d + 72 h burn-in | 12 | 72-hour burn-in: zero regressions vs Claurst on production wishes | PHASE-13 (pending) |
| 14 | Observability + tracing | 2 d | 10 | OTLP traces export; per-tool latency visible in Grafana | PHASE-14 (pending) |
| 15 | Desktop app MVP (Tauri 2) | 5 d | 10 | Launches, runs one wish, shows streaming output | PHASE-15 (pending) |
| 16 | Desktop app polish | 5 d | 15 | Signed `.dmg`, auto-update from GitHub releases | PHASE-16 (pending) |
| 17 | Integration into jelly-claw | 5 d | 13, 14 | Voice-trigger in live call fires agent, returns overlay in <3 s | PHASE-17 (pending) |
| 18 | Open-source release | 2 d | 11, 14, 16, 17 | npm + brew + GitHub public; landing page live | PHASE-18 (pending) |
| 19 | Post-launch stabilization | ongoing | 18 | n/a — triage queue SLA ≤72 h | PHASE-19 (pending) |

**Total:** ~46 engineering days + 72 h burn-in. Plan ~9-10 calendar weeks
solo, ~5-6 with a second engineer pair.

Read [phases/README.md](phases/README.md) for the dependency graph and the
milestone gates (M1–M5).

---

## 5. Critical fixes in this iteration

> These are the five decisions that distinguish jellyclaw from "just fork
> OpenCode and ship it." If any of them are quietly reverted, the engine is
> no longer safe to run Genie on.

1. **Anthropic direct as primary provider.** OpenRouter's prompt-cache
   integration has documented silent misses and returns incorrect
   `cache_read_input_tokens`. Caching ROI is the #1 economic lever on
   Anthropic. Default provider in `jellyclaw.config.ts` is Anthropic
   direct. OpenRouter is opt-in, and jellyclaw logs a WARN on startup when
   it is selected. See `engine/PROVIDER-STRATEGY.md` (pending) and
   [engine/SPEC.md](engine/SPEC.md).
2. **OpenCode pinned `>=1.4.4`.** CVE-22812 (command injection in the
   legacy shell tool wrapper) is fixed at 1.4.4. Anything earlier is not
   safe to use. Lockfile and `package.json` `engines` must both enforce.
   See [engine/CVE-MITIGATION.md](engine/CVE-MITIGATION.md).
3. **Playwright MCP pinned `0.0.41`.** Later versions changed the CDP
   handshake in a way that breaks Genie's attach-to-running-Chrome pattern.
   Genie wires `playwright-mcp@0.0.41` pointing at CDP
   `127.0.0.1:9222` through `jellyclaw.json`. Jellyclaw itself knows
   nothing about Chrome.
4. **Subagent hook patch for OpenCode #5894.** Nested subagents do not
   inherit the parent's hook chain in stock OpenCode. This breaks
   Genie's permission model. We carry a patch until upstream lands a fix.
   See `patches/` (pending).
5. **Telegram bot token migration: bash-curl → hook.** Genie's Telegram
   integration currently shells out to `curl` with the token on the
   command line (visible in `ps` and shell history). Jellyclaw moves this
   to `PreToolUse` / `PostToolUse` hooks that read from keychain. No
   token in argv, no token in logs.

---

## 6. Document index

Every file in the repo, what it is for, and when you would read it.

| Path | Purpose | Read when |
|------|---------|-----------|
| `MASTER-PLAN.md` | This file | Start of every session |
| `STATUS.md` | Daily living status | Start of every day |
| `ROADMAP.md` | Post-v1.0 vision | Quarterly, or when someone asks "what's next" |
| `README.md` (pending) | GitHub-facing intro | When linking to the repo |
| `package.json` (pending) | Workspaces + scripts | When adding a dep |
| `tsconfig.json` (pending) | TS config | When setting up IDE |
| `engine/SPEC.md` | Engine specification | Before writing any engine code |
| `engine/SECURITY.md` | Threat model | Before any PR touching IO |
| `engine/CVE-MITIGATION.md` | CVE-22812 writeup | When bumping OpenCode |
| `engine/PROVIDER-STRATEGY.md` (pending) | Anthropic-first rationale | When adding a provider |
| `phases/README.md` | Phase graph + milestones | Weekly planning |
| `phases/PHASE-NN-*.md` | Per-phase runbook | When executing that phase |
| `integration/JELLY-CLAW-APP-INTEGRATION.md` (pending) | How jelly-claw embeds | Phase 17 |
| `integration/AUDIT.md` (pending) | Audit of existing jelly-claw code | Before Phase 17 |
| `integration/BRIDGE-DESIGN.md` (pending) | WebRTC ↔ agent bridge | Phase 17 |
| `integration/GENIE-INTEGRATION.md` (pending) | Flipping Genie to jellyclaw | Phase 12 |
| `test/TESTING.md` (pending) | Test strategy | Phase 11 |
| `test/wishes.canonical.json` (pending) | Golden prompts | Phases 3, 11, 13 |
| `patches/*.patch` (pending) | OpenCode patches | Phase 01 |
| `scripts/*` (pending) | Dev scripts | When something is automated |
| `docs/ARCHITECTURE.md` (pending) | Architecture diagram | Onboarding |
| `skills/` (pending) | Bundled skills | Phase 5 |
| `agents/` (pending) | Bundled subagents | Phase 6 |
| `desktop/` (pending) | Tauri app | Phases 15-16 |

---

## 7. Week-by-week calendar

Assumes solo execution, 5 focused engineering days per week, starting
**Monday 2026-04-20**.

| Week | Dates | Phases | Milestone |
|------|-------|--------|-----------|
| 1 | Apr 20 – Apr 26 | 00, 01, 02 | Repo green, OpenCode pinned, providers resolve |
| 2 | Apr 27 – May 3 | 03, 04 (start) | Stream-json byte-parity on 3 golden prompts |
| 3 | May 4 – May 10 | 04 (finish), 05, 06 | Tools + skills + subagents at parity |
| 4 | May 11 – May 17 | 07, 08, 09 | MCP, permissions, resume all working |
| 5 | May 18 – May 24 | 10, 11 | **M1: Engine works.** `jellyclaw run` == `claurst run` on 5 prompts |
| 6 | May 25 – May 31 | 12, 13 (start burn-in) | Genie behind flag, burn-in starts |
| 7 | Jun 1 – Jun 7 | 13 (finish), 14 | **M2: Genie on jellyclaw.** Observability live |
| 8 | Jun 8 – Jun 14 | 15 | Desktop MVP launches |
| 9 | Jun 15 – Jun 21 | 16 | **M3: Desktop ships.** Signed dmg |
| 10 | Jun 22 – Jun 28 | 17 | **M4: jelly-claw AI.** Voice trigger in call |
| 11 | Jun 29 – Jul 5 | 18 | **M5: Public.** npm + brew + GitHub |
| 12+ | ongoing | 19 | Triage queue |

Slip budget: **two weeks.** If by end of week 13 M5 has not happened, cut
Phase 17 from v1.0 and ship jelly-claw integration as v1.1.

---

## 8. Success metrics

Per-phase "done" definitions. If the metric is not measured, the phase is
not done.

- **Phase 00–02.** `pnpm install && pnpm build && pnpm test` exits 0 in CI.
- **Phase 03.** `diff <(jellyclaw run X --json) <(claude run X --json)` is
  empty on all 3 golden prompts. (Ignoring `request_id` and timestamps.)
- **Phase 04.** All 14 built-in tools have a passing schema conformance
  test against the Claude Code JSON schema.
- **Phase 05–07.** Genie's existing `.claude/skills/` and
  `.claude/agents/` directories load without modification. One real Genie
  wish that uses Playwright MCP completes end-to-end.
- **Phase 08–09.** 10 permission scenarios (allow/deny/ask) match Claude
  Code's behavior. Resume across process kill reproduces final state.
- **Phase 10–11.** 5 golden-prompt regression suite green in CI. Cold-start
  latency `jellyclaw run` ≤ 1.5× `claude run`.
- **Phase 12.** 3 real Genie wishes (one trivial, one browser, one
  multi-tool) run green behind the flag.
- **Phase 13.** 72 hours of production Genie traffic on jellyclaw with
  zero P0 and ≤2 P2s that were false alarms. Rollback drill tested once.
- **Phase 14.** P50/P95 tool latency visible per-session. One real
  incident diagnosed from traces alone.
- **Phase 15–16.** Desktop app runs a wish on a clean M1 Mac with nothing
  but the `.dmg` installed. Auto-update from vN to vN+1 works.
- **Phase 17.** "Jelly, …" voice trigger in a live 2-party WebRTC call
  returns the first streamed token ≤ 3 s, overlay renders ≤ 1 s later.
- **Phase 18.** `brew install jellyclaw` and `npm i jellyclaw` both
  succeed on a fresh machine. Docs site deploys. One external human who
  is not George files an issue within 7 days of launch.
- **Phase 19.** Triage SLA: every issue gets a human reply within 72 h.

---

## 9. Kill-switch decision tree

When to abandon jellyclaw and fall back.

```
Start Phase 03.
├─ Can we achieve byte-parity on stream-json within 5 engineering days?
│  ├─ YES → continue.
│  └─ NO → stop. The translation layer is deeper than we thought.
│          Fall back to Claurst. Re-evaluate in 90 days.
│
Start Phase 13 (burn-in).
├─ Zero P0, ≤ 2 false-alarm P2s in 72 h?
│  ├─ YES → cut over. Continue to Phase 14.
│  └─ NO → rollback to Claurst via GENIE_ENGINE=claurst.
│          Root-cause. Either fix within 5 days and re-burn, or
│          abandon jellyclaw as Genie's engine.
│
Any phase.
├─ Is upstream OpenCode diverging in ways our patches cannot track?
│  ├─ Cumulative patch size > 2,000 LOC → we have effectively forked.
│  │   Decide: fork formally, or evaluate Goose / OpenHands as base.
│  └─ Patch size ≤ 2,000 LOC → keep pinning + patching.
│
At any time.
├─ Does Anthropic ship an official "Claude Code as library" SDK?
│  ├─ YES → evaluate. Jellyclaw may become a thin shim on that SDK.
│  └─ NO → continue.
```

**Fallback engines considered, ranked.** Claurst (our current prod) →
Goose (Block's agent harness, good skills story) → OpenHands (strong tool
layer, weaker provider abstraction) → build-our-own (last resort; do not).

---

## 10. Open questions

Unblocking these changes the plan. George owns them.

1. **Genie's current hook taxonomy.** Is there any hook Genie uses that
   Claude Code does *not* expose? If yes, Phase 08 expands.
2. **Anthropic API budget.** Monthly ceiling for burn-in + golden tests?
   Affects Phase 11 (how many fixtures we record live) and Phase 13
   (duration of burn-in).
3. **jelly-claw IPC surface.** Does jelly-claw run jellyclaw in-process
   (Tauri sidecar) or as a child process over stdio? Affects Phase 17
   bridge design.
4. **License.** MIT or Apache-2.0? Affects Phase 18. Recommend Apache-2.0
   for patent grant given MCP ecosystem.
5. **Desktop distribution.** Apple Developer ID ready? Notarization
   pipeline ready? Blocks Phase 16.
6. **Telemetry.** Opt-in or opt-out for the OSS build? Affects Phase 14
   and Phase 18.

---

## 11. Next steps

First three concrete actions:

1. **Read `engine/SPEC.md` end to end.** If anything surprises you, stop
   and fix the spec before writing code.
2. **Execute Phase 00.** Thirty minutes. Scaffold + placeholder test
   green.
3. **Execute Phase 01.** One day. Pin OpenCode, apply `patches/*`, verify
   `pnpm opencode --version` prints `1.4.4+jellyclaw`.

After those, the critical path is linear through Phase 13 (the milestone
that actually matters for George).

---

## 12. Glossary

- **jellyclaw** — this engine. Open-source Claude Code replacement.
- **jelly-claw** — separate macOS video-calling app. Embeds jellyclaw in
  Phase 17.
- **Genie** — George's agent runtime. Currently runs on Claurst. Moving
  to jellyclaw.
- **Claurst** — Rust reimplementation of the Claude Code harness George
  has been maintaining. The engine jellyclaw replaces.
- **OpenCode** — upstream open-source agent harness (sst/opencode). The
  base jellyclaw thin-wraps.
- **wish** — Genie's term for a user-issued task. One prompt → one
  transcript → one result.
- **stream-json** — Claude Code's line-delimited JSON event stream over
  stdout. The format jellyclaw emits byte-compatibly.
- **skill** — Markdown-defined reusable behavior loaded from
  `.claude/skills/`.
- **subagent** — child agent invoked by the parent via the Task tool,
  with its own hook chain and permissions.
- **MCP** — Model Context Protocol. Transport for external tools.
- **CDP** — Chrome DevTools Protocol. How Playwright MCP attaches to a
  running Chrome.
- **CVE-22812** — command injection in OpenCode's legacy shell tool
  wrapper, fixed at 1.4.4. See `engine/CVE-MITIGATION.md`.
- **golden prompt** — a frozen input used for byte-diff regression
  testing of the event stream.
- **burn-in** — period where new engine runs production traffic behind a
  flag; no regressions permitted.
- **provider** — model backend. Anthropic direct, OpenRouter,
  Ollama, etc.
- **M1–M5** — milestones defined in `phases/README.md`.

---

## What George does tomorrow

Prioritized checklist. Start at #1. Do not skip ahead.

1. `cd /Users/gtrush/Downloads/jellyclaw-engine && ls`. Confirm the five
   parallel agents have landed the files listed in §6. Note any that are
   missing.
2. Read `MASTER-PLAN.md` (this file). Read `STATUS.md`. Read
   `phases/README.md`. ~15 min.
3. Read `engine/SPEC.md` end to end. Flag any line you do not agree with.
   Edit the spec, do not carry disagreement into code. ~30 min.
4. Read `engine/CVE-MITIGATION.md` and `engine/SECURITY.md`. Confirm the
   five critical fixes in §5 of this file are each referenced in those
   docs. ~15 min.
5. Open `phases/PHASE-00-scaffolding.md`. Execute it top to bottom. Stop
   at the acceptance gate: `pnpm install && pnpm test` green.
6. Commit. Message: `phase-00: scaffold`. Push to a local branch. Do not
   create a GitHub remote yet.
7. Answer at least questions #1, #2, #4 from §10 (Genie hooks, API
   budget, license). Append answers to the bottom of `STATUS.md`.
8. Open `phases/PHASE-01-opencode-pinning.md`. Execute it. Apply every
   patch in `patches/`. Acceptance gate: `pnpm opencode --version` prints
   `1.4.4+jellyclaw`.
9. Open `phases/PHASE-02-config-providers.md`. Execute. Acceptance gate:
   a config file validates and both providers resolve credentials.
10. Write and run the **first real test**: a unit test that loads
    `jellyclaw.config.ts` and asserts the Anthropic provider is the
    default. Green = jellyclaw has its first green test. Update
    `STATUS.md`. Stop. Go outside.
