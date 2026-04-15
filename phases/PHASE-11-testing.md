---
phase: 11
name: "Testing harness"
duration: "3 days"
depends_on: [02, 03, 04, 05, 06, 07, 08, 09, 10]
blocks: [12, 13, 18]
---

# Phase 11 — Testing harness

## Dream outcome

A single `pnpm test` runs ~95 tests across 4 tiers in under 10 minutes on CI: 50 unit, 20 integration, 15 scenario (real wishes), 10 comparison vs Claurst. A nightly matrix re-runs scenarios against live providers. Cost of a full CI PR run is <$1.

## Deliverables

- `test/unit/` — 50 tests
- `test/integration/` — 20 tests (real OpenCode server + mock providers)
- `test/scenario/` — 15 end-to-end wishes
- `test/comparison/` — 10 Claurst diff tests
- `test/fixtures/mcp/echo-server.ts`
- `test/golden/*.jsonl` (from Phase 03)
- `test/helpers/cost-ledger.ts` — tracks spend per test run
- `.github/workflows/test-nightly.yml`
- `docs/testing.md`

## Tiers

### Unit (50, target runtime <30 s)
Config, schema, rule matcher, stream adapter, substitution, parser, namespacing, idempotency, fault-injection, etc. No network.

### Integration (20, <3 min)
Live OpenCode server + mock MCP echo server. Provider calls stubbed via `msw` or `undici` `MockAgent`. Test:
- tool dispatch end-to-end
- subagent hooks fire
- session resume round-trip
- permission modes
- MCP connect + call
- provider fallback
- skills discovery + injection

### Scenario (15, <5 min total with caching)
Real prompts against live Anthropic. Cached via request hashing to `test/.cache/` so only first run costs money. Scenarios:
1. Single-shot "write hello world file"
2. Refactor: read file, edit, verify
3. Debug: run failing test, propose fix
4. Multi-tool: grep → read → edit
5. Subagent: Task → code-reviewer
6. Resume: run 3 turns, interrupt, resume, run 2 more
7. Skill invocation with `$ARGUMENTS`
8. MCP browser navigate + screenshot
9. Plan mode blocks execution
10. `acceptEdits` auto-approves
11. Hook blocks dangerous bash
12. 3 parallel subagents
13. `--continue` picks latest
14. Long context: 50k tokens then compact
15. Cancel mid-turn returns cleanly

### Comparison vs Claurst (10)
Run identical prompt on `claurst run` and `jellyclaw run`. Normalize streams (strip ts, ids). Diff. Expected: semantic equivalence (same tool calls, same final answer category). Differences allowed: richer jellyclaw fields.

## Step-by-step

### Step 1 — Fixtures
Build `echo-server.ts` MCP. Build a fixture repo at `test/fixtures/repo/` with known files.

### Step 2 — Test helpers
`test/helpers/`:
- `startEngine.ts` — boots engine with in-test config
- `collectStream.ts` — reads async iterator into array
- `normalize.ts` — strips ts, uuids, absolute paths
- `cost-ledger.ts` — writes `test/.cost-ledger.jsonl`

### Step 3 — msw / MockAgent for provider tests
Record real Anthropic responses once into `test/fixtures/anthropic/*.json` via a script; replay in unit/integration tiers.

### Step 4 — Nightly workflow
`.github/workflows/test-nightly.yml`:
```yaml
on:
  schedule: [{ cron: "0 6 * * *" }]
  workflow_dispatch:
jobs:
  scenarios:
    runs-on: ubuntu-latest
    env: { ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }} }
    steps:
      - uses: actions/checkout@v4
      - # ... setup
      - run: pnpm test:scenario
```

### Step 5 — Cost budget enforcement
`cost-ledger.ts` sums token cost per test run. CI fails if a PR run exceeds $1.

### Step 6 — Flake quarantine
`vitest.config.ts`: mark retries on integration tier = 2, scenario tier = 1. Quarantine consistently-flaky tests into `test/quarantine/` with an owner + issue link.

### Step 7 — Coverage target
Unit tier must hit 80% line coverage on `engine/src/`. CI gate.

## Acceptance criteria

- [ ] Unit tier: 50 tests, <30 s, 80% coverage
- [ ] Integration tier: 20 tests, <3 min, green
- [ ] Scenario tier: 15 tests run against live API, <5 min cached, <$0.20 per run
- [ ] Comparison tier: 10 Claurst diffs, all semantically equivalent
- [ ] Nightly workflow runs and posts to Slack/email on failure
- [ ] CI PR cost <$1

## Risks + mitigations

- **Scenario tier flakes from model non-determinism** → use temperature=0 + cached responses + tolerant semantic matchers.
- **Secrets in logs** → redact Bearer tokens + api keys in test output.
- **Test runtime creep** → budget gate (fail if total >10 min).

## Dependencies to install

```
msw@^2
```

## Files touched

- `test/unit/**`
- `test/integration/**`
- `test/scenario/**`
- `test/comparison/**`
- `test/helpers/**`
- `test/fixtures/**`
- `.github/workflows/test-nightly.yml`
- `docs/testing.md`
