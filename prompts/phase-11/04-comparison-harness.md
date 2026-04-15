# Phase 11 — Testing harness — Prompt 04: Claurst-vs-jellyclaw comparison harness (10 tests)

**When to run:** After Prompt 03 lands and scenario tier is green.
**Estimated duration:** 5-7 hours
**New session?** Yes
**Model:** Claude Opus 4.6 (1M context)

<!-- BEGIN SESSION STARTUP -->
Read and follow the full contents of `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/STARTUP-TEMPLATE.md` before doing anything else.

Substitutions:
- `<NN>` → `11`
- `<phase-name>` → `Testing harness`
- `<sub-prompt>` → `04-comparison-harness`
<!-- END SESSION STARTUP -->

## Research task

1. Read `test/TESTING.md` §6 — comparison thresholds: event count delta <20%, cost delta <25%, semantic equivalence.
2. Read `integration/GENIE-INTEGRATION.md` §2.6 — 15-event jellyclaw superset vs 4-event Claurst minimal. Stream normalization collapses the superset to a Claurst-shape projection before diffing event sequences.
3. Verify Claurst is installed and runnable: `which claurst && claurst --version`.
4. Read `test/helpers/normalize.ts` from Prompt 01; extend it for engine-specific stripping.

## Implementation task

Land `test/comparison/harness.mjs` and 10 comparison tests selected from the canonical 12 (skip `firebase-todo-app` and `linkedin-dm-5` — too long / too noisy for Claurst). For each wish: spawn both engines in isolated temp worktrees, capture full traces, normalize, diff, and write a per-wish row into `test/comparison/report.md`.

### Files to create/modify

- `/Users/gtrush/Downloads/jellyclaw-engine/test/comparison/harness.mjs` — runner library
- `/Users/gtrush/Downloads/jellyclaw-engine/test/comparison/matrix.test.mjs` — 10 `it` blocks
- `/Users/gtrush/Downloads/jellyclaw-engine/test/comparison/normalize.mjs` — collapses 15-event jellyclaw stream → 4-event Claurst projection (`text_delta`, `tool_start`, `result`, `error`)
- `/Users/gtrush/Downloads/jellyclaw-engine/test/comparison/diff.mjs` — sequence diff with whitelist (extra `browser_snapshot` permitted; extra `thinking_delta`/`subagent_*` permitted)
- `/Users/gtrush/Downloads/jellyclaw-engine/test/comparison/report-template.md`
- `/Users/gtrush/Downloads/jellyclaw-engine/test/helpers/llm-equivalence.mjs` — Haiku judge comparing two `result_text`s, returns `{equivalent, score, rationale}`
- `/Users/gtrush/Downloads/jellyclaw-engine/test/helpers/worktree.mjs` — `mktemp -d` per-engine, copies fixture repo
- `/Users/gtrush/Downloads/jellyclaw-engine/test/comparison/.gitignore` — ignores `report-*.md`, traces

### Shell commands

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine
which claurst || { echo "Claurst missing — install from genie-2.0/engines/claurst/"; exit 1; }
claurst --version
ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY bun run test:comparison
open test/comparison/report.md
```

### Expected output

`test/comparison/report.md` table:

| wish | events_jc | events_cl | events_delta% | cost_jc | cost_cl | cost_delta% | tool_seq_match | judge_score | verdict |
|------|-----------|-----------|---------------|---------|---------|-------------|----------------|-------------|---------|

10 rows, each with `verdict: PASS` when:
- `events_delta% < 20` (after normalization).
- `cost_delta% < 25`.
- `tool_seq_match` true under whitelist.
- `judge_score ≥ 4` AND `equivalent === true`.
- No tool jellyclaw invoked that Claurst lacked permission for.

Phase 11 acceptance allows up to **2 documented FAILs** if each is filed as a GitHub issue with reproduction. Goal is 10/10 PASS before Phase 12.

### Tests to add

10 `it` blocks in `matrix.test.mjs`:
1. coffee-landing
2. sweetgreen-order (dry-run on both)
3. research-topic
4. stripe-49
5. tweet-plus-landing (dry-run)
6. schedule-calendly (dry-run)
7. vercel-deploy
8. github-issues-summary
9. multi-file-refactor
10. factcheck-3-subagents

### Verification

```bash
bun run test:comparison --reporter=verbose | tee /tmp/cmp-run.log
test -s test/comparison/report.md
grep -c '| PASS |' test/comparison/report.md   # ≥ 8
grep -c '| FAIL |' test/comparison/report.md   # ≤ 2
```

### Common pitfalls

- **Claurst writes traces to a different location** (`~/.claurst/traces/`); the harness must locate them via Claurst's `--trace-file` flag (or scrape stderr) — don't assume parity with `~/.jellyclaw/traces/`.
- **Cost numbers from Claurst are OpenRouter-derived** while jellyclaw runs Anthropic-direct. Tokens are comparable but $/token differs. The 25% threshold accommodates this; don't tighten it.
- **Subagent wishes (#10, factcheck-3-subagents)** diverge in event count even after normalization — Claurst lacks `subagent_start`/`subagent_stop`. Whitelist these.
- **Worktree isolation:** both engines must receive the SAME `--add-dir` pointing at the SAME temp dir per run, with a clean copy of `test/fixtures/repo/` per engine.
- **MCP differences:** Claurst pins an older Playwright (`@playwright/mcp@0.0.39` in some installs). Force both to `0.0.41` via per-engine settings overrides written into the temp `.claurst/settings.json` and `.jellyclaw/settings.json`.
- **Don't run the comparison harness on every PR** — gate behind `RUN_COMPARISON=1`. Default it to nightly only (Prompt 05 wires this).

<!-- BEGIN SESSION CLOSEOUT -->
Read and follow the full contents of `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/COMPLETION-UPDATE-TEMPLATE.md`.

Substitutions:
- `<NN>` → `11`
- `<phase-name>` → `Testing harness`
- `<sub-prompt>` → `04-comparison-harness`
- Do NOT mark Phase 11 complete. Append a session-log row.
<!-- END SESSION CLOSEOUT -->
