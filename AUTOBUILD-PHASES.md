# Jellyclaw Autobuild — Phase Plan (LOCKED 2026-04-17)

The jellyclaw autobuild system is a three-layer rig that ships phase work unattended
while preserving human review at every boundary that matters. Prompts (T0–T4 tiered Markdown
specs with frontmatter) are the unit of work; the dispatcher spawns short-lived Claude Code
workers (free under the Max subscription) on per-session git branches; a budgeted Haiku
self-check plus a sampled Sonnet tester guard the exit gate; COMPLETION-LOG.md stays the
canonical source of truth for what is actually DONE. This document is the **locked**
authoritative build plan. Every decision below is final for the current cycle. If a downstream
milestone reveals a prior decision was wrong, patch this file — never silently diverge.

## System topology

```
                        +---------------------------+
                        |   Humans / Dashboard UI   |
                        |     (read-only view)      |
                        +-------------+-------------+
                                      | drop sentinels
                                      v
                        +---------------------------+
                        |   .orchestrator/inbox/    |   <-- only arbitrary UIs
                        |   (sentinel file drop)    |       may write here
                        +-------------+-------------+
                                      | fs events
                                      v
+-----------------+     reads     +---------------------------+
|  prompts/*.md   | <-----------+ |     orchestrator daemon   |
|  (T0..T4 tier)  |             | |  (RW queue.json,          |
+-----------------+             | |   context.json,           |
                                | |   paused/halted sentinels)|
                                | +------------+--------------+
                                |              |
                                |              | reads queue.json
                                |              v
+--------------------------+    |   +---------------------------+
| .autobuild/queue.json    |----+   |     rig dispatcher        |
| .autobuild/context.json  |<-------+  (RW state.json,          |
| .autobuild/state.json    |<-------+   spawns workers,         |
| .autobuild/sessions/     |<-------+   enforces tier order,    |
+--------------------------+        |   budget, concurrency)    |
                                    +------------+--------------+
                                                 | spawn per-session
                                                 v
                                    +---------------------------+
                                    |   Claude Code worker(s)   |
                                    |   (session branch,        |
                                    |    scope-warden hooks,    |
                                    |    writes artifacts +     |
                                    |    transcript.jsonl)      |
                                    +------------+--------------+
                                                 | on exit gate:
                                                 v
                                    +---------------------------+
                                    |  Haiku self-check (~$0.05)|
                                    |  Sonnet tester (sampled,  |
                                    |   $5 self / $10 hard cap) |
                                    +------------+--------------+
                                                 | pass/fail
                                                 v
                                    +---------------------------+
                                    |  COMPLETION-LOG.md        |
                                    |  + git commit on branch   |
                                    |  (NEVER auto-merged)      |
                                    +---------------------------+
```

## Three layers

| Layer            | Role                                                                 | Writes to                                                                | Reads from                                            |
| ---------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------- |
| **Orchestrator** | Arbitrate UI/human actions; manage queue; hold pause/halt sentinels. | `.autobuild/queue.json`, `.autobuild/context.json`, `.orchestrator/*`    | `.orchestrator/inbox/`, `prompts/`, `.autobuild/state.json` |
| **Dispatcher (rig)** | Spawn sessions; enforce tier order, budget, concurrency; collect results; log completion. | `.autobuild/state.json`, `.autobuild/sessions/`, `COMPLETION-LOG.md`, `logs/workers/` | `.autobuild/queue.json`, `.autobuild/context.json`, `prompts/`, `.orchestrator/paused`, `.orchestrator/halted` |
| **Dashboard**    | Surface live state; render tier strip, session table, cost meter.    | **Nothing in rig state.** Writes only to `.orchestrator/inbox/`.         | `.autobuild/state.json`, `.autobuild/sessions/*/transcript.jsonl`, `COMPLETION-LOG.md`, `prompts/` |

Each arrow above is unidirectional. If a new feature wants to cross a boundary, the right
answer is almost always "add a sentinel action," not "add a writer."

## Source-of-truth rules

1. **`COMPLETION-LOG.md` is canonical DONE.** The autobuild rig writes to it with the exact
   same format a human would — same template, same date line, same phase ref, same signed-by
   block. A grep for a slug in this file is the authoritative answer to "did we do that?"
