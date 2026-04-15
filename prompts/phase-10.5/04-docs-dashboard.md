# Phase 10.5 — Interactive TUI — Prompt 04: Docs + Dashboard (close-out)

**When to run:** After Phase 10.5 prompts 01 + 02 + 03 are all ✅ in `COMPLETION-LOG.md`.
**Estimated duration:** 60 minutes
**New session?** Yes — always start a fresh Claude Code session per prompt.
**Model:** Claude Opus 4.6 (1M context)

<!-- BEGIN: paste from /Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/STARTUP-TEMPLATE.md -->
<!-- STOP if 10.5.01, 10.5.02, or 10.5.03 are not ✅. This is the close-out prompt — all three predecessors must be green before this runs or the denominator math + dashboard widening will land on an inconsistent base. -->
<!-- END paste -->

## Why this prompt exists

Phase 10.5 was inserted between Phase 10 and Phase 11 to add an interactive terminal TUI
(`jellyclaw tui`) without renumbering the 20 existing phases. That keeps history stable but
creates a scattering problem: every doc, dashboard validator, and hardcoded test assertion
that says "20 phases" or validates phase ids with `/^\d{2}$/` silently rejects `10.5`.

Prompts 10.5.01–10.5.03 delivered the TUI itself (Ink scaffolding, event bridge + input
loop, CLI command + docs). None of them touched the meta-ledger, because a running TUI
doesn't require the dashboard to know it exists. But leaving the repo claiming "20 phases"
while there are in fact 21 is exactly the kind of dishonest counting that compounds into
unreliable progress reporting later. This prompt closes that gap.

This prompt is the **mop-up**. It:

1. Updates every plan / overview doc to list Phase 10.5 and bumps the denominator from **20 → 21**.
2. Widens four dashboard regexes so the API accepts `10.5` as a phase id.
3. Updates hardcoded test assertions from `20` → `21`.
4. Flips Phase 10.5 to ✅ in `COMPLETION-LOG.md` and advances `STATUS.md` to Phase 11.

Nothing else. No new behavior. No new runtime code outside dashboard validators.

### Design principle behind the "10.5" number

The repo's phase numbering is a public API for anyone reading the plan. Renumbering
existing phases after-the-fact breaks every external reference (issue trackers, chat
history, commit messages that say "fixes Phase 11 scope"). Point-releases on the phase
number sidestep that cost at the price of a few regex widens. This prompt pays that
price in one pass so no future phase has to.

If a reviewer asks "why not just call it Phase 21 at the end?" — the answer is
chronology: 10.5 ran between 10 and 11 in time, and the dependency graph makes that
explicit. Calling it Phase 21 would hide that ordering. Keep the decimal.

## Research task

Read each file in full. Do **not** skim. The edits downstream are byte-precise and depend on
knowing the current shape.

### Plan / overview docs

1. `/Users/gtrush/Downloads/jellyclaw-engine/MASTER-PLAN.md` — find §4 (phase table). Note
   current row count and the "All 20 phases" copy wherever it appears.
2. `/Users/gtrush/Downloads/jellyclaw-engine/phases/README.md` — phase table + ASCII
   dependency graph. Locate the `10 → 11` edge.
3. `/Users/gtrush/Downloads/jellyclaw-engine/README.md` — look for an architecture diagram or
   an "entry points" bulleted list (CLI / HTTP / Library).
4. `/Users/gtrush/Downloads/jellyclaw-engine/prompts/README.md` — per-phase prompt count
   table + a "total prompts" summary line.
5. `/Users/gtrush/Downloads/jellyclaw-engine/prompts/DEPENDENCY-GRAPH.md` — ASCII graph +
   critical-path line.
6. `/Users/gtrush/Downloads/jellyclaw-engine/CLAUDE.md` — "Where we are" table (if present).
7. `/Users/gtrush/Downloads/jellyclaw-engine/CHANGELOG.md` — `## [Unreleased]` section.

### Phase ledger

