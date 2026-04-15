# Phase 11 — Testing harness — Prompt 01: Vitest setup + 50 unit tests

**When to run:** Phase 10 marked ✅ in `COMPLETION-LOG.md`.
**Estimated duration:** 8-10 hours
**New session?** Yes
**Model:** Claude Opus 4.6 (1M context)

<!-- BEGIN SESSION STARTUP -->
Read and follow the full contents of `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/STARTUP-TEMPLATE.md` before doing anything else.

Substitutions:
- `<NN>` → `11`
- `<phase-name>` → `Testing harness`
- `<sub-prompt>` → `01-vitest-setup-and-unit-tests`
<!-- END SESSION STARTUP -->

## Research task

1. Read `phases/PHASE-11-testing.md` end to end — especially the unit tier acceptance gate (50 tests, <30 s, 80% line coverage on `engine/src/`).
2. Read `test/TESTING.md` §3 (per-tool unit specs, the canonical 50-case enumeration) and §7 (MCP mock fixture protocol).
3. Skim `engine/src/tools/*.ts` (built in Phase 04) to confirm each tool's exported handler signature and Zod schema.
4. Skim the existing root `vitest.config.ts` — it is a Phase 00 placeholder. Replace, do not extend.

## Implementation task

Wire Vitest 2.x with a 4-tier project layout (`unit`, `integration`, `scenario`, `comparison`) and land all 50 unit-tier tests. Unit tier must run in <30s wall with ≥80% line coverage on `engine/src/`. No network in this tier — providers are mocked via `msw`, MCP via the local stdio stub from TESTING.md §7.

### Files to create/modify

- `/Users/gtrush/Downloads/jellyclaw-engine/vitest.config.mjs` — replace existing with multi-project config
- `/Users/gtrush/Downloads/jellyclaw-engine/test/helpers/run-jellyclaw.mjs` — spawn helper used across tiers
- `/Users/gtrush/Downloads/jellyclaw-engine/test/helpers/mcp-mock-server.mjs` — stdio MCP stub (TESTING.md §7)
- `/Users/gtrush/Downloads/jellyclaw-engine/test/helpers/anthropic-stub.mjs` — `msw` handlers replaying `test/fixtures/anthropic-stubs/*.jsonl`
- `/Users/gtrush/Downloads/jellyclaw-engine/test/helpers/cost-ledger.ts` — appends `test/.cost-ledger.jsonl`
- `/Users/gtrush/Downloads/jellyclaw-engine/test/helpers/normalize.ts` — strips `ts`, uuids, absolute paths
- `/Users/gtrush/Downloads/jellyclaw-engine/test/fixtures/repo/` — small fixture repo with known files for tool tests
- `/Users/gtrush/Downloads/jellyclaw-engine/test/fixtures/mcp-responses/*.json` — keyed by `{tool}-{hash}.json`
- `/Users/gtrush/Downloads/jellyclaw-engine/test/unit/bash.test.mjs` (5 cases)
- `/Users/gtrush/Downloads/jellyclaw-engine/test/unit/read.test.mjs` (4)
- `/Users/gtrush/Downloads/jellyclaw-engine/test/unit/write.test.mjs` (4)
- `/Users/gtrush/Downloads/jellyclaw-engine/test/unit/edit.test.mjs` (5)
- `/Users/gtrush/Downloads/jellyclaw-engine/test/unit/glob.test.mjs` (3)
- `/Users/gtrush/Downloads/jellyclaw-engine/test/unit/grep.test.mjs` (4)
- `/Users/gtrush/Downloads/jellyclaw-engine/test/unit/webfetch.test.mjs` (3)
- `/Users/gtrush/Downloads/jellyclaw-engine/test/unit/websearch.test.mjs` (3)
- `/Users/gtrush/Downloads/jellyclaw-engine/test/unit/todowrite.test.mjs` (3)
- `/Users/gtrush/Downloads/jellyclaw-engine/test/unit/task.test.mjs` (5) — patch #001 regression coverage
- `/Users/gtrush/Downloads/jellyclaw-engine/test/unit/notebookedit.test.mjs` (3)
- `/Users/gtrush/Downloads/jellyclaw-engine/test/unit/browser-snapshot.test.mjs` (4)
- `/Users/gtrush/Downloads/jellyclaw-engine/test/unit/browser-act.test.mjs` (4) — navigate/click/type
- `/Users/gtrush/Downloads/jellyclaw-engine/test/unit/hooks.test.mjs` — patch #001 hook-fire regression (counts inside Task's 5)
- `/Users/gtrush/Downloads/jellyclaw-engine/package.json` — add `test`, `test:unit`, `test:integration`, `test:scenario`, `test:comparison`, `test:coverage` scripts; add `msw@^2`, `@vitest/coverage-v8`, `tinypool` devDeps