2. **`.autobuild/state.json` is live telemetry (dispatcher-only write).** Nothing else
   on the machine may write this file. Dashboard reads it. Orchestrator reads it. Humans may
   read it. Writers outside the dispatcher are a bug, period.
3. **`.orchestrator/` is orchestrator-only.** Only the orchestrator daemon writes here
   (with the narrow exception of the `inbox/` sentinel drop-zone, which is append-only from
   the edge).
4. **The dashboard NEVER writes rig state.** Not `state.json`, not `queue.json`, not
   `context.json`, not `sessions/*`. If a dashboard feature needs to mutate, it drops a
   sentinel in `.orchestrator/inbox/`.
5. **Actions from UI → sentinel files in `.orchestrator/inbox/`.** One sentinel per
   action, filename = `<iso-ts>-<action>-<target>.json`. The orchestrator validates
   (Zod), applies atomically, and moves the sentinel to `inbox/.processed/` or
   `inbox/.rejected/`. This is an append-only audit log.
6. **All writes atomic (tmp → rename).** Every writer in the system MUST write to
   `<target>.tmp.<pid>.<uuid>`, `fsync(2)`, then `rename(2)` over the live path. No
   exceptions. `fs.writeFile()` directly onto a live state file is a bug.
7. **Git branches per session, NEVER auto-merged.** Every session runs on
   `autobuild/<session_id>` cut from `main` at dispatch time. The rig commits inside the
   branch. It never `git merge`, never `git push`, never opens a PR. George cuts the merge.

## Tier ordering

**STRICT T0 → T4. No T<N+1> dispatch until every T<N> is complete or explicitly skipped.**

- **T0 — Blockers.** Shim bugs, broken CLI flags, anything that prevents the rig from
  running at all. Five T0 prompts are queued at lock time.
- **T1 — Critical path.** Security, permissions, hooks, core event plumbing.
- **T2 — Feature completion.** Finishing half-landed phase work.
- **T3 — Hardening.** Error paths, retry logic, observability.
- **T4 — Polish.** Docs, perf, dev-ergonomics.

The dispatcher computes `max_ready_tier` = the lowest N such that **every** prompt at tier
`< N` is either in `completed` or explicitly in `skipped`. It will refuse to dispatch a
prompt at tier `> max_ready_tier` even if the queue lists it first. An orchestrator
`skip` action moves the slug to `completed` with `status: "skipped"` — this is the only
way to advance past a tier without finishing every prompt in it.

## Cost model

- **Workers: $0** (Claude Code under the Max subscription — no per-token billing).
- **Tester per-session budget: $10 hard cap.** The Sonnet tester is allowed up to $10
  of token spend on any single session. If it would exceed this, the run is
  escalated and the session is halted.
- **Self-check gate: $5 soft cap.** The Haiku self-check runs first (~$0.03–$0.08
  typical). If self-check is confident (pass/fail decision with high confidence), the
  Sonnet tester is skipped. If self-check is uncertain, Sonnet runs up to $5; further
  spend requires the $10 hard-cap carve-out above.
- **Daily testing total: $25 hard halt.** Summed self-check + tester spend across
  all sessions in a single UTC day. When `state.daily_budget_usd.spent >= cap`, the
  dispatcher sets `halted = true` and drains. This resets at UTC midnight.

### Self-check gate spec

Haiku decides whether to escalate to the Sonnet tester. The exact prompt is held in
`engine/src/rig/self-check.ts` (M3). Haiku MUST return JSON matching:

```json
{
  "decision":   "pass" | "fail" | "escalate",
  "confidence": 0.0..1.0,
  "reason":     "<1-3 sentences, what tipped the scale>",
  "evidence":   ["<file:line>", "<file:line>", ...],
  "est_cost":   <number, USD, 0 if pass>
}
```

Rules the dispatcher enforces on Haiku's return:

- `decision: "pass"` + `confidence >= 0.85` → close session as PASS; append to
  COMPLETION-LOG; no Sonnet call.
- `decision: "fail"` + `confidence >= 0.85` → close session as FAIL; escalate.
- `decision: "escalate"` OR `confidence < 0.85` → call Sonnet tester with the same
  transcript, patch, and evidence list. Tester inherits the $5 soft / $10 hard cap.
- If Haiku returns malformed JSON, the session is escalated unconditionally.

## Retry taxonomy