8. `/Users/gtrush/Downloads/jellyclaw-engine/COMPLETION-LOG.md` — find progress bar
   (`11/20 (55%)`), the phase checklist, the completion-details blocks, and the session-log
   table. Study the shape of the Phase 10 block — 10.5's block will mirror it.
9. `/Users/gtrush/Downloads/jellyclaw-engine/STATUS.md` — current-phase marker, phase-progress
   list, test count.
10. `/Users/gtrush/Downloads/jellyclaw-engine/phases/PHASE-11-testing.md` — frontmatter
    `depends_on:` array.
11. `/Users/gtrush/Downloads/jellyclaw-engine/phases/PHASE-10-cli-http.md` — frontmatter
    `blocks:` array.

### Dashboard code (regex widening)

12. `/Users/gtrush/Downloads/jellyclaw-engine/dashboard/server/src/routes/phases.ts` —
    note `PhaseParam` Zod schema around line 18 and any `padStart(2, "0")` call.
13. `/Users/gtrush/Downloads/jellyclaw-engine/dashboard/server/src/lib/log-parser.ts` —
    `PHASE_CHECK_RE` (~line 13) and `sectionRe` (~line 46). Both need widening; both must
    drop any unconditional zero-padding for the captured group.
14. `/Users/gtrush/Downloads/jellyclaw-engine/dashboard/src/lib/api-validation.ts` — phase-id
    regex (~line 31–32) + prompt-id regex (~line 61).
15. `/Users/gtrush/Downloads/jellyclaw-engine/dashboard/server/src/routes/prompts.ts` —
    prompt-id regex (~line 21).
16. `/Users/gtrush/Downloads/jellyclaw-engine/dashboard/server/src/lib/prompt-parser.ts` —
    `listPromptFiles`. Confirm it already accepts `phase-10.5/` via `startsWith` — usually
    no change needed, but verify and note.

### Dashboard UI (no code change; verify)

17. `/Users/gtrush/Downloads/jellyclaw-engine/dashboard/src/components/PhaseSidebar.tsx` +
    `PhaseItem.tsx` — confirm data-driven rendering from the `/api/phases` list.
18. `/Users/gtrush/Downloads/jellyclaw-engine/dashboard/src/components/ProgressBar*.tsx` —
    confirm percent is read from API, not hardcoded.

### Hardcoded test assertions

19. `/Users/gtrush/Downloads/jellyclaw-engine/dashboard/tests/integration/api.test.ts` —
    lines ~75–81, `.toBe(20)` assertions.
20. `/Users/gtrush/Downloads/jellyclaw-engine/dashboard/tests/e2e/smoke.spec.ts` —
    lines ~20, 29, 35, `.toBeGreaterThanOrEqual(20)` assertions + any "at least 20 phases"
    copy.

### CLI / library docs (verify work from earlier prompts)

21. `/Users/gtrush/Downloads/jellyclaw-engine/docs/cli.md` — confirm Prompt 10.5.03 landed
    the `tui` command row + section. If missing, add.
22. `/Users/gtrush/Downloads/jellyclaw-engine/docs/library.md` — overview table of
    `createEngine` consumers. Add TUI as the 4th entry.
23. `/Users/gtrush/Downloads/jellyclaw-engine/docs/ARCHITECTURE.md` — if an entry-point
    diagram exists, confirm TUI is listed; add if missing.

## Implementation task

Work through sections A–F as a checklist. Check each box in order — later sections depend
on the data model established in earlier ones (e.g. the dashboard regex must be widened
before the integration test for `/api/phases/10.5` will pass).

### A. Plan / overview docs

