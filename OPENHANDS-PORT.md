# OPENHANDS-PORT.md — Port OpenHands V1 SDK to jellyclaw

> **Last refreshed:** 2026-04-19
> **Status:** Proposal. Not started. Not on the v1.0 critical path.
> **Owner:** George (decide go/no-go after Phase 99 closes).

---

## One-liner

Port four load-bearing pieces of the [OpenHands V1 SDK](https://github.com/All-Hands-AI/OpenHands) into jellyclaw — `ConversationState`, `Workspace`, `Critic`, and the benchmarks harness — over ~4 weeks. Gain: a tested, separable state model for multi-turn runs; a scoped filesystem primitive; an automated evaluation lane; and a reproducible eval on SWE-bench / HumanEval / MBPP so we can claim numbers instead of vibes.

Counter-case at the bottom. Read it before saying yes.

---

## Why

- **jellyclaw's session state is currently spread across four places** — `engine/src/session/db.ts`, `engine/src/server/run-manager.ts`, `engine/src/daemon/store.ts`, and implicit state inside the TUI loop — and there is no single typed `ConversationState` object that the server, daemon, and TUI all mutate through. OpenHands solved this with a first-class `ConversationState` class (~400 LOC) whose API jellyclaw can mostly adopt verbatim.
- **jellyclaw has no `Workspace` primitive.** Tool calls write into `process.cwd()` or an ad-hoc `--cwd` flag. OpenHands' `Workspace` is a bounded, serializable filesystem handle that knows its root, its git state, and its session; tools take a `Workspace` argument, not a bare string. This is the right primitive for a cloud-hosted multi-tenant `jellyclaw serve`.
- **jellyclaw has no critic loop.** OpenHands' `Critic` runs after an agent turn and decides: accept, ask clarification, or retry with feedback. jellyclaw currently asks the model to self-check, which is unreliable. A dedicated critic is ~300 LOC and gives us measurable retry-success rate.
- **jellyclaw has no benchmarks.** We ship claims like "2115 tests pass" but no external benchmark. OpenHands runs SWE-bench Verified, HumanEval, and MBPP in CI. Adopting their harness is ~800 LOC of glue + a separate CI lane.

---

## License map — this is the first thing that must be right

| Source | License | Jellyclaw compat |
|---|---|---|
| `openhands/sdk/conversation/state.py` and friends | MIT | Yes — attribute in `engine/src/state/LICENSE.openhands` |
| `openhands/sdk/workspace/` | MIT | Yes — same |
| `openhands/sdk/critic/` | MIT | Yes — same |
| `openhands/evaluation/benchmarks/swe_bench/` | **PolyForm Shield 1.0.0** | **No** — cannot ship in jellyclaw repo. Harness must run out-of-tree in a separate `jellyclaw-evals` repo that consumes jellyclaw as a library, or we replace it with [`princeton-nlp/SWE-bench`](https://github.com/princeton-nlp/SWE-bench) (MIT) |
| HumanEval / MBPP harnesses | MIT (OpenAI / Google) | Yes |

**Rule:** anything from OpenHands `evaluation/` must be license-checked per-file before it enters this repo. The safe path is to vendor the three MIT pieces (`ConversationState`, `Workspace`, `Critic`), and run evals out-of-tree against jellyclaw's npm package.

---

## 4-week plan

### Week 1 — ConversationState (~1,000 LOC)

**Files to add:**
- `engine/src/state/conversation.ts` (~400 LOC) — ported from `openhands/sdk/conversation/state.py`. TypeScript with Zod schema. Replaces scattered session state.
- `engine/src/state/conversation.test.ts` (~250 LOC) — port OpenHands' `test_conversation_state.py` plus jellyclaw-specific cases for the TUI + daemon paths.
- `engine/src/state/events.ts` (~200 LOC) — typed event union `ConversationEvent` (user_message, assistant_message, tool_call, tool_result, error, retry, completion). Replaces the ad-hoc event emitters inside `run-manager.ts`.
- `engine/src/state/serializer.ts` (~150 LOC) — SQLite round-trip for ConversationState. Ensures `JELLYCLAW_HOME=/data/jellyclaw` restoration works per phase-99 session-restoration requirement.
- `engine/src/state/LICENSE.openhands` — verbatim MIT text + attribution block.

**Integration:**
- `engine/src/server/run-manager.ts` — delete inline state, construct a `ConversationState` at `/v1/sessions` create, mutate through its methods only.
- `engine/src/daemon/store.ts` — use `ConversationState.fromSerialized()` on resume.

**Gate:** existing 2115 tests still green + new state suite ≥95% line coverage + session-restoration test (kill + restart the engine, confirm in-flight run continues). This closes phase-99 T6 (session-restoration).

### Week 2 — Workspace primitive (~800 LOC)

**Files to add:**
- `engine/src/workspace/index.ts` (~300 LOC) — `Workspace` class: `root: string`, `session: ConversationState`, `git: GitHandle`, method `readFile`/`writeFile`/`exec`/`listDir`/`glob`. All path ops go through `path.resolve(root, rel)` + bounds check.
- `engine/src/workspace/git.ts` (~250 LOC) — minimal git wrapper over `simple-git` npm package. Methods: `status()`, `diff()`, `addAll()`, `commit(msg)`, `currentBranch()`. Replaces shell-outs sprinkled through tools.
- `engine/src/workspace/workspace.test.ts` (~200 LOC) — path-bounds, traversal-attack tests (the `..` and symlink cases), git state round-trip.
- `engine/src/workspace/LICENSE.openhands`.

**Tool migration (breaking, needs its own migration note):**
- `engine/src/tools/read.ts`, `write.ts`, `edit.ts`, `bash.ts`, `glob.ts`, `grep.ts` — each gains a `Workspace` argument, path args are now relative-to-workspace-root, not absolute.
- `engine/src/tools/index.ts` — tool registry mints a `Workspace` per `ConversationState` on first tool call.

**Gate:** all 11 built-in tools work against the new `Workspace`. `engine/test/smoke/` full suite green. No more raw `process.cwd()` reads outside `engine/src/cli/main.ts`.

### Week 3 — Critic loop (~600 LOC)

**Files to add:**
- `engine/src/critic/index.ts` (~250 LOC) — `Critic.evaluate(turn: ConversationTurn): CriticVerdict` where `CriticVerdict = { accept: true } | { accept: false, reason: string, retry: boolean }`. Uses a separate Haiku call against a scoring rubric (ported from `openhands/sdk/critic/rubric.py`).
- `engine/src/critic/rubric.ts` (~150 LOC) — the scoring prompt + Zod schema for the critic's structured output.
- `engine/src/critic/critic.test.ts` (~200 LOC) — golden-turn fixtures: 20 known-good turns (should accept), 20 known-bad (should reject with specific reasons).
- `engine/src/critic/LICENSE.openhands`.

**Integration:**
- `engine/src/agents/loop.ts` — after each `tool_result` → `assistant_message` cycle, invoke `Critic.evaluate`. On `{accept: false, retry: true}`, inject critic feedback as the next user turn and continue. On `{accept: false, retry: false}`, escalate to a permission prompt.

**Gate:** on the 5 golden prompts in `prompts/phase-08-hosting/T6-04-landing-and-tui/T4-02-golden-prompt-baselines.md`, critic-assisted runs beat unassisted runs on: (a) turns-to-completion, (b) final-output correctness (measured against the golden reference). Critic itself adds <1.5 s median overhead per turn and <$0.002 per turn at Haiku-3.5 rates.

### Week 4 — Benchmarks harness (~800 LOC, out-of-tree)

**New repo:** `jellyclaw-evals` (private first, open-source after v1.0).

**Files (in the new repo):**
- `harness/swe-bench.ts` (~300 LOC) — adapts `princeton-nlp/SWE-bench` to jellyclaw. Takes an issue, spins up a sandboxed workspace, invokes `jellyclaw run` via its npm package, scores against the test suite. MIT-licensed (Princeton, not OpenHands).
- `harness/humaneval.ts` (~200 LOC) — HumanEval lane. MIT.
- `harness/mbpp.ts` (~150 LOC) — MBPP lane. MIT.
- `harness/report.ts` (~150 LOC) — emits a per-run scorecard as JSON + a human-readable markdown table.
- `.github/workflows/nightly-evals.yml` — nightly run against `jellyclaw@latest` on npm. Posts scorecard delta to a private Discord webhook.

**Gate:** first-run scores posted. We don't chase a number; we establish the baseline.

---

## Counter-case — why this might be the wrong bet

1. **OpenHands is itself pre-1.0.** Their SDK has churned twice since January 2026. Porting from a moving target means we'll re-port in 6 months. Wait until they tag 1.0.
2. **jellyclaw's 11-tool surface is already behavior-compatible with Claude Code.** George's real differentiator is "runs Genie + jelly-claw," not "scores well on SWE-bench." We're being academic.
3. **The critic adds a Haiku call per turn.** At Anthropic's rates that's ~$0.20 per 100 turns. For a free-tier deploy that eats the margin. Gate the critic behind `JELLYCLAW_CRITIC=on`.
4. **Workspace migration is breaking.** All 11 tool files change. That's a Phase 11 move, not a "we can land this in week 2" move. Budget 2x the LOC.
5. **Benchmarks give us numbers but not users.** A landing page + docs + one happy non-George user matters more than a 40% SWE-bench-Verified score.

**If any two of these land, stop and re-plan.** The conservative alternative is: port only `ConversationState` (week 1), skip Workspace + Critic + evals, ship v1.0 without them, revisit after Genie has been on jellyclaw for 30 days.

---

## Prerequisites before starting

- Phase 99 unfucking closed (5/8 → 8/8).
- Phase 08-hosting T7 closed (vision + image-gen + skill-system upgrades landed).
- A staging Fly.io deploy that has survived a 24 h soak. DEPLOY.md is clear.
- A written yes from George on the license map (specifically: we are OK with PolyForm-licensed SWE-bench harness living in a separate repo).

---

## Resume

```
claude --resume e6b2db12-f6fc-4a55-a38c-4fa620e8a609
```