### Retryable (dispatcher may re-dispatch automatically, up to 2 times)

| Class                     | Signal                                                       | Action                                           |
| ------------------------- | ------------------------------------------------------------ | ------------------------------------------------ |
| `worker.spawn_failed`     | Non-zero exit before session boot; no transcript emitted.    | Re-spawn with exponential backoff (2s → 8s → 30s). |
| `worker.heartbeat_lost`   | No stream event for > 120s while job active.                 | Kill PID, re-dispatch from fresh branch.         |
| `net.transient`           | 429/502/503/504 from provider; connection reset.             | Backoff + retry in-place (no fresh branch).      |
| `tester.cost_soft_cap`    | Tester hit $5 self-cap mid-run, no conclusion yet.           | Restart tester with trimmed context.             |
| `gitwarden.dirty_index`   | Session left uncommitted changes outside scope globs.        | Reset branch, re-dispatch.                       |
| `self_check.malformed`    | Haiku returned non-JSON.                                     | Retry Haiku once with stricter re-prompt.        |

### Non-retryable (dispatcher escalates immediately)

| Class                        | Signal                                                                       | Action                                            |
| ---------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------- |
| `budget.daily_halt`          | `spent >= cap`.                                                              | Halt rig; add slug to `escalated`.                |
| `budget.session_hard_cap`    | Tester would exceed $10 on this session.                                     | Kill session; escalate.                           |
| `scope.violation`            | Worker tried to edit a path not in frontmatter `scope_globs`.                | Abort session; escalate; mark slug as quarantined. |
| `tier.out_of_order`          | Queue advanced to T<N+1> while T<N> has open prompts (invariant violation).  | Halt rig; require human.                          |
| `sensitive_write`            | Any write to `engine/src/{security,permissions,hooks}/**`, `package.json`, `bun.lock`, `CLAUDE.md`, `SOUL.md`, `phases/*.md`. | Session runs in **review-only** mode — it produces a patch but does not commit. Escalate for human apply. |
| `allow_binary_true`          | Prompt frontmatter requested binary writes.                                  | Always escalate; no auto-apply.                   |
| `self_check.hard_fail`       | Haiku decides fail with confidence ≥ 0.85 AND tester confirms.               | Close FAIL; escalate.                             |
| `prompt.malformed`           | Frontmatter missing required fields or fails Zod schema.                     | Escalate; never dispatch.                         |
| `tier.explicit_hold`         | Prompt has `hold: true` in frontmatter.                                      | Skip; never dispatch until a human removes hold.  |

## Prompt frontmatter schema

Every prompt in `prompts/` starts with a YAML frontmatter block validated by Zod at
dispatch time. Required fields:

```yaml
---
slug:          string     # e.g. "T0-01-fix-serve-shim"; unique; filename must match
tier:          0 | 1 | 2 | 3 | 4
title:         string
depends_on:    string[]   # slugs this one requires (completed) before dispatch
scope_globs:   string[]   # globs the session is allowed to touch (enforced by warden)
allow_binary:  boolean    # default false; true always triggers review-only
hold:          boolean    # default false; true skips dispatch until human clears
est_minutes:   number     # wallclock estimate; informs session timer
tester_focus:  string[]   # hints for Sonnet tester (e.g. "smoke run; cli exit code")
---
```

Invariants:

- `slug` must equal the filename without `.md`.
- `scope_globs` must be non-empty. A prompt that can't declare scope can't dispatch.
- `depends_on` must reference known slugs; unknown refs are a dispatch-blocking error.
- `tier` must be an integer 0..4; anything else rejects.
- If `scope_globs` intersects the always-human-review list, the prompt runs in
  review-only mode regardless of `allow_binary`.

The frontmatter validator lives at `engine/src/rig/frontmatter.ts` (shipped in M2).

## Dispatcher loop

Pseudocode for the dispatcher tick. This is the contract, not the implementation.