| Path | Change |
|---|---|
| `MASTER-PLAN.md` | Insert row in §4 phase table: `10.5 \| Interactive terminal TUI \| 4–5h \| 10 \| \`jellyclaw tui\` opens TUI`. Change **any** "All 20 phases" / "20-phase plan" / "20 phases total" copy → **21**. Grep the file for the literal `20` and audit every hit. |
| `phases/README.md` | Add Phase 10.5 row to the phase table. Insert node `10.5` between `10` and `11` in the ASCII dependency graph (e.g. `10 ─▶ 10.5 ─▶ 11`). |
| `README.md` | If the architecture diagram has an entry-points list, add `TUI (\`jellyclaw tui\`)` as the 4th entry alongside CLI / HTTP / Library. Skip if no such list exists. |
| `prompts/README.md` | Add `10.5 \| TUI \| 4 prompts` row to the per-phase table. Bump the total-prompt counter (was ~60 → now ~64 — whatever the actual new total is; count, don't guess). |
| `prompts/DEPENDENCY-GRAPH.md` | Add Phase 10.5 node between 10 and 11 in the ASCII diagram. Update the critical-path line if 10.5 sits on it. |
| `CLAUDE.md` | Update the "Where we are" table if present — add a 10.5 row. |
| `CHANGELOG.md` | Under `## [Unreleased]`, add `- Phase 10.5: Interactive terminal TUI (\`jellyclaw tui\`).` |

### B. Phase ledger

| Path | Change |
|---|---|
| `COMPLETION-LOG.md` | (1) Change progress bar denominator `11/20 (55%)` → `12/21 (57%)` **after** Phase 10.5 is marked complete in this prompt. (2) Insert `- [x] ✅ Phase 10.5 — Interactive TUI` between the Phase 10 and Phase 11 checklist rows. (3) Add a Phase 10.5 completion-details block that **mirrors the shape of the Phase 10 block** — duration, sessions, tests added, notable files, follow-ups. (4) Append session-log rows for `10.5.01`, `10.5.02`, `10.5.03`, `10.5.04`. |
| `STATUS.md` | (1) Change current-phase marker to **Phase 11**. (2) Add `- [x] ✅ Phase 10.5 — Interactive TUI` to the phase-progress list. (3) Update the test-count line by whatever 10.5 added. |
| `phases/PHASE-11-testing.md` | Add `10.5` to the `depends_on:` frontmatter array. Phase 11 now requires 10.5 complete. |
| `phases/PHASE-10-cli-http.md` | Add `10.5` to the `blocks:` frontmatter array. Phase 10 now blocks 10.5. |

### C. Dashboard code — regex widening (critical)

The dashboard currently validates phase numbers with regexes like `/^\d{1,2}$/` and
`/^\d{2}$/`. These **reject `10.5`** and cause the API to 404 silently on the new phase.
Widen each regex to accept an optional `.<digits>` suffix. Anywhere the captured phase
number is unconditionally zero-padded via `padStart(2, "0")`, gate that on "no decimal
present" — otherwise `"10.5".padStart(2, "0")` is a no-op but older variants may mangle
short ids.

| Path | Change |
|---|---|
| `dashboard/server/src/routes/phases.ts:18` | `PhaseParam` regex `/^\d{1,2}$/` → `/^\d{1,2}(?:\.\d+)?$/`. Remove `padStart(2, "0")` for decimal phases (guard with `.includes(".")` check). |
| `dashboard/server/src/lib/log-parser.ts:13` | `PHASE_CHECK_RE /Phase\s+(\d+)\b/` → `/Phase\s+(\d+(?:\.\d+)?)\b/`. |
| `dashboard/server/src/lib/log-parser.ts:46` | `sectionRe /###\s+Phase\s+(\d+)\s+—/gm` → `/###\s+Phase\s+(\d+(?:\.\d+)?)\s+—/gm`. Remove the unconditional padStart on the captured group. |
| `dashboard/src/lib/api-validation.ts:31,32` | Phase-id regex `/^\d{2}$/` → `/^\d{2}(?:\.\d+)?$/`. |
| `dashboard/src/lib/api-validation.ts:61` | Prompt-id regex `/^phase-\d{2}\//` → `/^phase-\d{2}(?:\.\d+)?\//`. |
| `dashboard/server/src/routes/prompts.ts:21` | Widen prompt-id regex the same way: `/^phase-\d{2}(?:\.\d+)?\//`. |
| `dashboard/server/src/lib/prompt-parser.ts` | Verify `listPromptFiles` accepts a `phase-10.5/` directory. If it uses `startsWith("phase-")` it already does — no change. If it uses a regex, widen it. Document your finding in the commit message. |

### D. Dashboard UI

No code change. Verify after restart:

- `dashboard/src/components/PhaseSidebar.tsx` / `PhaseItem.tsx` render the phase list
  from the API response — 10.5 appears between 10 and 11.
- `dashboard/src/components/ProgressBar*.tsx` reads percent from the API — bar shows
  12/21 (≈ 57%).

If either component has hardcoded ordering or a hardcoded total, fix it and note the
surprise in the completion log.

### E. Hardcoded test assertions

| Path | Change |
|---|---|
| `dashboard/tests/integration/api.test.ts:75–81` | `.toBe(20)` → `.toBe(21)`. Update the accompanying comment to reference the new count (e.g. "20 phases (0–19)" → "21 phases (0–19 + 10.5)"). |
| `dashboard/tests/e2e/smoke.spec.ts:20,29,35` | `.toBeGreaterThanOrEqual(20)` → `.toBeGreaterThanOrEqual(21)`. Update copy "at least 20 phases" → "at least 21 phases". |

### F. CLI / library docs

| Path | Change |
|---|---|
| `docs/cli.md` | Prompt 10.5.03 should already have added the `tui` row + section. Verify. If missing, add: a row in the command table and a `## tui` section with synopsis, flags, and an example. |
| `docs/library.md` | In the overview table of `createEngine` consumers (CLI, HTTP, Library), add **TUI** as the 4th row. |
| `docs/ARCHITECTURE.md` | If the entry-point diagram or table exists, add TUI. Skip if no such diagram. |

## Files to create / modify — exhaustive list

**Modify:**

- `/Users/gtrush/Downloads/jellyclaw-engine/MASTER-PLAN.md`
- `/Users/gtrush/Downloads/jellyclaw-engine/phases/README.md`
- `/Users/gtrush/Downloads/jellyclaw-engine/README.md` (conditional)
- `/Users/gtrush/Downloads/jellyclaw-engine/prompts/README.md`
- `/Users/gtrush/Downloads/jellyclaw-engine/prompts/DEPENDENCY-GRAPH.md`
- `/Users/gtrush/Downloads/jellyclaw-engine/CLAUDE.md` (conditional)
- `/Users/gtrush/Downloads/jellyclaw-engine/CHANGELOG.md`
- `/Users/gtrush/Downloads/jellyclaw-engine/COMPLETION-LOG.md`
- `/Users/gtrush/Downloads/jellyclaw-engine/STATUS.md`
- `/Users/gtrush/Downloads/jellyclaw-engine/phases/PHASE-11-testing.md`
- `/Users/gtrush/Downloads/jellyclaw-engine/phases/PHASE-10-cli-http.md`
- `/Users/gtrush/Downloads/jellyclaw-engine/dashboard/server/src/routes/phases.ts`
- `/Users/gtrush/Downloads/jellyclaw-engine/dashboard/server/src/lib/log-parser.ts`
- `/Users/gtrush/Downloads/jellyclaw-engine/dashboard/server/src/routes/prompts.ts`
- `/Users/gtrush/Downloads/jellyclaw-engine/dashboard/src/lib/api-validation.ts`
- `/Users/gtrush/Downloads/jellyclaw-engine/dashboard/tests/integration/api.test.ts`
- `/Users/gtrush/Downloads/jellyclaw-engine/dashboard/tests/e2e/smoke.spec.ts`
- `/Users/gtrush/Downloads/jellyclaw-engine/docs/cli.md` (verify, add if missing)
- `/Users/gtrush/Downloads/jellyclaw-engine/docs/library.md`
- `/Users/gtrush/Downloads/jellyclaw-engine/docs/ARCHITECTURE.md` (conditional)

**Create:**

- `/Users/gtrush/Downloads/jellyclaw-engine/dashboard/tests/integration/phase-10.5.test.ts`
  — see "Tests to add" below.

**Do not touch:** any `engine/src/` code; any runtime CLI/HTTP/library surface; any phase
doc except PHASE-10 / PHASE-11 frontmatter arrays. This prompt is pure paperwork + a regex
widening. If you find yourself editing engine code, stop and reread the prompt.

## Edit order (do these in sequence — later steps verify earlier ones)

1. **Section C first (regexes).** Without widening, nothing downstream can be verified
   because the API returns 400/404 on `10.5`. Widen all four files, run `bun run
   typecheck` to catch any Zod schema callers that rely on the old shape.
2. **Section A (plan docs).** Cheap, mostly-mechanical text changes. Do them in a single
   pass, then grep for `/20` and `20 phases` repo-wide to catch stragglers.
3. **Section B (ledger) — all except the ✅ flip.** Add the checklist row (still
   unchecked), add the completion-details block skeleton, add the session-log rows.
   Leave the progress counter at `11/20` for now; the flip happens at close-out.
4. **Section D (UI verification).** Start the dashboard once, eyeball the sidebar, kill
   it. This is a dry-run — if 10.5 renders correctly, the regex widen + ledger changes
   are consistent.
5. **Section E (hardcoded test assertions).** Once the dashboard actually reports 21
   phases, the tests will pass at the new number. Update the assertions.
6. **Section F (docs) — verify only.** If any doc is missing the TUI entry, that's a
   sign prompt 10.5.03 didn't land fully. Fix it here rather than going back.
7. **Add the new integration test.** `dashboard/tests/integration/phase-10.5.test.ts`.
   Run `bun run test dashboard/tests/` — must be green.
8. **Close-out.** Flip the checkbox, bump the counter to 12/21, advance STATUS.md.
   **Only now** run the full verification block below — the prompt is done when every
   item in "Verification" passes.

## Shell commands

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine

# Typecheck + lint after edits
bun run typecheck
bun run lint

# Sanity: the denominator should appear as 21 everywhere, 20 nowhere (except historical CHANGELOG entries)
rg -n "\b20 phases\b" .
rg -n "/20 \(" .
rg -n "toBe\(20\)" dashboard/
rg -n "toBeGreaterThanOrEqual\(20\)" dashboard/

# Dashboard tests
bun run test dashboard/tests/

# E2E smoke (headed or headless depending on CI profile)
bun run test:e2e dashboard/tests/e2e/smoke.spec.ts

# Dashboard wetware check
./dashboard/start.sh &
DASHBOARD_PID=$!
sleep 2
curl -s http://127.0.0.1:5174/api/phases/10.5 | jq .
# Open http://127.0.0.1:5173 in a browser; navigate to /phases/10.5 — page should render.
kill $DASHBOARD_PID
```

## Verification

- `bun run test dashboard/tests/` — all green, including the new `phase-10.5.test.ts`.
- `bun run test:e2e dashboard/tests/e2e/smoke.spec.ts` — green; asserts ≥ 21 phases.
- Dashboard starts via `./dashboard/start.sh`; `http://127.0.0.1:5173/phases/10.5`
  renders Phase 10.5 details; sidebar lists 10.5 between 10 and 11.
- Progress bar reads **12/21 (≈ 57%)**.
- `curl http://127.0.0.1:5174/api/phases/10.5` returns 200 with a valid phase JSON
  payload (id `10.5`, title matching PHASE-10.5-tui.md, depends_on including `10`).
- `grep -r "20 phases" /Users/gtrush/Downloads/jellyclaw-engine` returns only hits in
  CHANGELOG historical entries or git history — no live copy.
- `grep -rn "/^\\\\d{1,2}\$/" /Users/gtrush/Downloads/jellyclaw-engine/dashboard/` returns
  empty (all widened).
- `grep -rn "/^\\\\d{2}\$/" /Users/gtrush/Downloads/jellyclaw-engine/dashboard/` returns
  empty (all widened).
- `COMPLETION-LOG.md` shows Phase 10.5 as ✅ with a full details block and four
  session-log rows.
- `STATUS.md` shows current phase = Phase 11.
- `phases/PHASE-11-testing.md` frontmatter `depends_on:` array includes `10.5`.
- `phases/PHASE-10-cli-http.md` frontmatter `blocks:` array includes `10.5`.

## Tests to add

Create **one** new integration test file:

`/Users/gtrush/Downloads/jellyclaw-engine/dashboard/tests/integration/phase-10.5.test.ts`

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestServer, stopTestServer } from "../helpers/server.js";