### Shell commands

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine
bun add -D vitest@^2 @vitest/ui@^2 @vitest/coverage-v8@^2 msw@^2 tinypool
mkdir -p test/{helpers,fixtures/{repo,mcp-responses,anthropic-stubs,stream-json},unit,integration,scenario,comparison,quarantine,.cache,golden}
bun run build
bun run test:unit
bun run test:coverage -- --coverage.thresholds.lines=80 --project=unit
```

### `vitest.config.mjs` shape (multi-project)

```js
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    coverage: { provider: "v8", include: ["engine/src/**"], thresholds: { lines: 80 } },
    projects: [
      { test: { name: "unit",        include: ["test/unit/**/*.test.mjs"],        retry: 0, testTimeout: 5_000 } },
      { test: { name: "integration", include: ["test/integration/**/*.test.mjs"], retry: 2, testTimeout: 30_000 } },
      { test: { name: "scenario",    include: ["test/scenario/**/*.test.mjs"],    retry: 1, testTimeout: 300_000 } },
      { test: { name: "comparison",  include: ["test/comparison/**/*.test.mjs"],  retry: 0, testTimeout: 600_000 } },
    ],
  },
});
```

### Expected output

- 50 unit tests pass in <30s.
- `coverage/` shows ≥80% lines on `engine/src/`.
- `test/.cost-ledger.jsonl` exists but is empty (unit tier never calls a real provider).

### Tests to add (counts must hit exactly 50)

Bash 5, Read 4, Write 4, Edit 5, Glob 3, Grep 4, WebFetch 3, WebSearch 3, TodoWrite 3, Task 5, NotebookEdit 3, browser_snapshot 4, browser-act (navigate/click/type) 4 → 50. The hooks regression cases live inside `task.test.mjs` per TESTING.md §3.

### Verification

```bash
bun run test:unit | tee /tmp/unit-run.log
grep -c '✓' /tmp/unit-run.log    # → 50
time bun run test:unit            # < 30s wall
bun run test:coverage             # → ≥80% lines
```

### Common pitfalls

- **`msw@^2` Node interception** requires `setupFiles` registering `setupServer()` at module load — not per-test — or fetch races leak.
- **Coverage instrumenting a spawned engine subprocess** doesn't propagate. Unit tests must import the tool implementations directly from `engine/src/tools/*.ts`, not exec the CLI.
- **Patch #001 hooks regression must use Task → Bash nesting** — top-level Bash tests nothing relevant. Use `agents/code-reviewer` from Phase 06 or a stub subagent fixture.
- **Avoid `node:test` imports** anywhere — Vitest only.
- **`browser-act.test.mjs` cases must use the MCP mock**, not real Chromium. Real Chromium belongs in scenario tier on port 9333 (TESTING.md §8).

<!-- BEGIN SESSION CLOSEOUT -->
Read and follow the full contents of `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/COMPLETION-UPDATE-TEMPLATE.md`.

Substitutions:
- `<NN>` → `11`
- `<phase-name>` → `Testing harness`
- `<sub-prompt>` → `01-vitest-setup-and-unit-tests`
- Do NOT mark Phase 11 complete. Append a session-log row.
<!-- END SESSION CLOSEOUT -->