```
every 2s:
  reload(state, queue, context)             # atomic reads

  if state.halted:                          return
  if exists(.orchestrator/halted):          state.halted = true; flush; return
  if exists(.orchestrator/paused):
      flush_runs_only()                     # let in-flight finish
      return

  rollover_day_if_utc_midnight(state)
  if state.daily_budget_usd.spent >= cap:   state.halted = true; flush; return

  n_active = count(state.runs where status in {dispatching, running, self_checking, testing, committing})
  if n_active >= state.concurrency:         flush_heartbeat(); return

  next = tier_gated_pop(queue, state.completed)
  if next is None:                          flush_heartbeat(); return

  if frontmatter(next).hold:                mark_skipped(next); continue
  if sensitive_scope(frontmatter(next)):    dispatch(next, mode=review_only)
  else:                                     dispatch(next, mode=apply)

  flush_heartbeat()
```

"Atomic reads" above means `readFile` the whole file (no partial reads, no offset seeks)
so the tmp→rename guarantee on the writer side is sufficient for consistency. "Flush"
means atomic-write `state.json` back.

## Session state machine

```
  queued
    │
    │ dispatcher picks from queue (tier-gated)
    v
  dispatching        [branch cut, prompt compiled, worker spawned]
    │
    v
  running            [worker emits stream events]
    │    │
    │    └─ heartbeat_lost → retrying → running
    │
    v
  self_checking      [Haiku runs on transcript + patch]
    │    │
    │    ├─ pass  (high conf)  ────────────────────────┐
    │    ├─ fail  (high conf)  ─────────────→ failed   │
    │    └─ escalate / low conf                        │
    v                                                   │
  testing            [Sonnet runs; bounded by caps]    │
    │    │                                              │
    │    ├─ pass  ─────────────────────────────────────┤
    │    ├─ fail  ─────────────────────────→ failed    │
    │    └─ cost_hard_cap ───────────→ escalated       │
    v                                                   │
  committing         [write COMPLETION-LOG entry,      │
    │                 git commit on branch]            │
    │                                                   │
    v                                                   │
  completed <────────────────────────────────────────────┘
    │
    │ 24h later
    v
  archived           [moved to .autobuild/archive/]

  (any state) ── retryable error → retrying (bounded 2×) → same state
  (any state) ── non-retryable   → escalated (terminal)
  (any state) ── external halt   → halted    (terminal until resume)
```

## Milestones — build order

| M    | Deliverable                                                                 | Days | Dep       |
| ---- | --------------------------------------------------------------------------- | ---- | --------- |
| M0   | Author 5 T0 prompts (shim fix, creds read, model id, CLI flags, gitignore). | 1    | —         |
| M1   | Dashboard structure DONE — tier strip placeholder, session table shell.     | 1    | —         |
| M2   | Frontmatter parser extension — tier field, scope_globs, hold, allow_binary. | 1    | M0        |
| M3   | Rig MVP — dispatcher, atomic-write helper, state.json, session spawn.       | 3    | M0, M2    |
| M4   | Dashboard reads `state.json` live (polling + fs-watch fallback).            | 2    | M3        |
| M5   | Haiku self-check integration; JSON decision schema; confidence gating.      | 2    | M3        |
| M6   | Sonnet tester integration; $5/$10 cost tracking; escalation path.           | 2    | M5        |
| M7   | Smoke suite — reproducible rig run on fixture prompts; CI green.            | 2    | M3, M5, M6 |
| M8   | Orchestrator daemon + `jc` CLI (`status`, `pause`, `halt`, `enqueue`).      | 2    | M3        |
| M9   | Scope-warden git hooks — pre-commit enforcement of frontmatter globs.       | 1    | M2        |
| M10  | COMPLETION-LOG writer with canonical template; dedupe by slug.              | 1    | M3        |
| M11  | Retry taxonomy implementation — classifier + bounded backoff.               | 2    | M3        |
| M12  | Session archival job — move > 24h `sessions/*` → `archive/`.                | 1    | M3        |
| M13  | End-to-end soak — rig runs 24h unattended on T1 backlog.                    | 2    | all above |
| M14  | Post-soak hardening; doc pass; unlock T2 dispatch.                          | 1    | M13       |

Total: ~24 working days end-to-end, single-track.

## Safety rails