describe("GET /api/phases/10.5", () => {
  let baseUrl: string;

  beforeAll(async () => {
    baseUrl = await startTestServer();
  });

  afterAll(async () => {
    await stopTestServer();
  });

  it("returns 200 with Phase 10.5 payload", async () => {
    const res = await fetch(`${baseUrl}/api/phases/10.5`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.id).toBe("10.5");
    expect(json.title).toMatch(/TUI/i);
    expect(json.depends_on).toContain("10");
  });

  it("is listed by GET /api/phases and positioned between 10 and 11", async () => {
    const res = await fetch(`${baseUrl}/api/phases`);
    expect(res.status).toBe(200);
    const list = (await res.json()) as Array<{ id: string }>;
    const ids = list.map((p) => p.id);
    const idx10 = ids.indexOf("10");
    const idx105 = ids.indexOf("10.5");
    const idx11 = ids.indexOf("11");
    expect(idx10).toBeGreaterThanOrEqual(0);
    expect(idx105).toBe(idx10 + 1);
    expect(idx11).toBe(idx105 + 1);
  });

  it("is rejected as invalid id if the regex wasn't widened", async () => {
    // Sanity — if this fails with a 400, the widening in phases.ts regressed.
    const res = await fetch(`${baseUrl}/api/phases/10.5`);
    expect(res.status).not.toBe(400);
  });
});
```

Reuse whatever `startTestServer` helper the existing `dashboard/tests/integration/`
suite uses — do not invent a new harness. If the helper path differs, adjust the
import but keep the test semantics.

## Common pitfalls

- **Forgetting one regex file.** There are **four** regex widens (`phases.ts`,
  `log-parser.ts` × 2 sites, `api-validation.ts` × 2 sites, `prompts.ts`). Miss one and
  the API silently 404s on `10.5` while the UI renders an empty details pane. Check
  every entry in section C.
- **Changing the denominator in one doc but not another.** Grep `/20` and `20 phases`
  across the whole repo before claiming done. Expected survivors: only CHANGELOG
  historical entries.
- **Zero-padding breaks for decimals.** `"10.5".padStart(2, "0")` returns `"10.5"`
  (harmless), but any code that pads **before** deciding the id is valid may corrupt
  short ids like `"5"` → `"05"` when the caller passed `"5"` but the ledger stores
  `"05"`. Guard padding with `.includes(".") ? id : id.padStart(2, "0")`.
- **`COMPLETION-LOG.md` progress bar character count.** `12/21 ≈ 57%`. The bar is
  usually 20 slots wide; 57% of 20 ≈ 11 filled, 9 empty. Keep `█░` proportions correct
  — visual drift here is the most-noticed mistake in code review.
- **`phases/PHASE-11-testing.md` depends_on.** Adding `10.5` to this array is
  intentional — Phase 11 should not start until 10.5 is ✅. Confirm with the spec
  before assuming it's a typo.
- **Dashboard UI hardcoded ordering.** If `PhaseSidebar.tsx` sorts by a numeric
  `parseInt(id)`, `10.5` sorts between 10 and 11 correctly. If it sorts by string, 10.5
  lands between 10 and 100 — fine as long as there's no 100. Verify by rendering.
- **Don't commit.** George branches manually. Leave the working tree dirty; do not run
  `git commit`, `git push`, or `git branch`.
- **Don't renumber existing phases.** The whole reason 10.5 exists is to avoid
  renumbering. If you feel the urge to rename Phase 11 → Phase 10.6 for aesthetic
  reasons, stop.
- **Don't touch engine code.** This prompt is paperwork + dashboard validators. If an
  edit lands in `engine/src/`, roll it back.
- **E2E smoke may need a fresh `bun install` in `dashboard/`** — Playwright binaries
  are sometimes missing on cold machines. If `bun run test:e2e` fails with a browser
  missing error, run `bunx playwright install chromium` and retry.
- **Confusing "depends_on" with "blocks".** They are inverses. Phase 11 `depends_on:
  [..., 10.5]` means "11 can't start until 10.5 is done". Phase 10 `blocks: [..., 10.5]`
  means "10 must complete before 10.5". Both edges point the same direction in the DAG;
  just stated from opposite endpoints. Get them right or the dashboard's "can-start"
  logic will lie.
- **Progress-bar ratio drift.** 12/21 is ~57.14%. If your progress bar helper rounds
  differently than the source of truth (e.g. the dashboard computes 57% but the
  COMPLETION-LOG shows 60% from a bad mental-math moment), the dashboard and the doc
  disagree and reviewers lose trust. Copy the percent from the dashboard output after
  a restart, not from memory.
- **Zod schema error messages.** When you widen `PhaseParam`, the error message the API
  returns on invalid ids should still be informative. If the schema's `.regex(..., "message")`
  hardcoded "must be two digits", update the message to "must be two digits or two digits
  plus a decimal suffix (e.g. `10.5`)". Silent type changes degrade the API's
  self-documenting behavior.
- **Test helper import paths.** If `dashboard/tests/helpers/server.ts` doesn't exist,
  read one of the other integration tests to see how they boot. Copy that pattern
  verbatim for the new 10.5 test — don't invent your own server harness.
- **Do not add a `phase-10.5` entry to any `enum`-shaped TypeScript type.** The phase
  id space is a string domain, not an enum. If you find an enum of phase ids, that's a
  pre-existing bug worth noting but **do not expand it in this prompt** — that would
  couple the validator regex to the enum and force every future point-release to touch
  the type system. Leave the enum untouched; use the widened regex as the sole gate.

## Close-out: flip Phase 10.5 to ✅

After every other edit is landed and every verification passes, update the ledger in
this order:

1. In `COMPLETION-LOG.md`:
   - Flip `- [ ] Phase 10.5 — Interactive TUI` → `- [x] ✅ Phase 10.5 — Interactive TUI`.
   - Update the progress counter: `11/20 (55%)` → `12/21 (57%)`.
   - Repaint the progress bar: 11 filled / 9 empty out of 20 slots.
   - Add the completion-details block (mirror Phase 10's shape):

     ```markdown
     ### Phase 10.5 — Interactive TUI ✅

     - **Duration:** ~N hours across 4 sessions
     - **Sessions:** 10.5.01, 10.5.02, 10.5.03, 10.5.04
     - **Tests added:** N (unit + integration + e2e)
     - **Notable files:**
       - `engine/src/tui/` — Ink-based TUI shell
       - `engine/src/cli/commands/tui.ts` — `jellyclaw tui` entry
       - `dashboard/tests/integration/phase-10.5.test.ts`
     - **Follow-ups:** none blocking; see issue tracker for polish items.
     ```

   - Append session-log rows for 10.5.01–10.5.04 matching the table's existing columns.
2. In `STATUS.md`:
   - Current phase → Phase 11.
   - Add `- [x] ✅ Phase 10.5 — Interactive TUI` to phase-progress.
   - Bump the test-count line.
3. Confirm `phases/PHASE-11-testing.md` frontmatter `depends_on` includes `10.5` and
   `phases/PHASE-10-cli-http.md` frontmatter `blocks` includes `10.5`.

**Next prompt:** `/Users/gtrush/Downloads/jellyclaw-engine/prompts/phase-11/01-<name>.md`.
Suggest starting Phase 11 in a fresh session after this prompt's verifications pass.

## Completion-details block — exact template

Use this as the starting point for the Phase 10.5 block in `COMPLETION-LOG.md`. Fill in
the bracketed values from the real session logs; do **not** invent numbers.

```markdown
### Phase 10.5 — Interactive TUI ✅

