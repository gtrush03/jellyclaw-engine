# Jellyclaw Engine — Prompt System

This directory is the operational runbook for building jellyclaw-engine across 20 phases via copy-paste-into-Claude-Code prompts. Every prompt is self-contained: it orients a fresh session, does one unit of work, verifies the result, and updates the completion log.

## How the prompt system works

Each phase in `MASTER-PLAN.md` is decomposed into one or more **prompts**. Every prompt is a markdown file that you open, copy the entire contents of, and paste into a **new Claude Code session** at the jellyclaw-engine repo root.

The prompt structure is always:

1. **Session-startup block** — loaded from `session-starters/STARTUP-TEMPLATE.md`. Orients the fresh session: reads README, MASTER-PLAN, COMPLETION-LOG, STATUS, and the phase doc. Verifies environment.
2. **Research / understanding task** — reads existing code, upstream OpenCode source, or prior-phase artifacts. Confirms the plan before writing code.
3. **Implementation** — does the actual work: writes files, patches dependencies, wires components.
4. **Verification** — runs tests, type-checks, smoke tests. A prompt does not complete until verification is green.
5. **Completion-log update** — loaded from `session-starters/COMPLETION-UPDATE-TEMPLATE.md`. Updates `COMPLETION-LOG.md`, `STATUS.md`, commits, and tells the user what to run next.

## When to start a new Claude session

**Default: start a new Claude Code session per prompt.** This keeps context windows small, avoids cross-contamination between concerns, and makes each prompt reproducible.

Exceptions where continuing in the same session is fine:
- You had to retry a prompt that failed partway through (same prompt, same session is fine).
- Two very small sub-prompts within the same phase both finished in <20% context (rare).

If a phase has 5 prompts, expect 5 sessions. The first prompt's startup block will take ~5-10k tokens just to orient — this is the price of a clean slate and it is worth paying.

## Prompt numbering

Prompts live at:

```
prompts/
├── README.md                      (this file)
├── DEPENDENCY-GRAPH.md            (visual block diagram)
├── session-starters/
│   ├── STARTUP-TEMPLATE.md        (header — copy into every prompt)
│   └── COMPLETION-UPDATE-TEMPLATE.md  (footer — copy into every prompt)
├── phase-00/
│   └── 01-scaffold.md
├── phase-01/
│   ├── 01-research-opencode.md
│   └── 02-pin-and-patch.md
├── phase-02/
│   ├── 01-config-schema.md
│   ├── 02-provider-anthropic.md
│   └── 03-provider-openrouter.md
...
```

Numbering is strictly `NN-kebab-case-name.md` where `NN` is a two-digit ordinal within the phase, starting at `01`. Prompts within a phase are sequential by default; see the parallel column in the table below and `DEPENDENCY-GRAPH.md` for exceptions.

## What "done" looks like per phase

Before moving on to the next phase, the current phase must have:

- All prompts in the phase marked ✅ in `COMPLETION-LOG.md`.
- The phase checkbox flipped to `- [x] ✅` in the foundation/core/integration/desktop section.
- The progress bar incremented.
- Tests for that phase passing. Specifically:
  - Phase 00-02: type-check + lint green.
  - Phase 03-09: unit tests for the new subsystem + integration test against a mock model.
  - Phase 10-11: end-to-end test against a real provider (with recorded fixtures).
  - Phase 12-13: jellyclaw runs a real Genie workflow end-to-end behind the feature flag.
  - Phase 14+: observability dashboards show traces.
- A clean `git status` (all work committed).
- A short "what landed + deviations from spec" note in the phase completion details block of `COMPLETION-LOG.md`.

If any of these are missing, do not advance. Open a blocker row in the Blockers & decisions section of the log.

## Phase → prompt count table

| Phase | Name | Prompts | Est. sessions | Can parallel? |
|---|---|---|---|---|
| 00 | Repo scaffolding | 1 | 1 | no |
| 01 | OpenCode pinning | 2 | 1-2 | no |
| 02 | Config + provider | 3 | 2-3 | no |
| 03 | Event stream adapter | 2 | 1-2 | no (needs 02) |
| 04 | Tool parity | 5 | 3-5 | prompts 1-5 parallel |
| 05 | Skills system | 2 | 1-2 | parallel w/ 04 |
| 06 | Subagent + hooks | 3 | 2-3 | after 04+05 |
| 07 | MCP client | 3 | 2-3 | parallel w/ 08 |
| 08 | Permission + hooks | 3 | 2-3 | parallel w/ 07 |
| 09 | Session persistence | 2 | 1-2 | after 08 |
| 10 | CLI + HTTP server | 3 | 2-3 | after 06-09 |
| 11 | Testing harness | 5 | 3-5 | ongoing from phase 04+ |
| 12 | Genie integration | 4 | 3-4 | after 10+11 |
| 13 | Make jellyclaw default | 2 | 1-2 plus 72h burn-in | after 12 |
| 14 | Observability | 3 | 2-3 | parallel w/ 13 |
| 15 | Desktop MVP | 5 | 4-5 | after 10 |
| 16 | Desktop polish | 5 | 4-5 | after 15 |
| 17 | jelly-claw integration | 4 | 4-5 | after 16 |
| 18 | Open-source release | 3 | 2-3 | after 13+16 |
| 19 | Post-launch | ongoing | ongoing | ongoing |

**Total: ~60 prompts across 20 phases, estimated 40-60 Claude Code sessions.**

## Parallel execution notes

Phases marked "parallel" mean the prompts *within* that phase are independent and can be run in **concurrent Claude Code sessions** in separate git worktrees. After all parallel prompts complete, one integration prompt merges branches and runs the full test suite.

Recommended worktree pattern for parallel phases:

```
git worktree add ../jellyclaw-engine-phase04-read prompts/phase-04/01-read
git worktree add ../jellyclaw-engine-phase04-edit prompts/phase-04/02-edit
# ... one worktree per parallel prompt
```

Each worktree runs its own Claude Code session, its own tests, and pushes its own branch. Merge to `main` after all branches pass CI.

Phases marked "after X+Y" are gated: do not begin until the listed phases are ✅ in `COMPLETION-LOG.md`.

## When things go wrong

If a prompt fails partway through (tests red, patch conflict, API error), the session-startup block on the *next* attempt will detect it via `git status` and the COMPLETION-LOG mismatch. The expected recovery path is: open a blocker row, diagnose, fix, re-run the prompt.

Do not paper over a failed prompt by marking it ✅. The log is the source of truth for the whole project — it must stay honest.