| Cap / rail                                  | Value                               | Where enforced                 |
| ------------------------------------------- | ----------------------------------- | ------------------------------ |
| Concurrency (workers)                       | `state.concurrency` (default `1`)   | dispatcher                     |
| Per-session tester spend (hard)             | $10                                 | dispatcher budget tracker      |
| Per-session self-check spend (soft)         | $5                                  | dispatcher budget tracker      |
| Daily total spend                           | $25 → halt                          | dispatcher budget tracker      |
| Per-session wallclock (hard)                | 30 min                              | dispatcher timer               |
| Heartbeat silence                           | 120s → retry                        | dispatcher timer               |
| Retry count per class (retryable)           | 2                                   | dispatcher retry table         |
| Tier advance                                | strict; no out-of-tier dispatch     | dispatcher tier gate           |
| Auto-merge                                  | **never**                           | dispatcher (no merge code)     |
| Auto-push                                   | **never**                           | dispatcher (no push code)      |
| Auto-tag                                    | **never**                           | dispatcher (no tag code)       |
| Binary writes from prompts                  | blocked unless `allow_binary: true` | frontmatter validator          |
| Scope glob violations                       | abort + escalate                    | git-warden pre-commit hook     |
| State writes outside dispatcher             | blocked                             | atomic-write helper (owner check) |
| Queue writes outside orchestrator/humans    | blocked                             | orchestrator file-watcher       |

## Always-human-review

Any session whose scope includes any of the following is **review-only**: the worker produces
a patch, the rig does not commit, the session is escalated for a human to apply.

- `engine/src/security/**`
- `engine/src/permissions/**`
- `engine/src/hooks/**`
- `package.json`
- `bun.lock`
- `CLAUDE.md`
- `SOUL.md`
- `phases/*.md`
- Any prompt with `allow_binary: true` in frontmatter
- Any session that has ever been in `escalated` for this slug

The frontmatter validator warns if a prompt's `scope_globs` overlap these paths and `hold`
is not set; the orchestrator refuses to enqueue such prompts without explicit human sign-off.

## COMPLETION-LOG entry format

The rig writes COMPLETION-LOG entries identical to hand-written ones. The template,
held in `engine/src/rig/completion-log.ts` (M10):

```markdown
### <slug> — <title>

- **Date:** <YYYY-MM-DD HH:MM UTC>
- **Phase:** <phase ref from frontmatter, or "autobuild">
- **Tier:** T<tier>
- **Session:** <session_id>
- **Branch:** autobuild/<session_id>
- **Scope:** <comma-joined scope_globs>
- **Self-check:** <pass|fail|escalate> conf=<0.0..1.0>
- **Tester:** <pass|fail|skipped|escalate> spend=$<x.yz>
- **Signed-by:** rig-<rig_version> (and tester-<model>) [; human <name>]

<1-3 sentence summary of what landed. Matches the frontmatter title + actual commit
subject. No emoji. No marketing copy.>

<Optional: bullet list of files touched with one-line rationale each.>
```

Dedup rule: a slug MAY appear multiple times in the log (for retries, scope fixes,
etc.); the dispatcher tags each entry with its `session_id` so entries are unique.
`completed` in state is keyed by slug; `recent_commits` in context tracks the last
commit sha per slug.

## Observability & logging

- `logs/workers/<session_id>.log` — raw stdout+stderr of the Claude Code worker.
- `.autobuild/sessions/<session_id>/transcript.jsonl` — parsed stream events
  (one JSON object per line), suitable for dashboard tail-follow.
- `.autobuild/sessions/<session_id>/result.json` — final record:
  `{ status, self_check, tester, cost_usd, duration_ms, commit_sha, error? }`.
- The orchestrator appends every processed sentinel to `inbox/.processed/` with
  its verdict — this is the external-action audit trail.
- The dispatcher emits a heartbeat (`state.rig_heartbeat` bump) every tick. The
  dashboard uses freshness of this timestamp to detect a dead rig.

## Open questions

**NONE — all decisions locked.**

## Build status

- [ ] **M0**: in progress (5 T0 prompts being authored)
- [ ] **M1**: in progress (dashboard DONE polish)
- [ ] **M2**: in progress (TierStrip + frontmatter parser extension)
- [ ] **M3**: in progress (rig MVP)
- [ ] **M4**: in progress (dashboard reads state)
- [ ] **M5**: not started
- [ ] **M6**: not started
- [ ] **M7**: in progress (smoke suite)
- [ ] **M8**: in progress (orchestrator + jc CLI)
- [ ] **M9**: not started
- [ ] **M10**: not started
- [ ] **M11**: not started
- [ ] **M12**: not started
- [ ] **M13**: not started
- [ ] **M14**: not started

(Update checkboxes as milestones land.)