**Duration:** [total-hours-from-session-logs] across 4 sessions
**Completed:** [YYYY-MM-DD] (prompt 10.5.04 close-out)
**Sessions:**

| Prompt | Session | Duration | Tests added |
|---|---|---|---|
| 10.5.01 | [session-id] | [h:mm] | [n] |
| 10.5.02 | [session-id] | [h:mm] | [n] |
| 10.5.03 | [session-id] | [h:mm] | [n] |
| 10.5.04 | [session-id] | [h:mm] | [n] |

**Tests added (Phase 10.5 total):** [n] (unit: [n], integration: [n], e2e: [n])

**Notable files created / modified:**
- `engine/src/tui/` — Ink-based TUI shell (prompt 10.5.01)
- `engine/src/tui/event-bridge.ts` — maps engine events to TUI state (prompt 10.5.02)
- `engine/src/cli/commands/tui.ts` — `jellyclaw tui` CLI entry (prompt 10.5.03)
- `docs/cli.md` — `tui` command reference (prompt 10.5.03)
- `docs/library.md` — TUI entry in consumers table (prompt 10.5.04)
- `dashboard/server/src/routes/phases.ts` — `PhaseParam` widened to accept decimals (prompt 10.5.04)
- `dashboard/server/src/lib/log-parser.ts` — phase regex widened (prompt 10.5.04)
- `dashboard/src/lib/api-validation.ts` — phase + prompt id regexes widened (prompt 10.5.04)
- `dashboard/tests/integration/phase-10.5.test.ts` — new (prompt 10.5.04)

**Follow-ups (non-blocking):**
- [list any punt items from the session logs; if none, write "none"]

**Known limitations:**
- [list any known gaps, e.g. TUI color theming hardcoded; see issue #___]
```

## Rollback procedure

If the verification block fails and the regression is non-obvious, roll back in this
order rather than patching forward:

1. `git diff` — review every change. Anything outside the allow-list above is a red
   flag; discard it with `git checkout -- <path>`.
2. If the dashboard 404s on `10.5`, you missed a regex. Re-grep the four target files
   and compare against the table in section C.
3. If `bun run test dashboard/tests/` fails with `.toBe(21)` assertions expecting 20,
   you edited the tests before the server actually returns 21 phases — either the
   phase file `phases/PHASE-10.5-tui.md` doesn't exist yet, or `listPromptFiles` /
   `loadPhases` doesn't see it. Check the dashboard server's phase-loading code path
   before touching the tests.
4. If COMPLETION-LOG progress bar looks wrong, just re-render it from scratch:
   `printf '█%.0s' {1..11}; printf '░%.0s' {1..9}` — that's the 11/20-slot repaint
   for 57% fill.
5. If all else fails, `git stash` your edits and restart this prompt from a clean tree.
   Do **not** half-land. Half-landed mop-up prompts create the worst category of
   reviewer confusion.

## What success looks like

When this prompt is done:

- A new engineer cloning the repo, running `./dashboard/start.sh`, and opening
  `http://127.0.0.1:5173` sees **21 phases** in the sidebar, Phase 10.5 between 10
  and 11, progress bar at 12/21, and clicking Phase 10.5 renders a populated detail
  pane.
- Every plan doc honestly says "21 phases" (CHANGELOG historical entries excepted).
- Phase 11 is cleanly unlocked in the dependency graph.
- No engine runtime code was touched — this was pure paperwork + three regex widens +
  one new test.
- George can cut a branch (`phase-10.5-close-out` or whatever he prefers) from the
  current dirty tree and review the diff in one sitting.

<!-- BEGIN: paste from /Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/COMPLETION-UPDATE-TEMPLATE.md -->
<!-- On success: Phase 10.5 fully ✅ in COMPLETION-LOG.md; STATUS.md advanced to Phase 11; denominator bumped to /21 repo-wide; four dashboard regexes widened; one new integration test passing. Next prompt = prompts/phase-11/01-<name>.md. -->
<!-- END paste -->

**Note:** This is the FINAL prompt in Phase 10.5 — flip the phase to ✅ in
`COMPLETION-LOG.md`, bump the progress counter to 12/21, and advance `STATUS.md` to
Phase 11. After this prompt, the repo honestly reports 21 phases and the dashboard
renders Phase 10.5 without regex-shaped holes.
