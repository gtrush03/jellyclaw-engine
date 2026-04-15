# jellyclaw Testing Harness

**Goal:** Ship jellyclaw as Genie's default engine with quantified confidence.
Break "does it work?" into 95 concrete tests across four layers:

- **50 unit tests** — single tool behavior, no LLM.
- **20 integration tests** — single-turn LLM + one or two tools, cheap models.
- **15 scenario tests** — full multi-turn canonical wishes.
- **10 comparison tests** — jellyclaw vs Claurst on identical prompts.

Budget ceiling per PR: **< $1.00 USD** in model spend. Enforced in CI via a
cost-accounting step that fails the run if `/generation` totals exceed the cap.

---

## 1. Stack

- Runner: **Vitest 2.x** (`vitest` + `@vitest/ui` + `tinypool`).
- Snapshot tooling: built-in `toMatchSnapshot` with `--update` guarded behind a
  manual `UPDATE_SNAPSHOTS=1` env var.
- Mocks:
  - MCP mock server: stdio process that replays pre-recorded tool results.
  - Anthropic / OpenRouter mock: `msw` intercepting `api.anthropic.com` and
    `openrouter.ai` to serve cached `stream-json` responses.
- Golden fixtures: `test/fixtures/stream-json/*.jsonl` (real runs captured and
  trimmed), version-controlled.
- LLM-as-judge: a single Haiku call per scenario checks "did the final result
  satisfy the wish?" against a rubric. See §10.

---

## 2. Folder structure

```
test/
├── TESTING.md                          # this file
├── canonical-wishes.json               # 12 canonical wishes
├── vitest.config.mjs
├── fixtures/
│   ├── stream-json/
│   │   ├── simple-hello.jsonl
│   │   ├── website-coffee.jsonl
│   │   ├── subagent-factcheck.jsonl
│   │   └── …
│   ├── mcp-responses/
│   │   ├── browser_snapshot.json
│   │   ├── browser_navigate.json
│   │   └── …
│   └── anthropic-stubs/
│       └── *.jsonl
├── helpers/
│   ├── mcp-mock-server.mjs             # §7
│   ├── anthropic-stub.mjs              # msw handlers
│   ├── run-jellyclaw.mjs               # spawn helper
│   └── llm-judge.mjs                   # §10
├── unit/
│   ├── bash.test.mjs
│   ├── read.test.mjs
│   ├── write.test.mjs
│   ├── edit.test.mjs
│   ├── glob.test.mjs
│   ├── grep.test.mjs
│   ├── webfetch.test.mjs
│   ├── websearch.test.mjs
│   ├── todowrite.test.mjs
│   ├── task.test.mjs
│   ├── notebookedit.test.mjs
│   ├── browser-snapshot.test.mjs
│   ├── browser-act.test.mjs
│   └── hooks.test.mjs                  # patch #001 regression
├── integration/
│   ├── single-turn-bash.test.mjs
│   ├── tool-chain-read-edit.test.mjs
│   ├── provider-failover.test.mjs
│   └── …
├── scenario/
│   ├── coffee-landing.test.mjs
│   ├── sweetgreen-order.dryrun.test.mjs
│   ├── factcheck-3-subagents.test.mjs
│   └── …
└── comparison/
    ├── harness.mjs                     # §9
    └── matrix.test.mjs
```

---

## 3. Per-tool unit test specs (50 cases)

Each tool gets 3-5 focused cases. Asserts tool-level contract, not LLM behavior.

### Bash (5)
1. Executes `echo hi`, returns stdout = `"hi\n"`, exit 0.
2. Timeout at 120s kills child; returns `timeout: true`.
3. Captures interleaved stdout + stderr in separate streams.
4. Propagates non-zero exit code to `tool_use_result`.
5. Rejects `rm -rf /` via the `sandbox.blocked_patterns` list.

### Read (4)
1. Reads 2000-line file, returns line-numbered output.
2. `offset`+`limit` slice works; 1-indexed.
3. Rejects path outside `--add-dir` with `E_OUT_OF_SCOPE`.
4. Binary file returns first 256 bytes + warning.

### Write (4)
1. Creates new file in `/tmp/genie/<slug>/`.
2. Overwrites existing file and returns previous size in `tool_use_result`.
3. Fails cleanly on read-only fs.
4. Creates intermediate dirs.

### Edit (5)
1. Exact string replacement succeeds once.
2. `replace_all: false` + duplicate old_string → error.
3. `replace_all: true` replaces all occurrences, returns count.
4. No match → `E_NO_MATCH`, no file write.
5. Preserves file mtime when `old_string === new_string` (no-op).

### Glob (3)
1. `**/*.ts` matches nested files.
2. Returns mtime-sorted list.
3. Respects `.gitignore` when `--git-aware`.

### Grep (4)
1. Content mode returns line numbers.
2. `files_with_matches` mode returns paths only.
3. Multiline pattern with `multiline: true`.
4. `head_limit` truncates.

### WebFetch (3)
1. 200 OK returns body (truncated to 100KB).
2. 429 retried with exponential backoff, eventually succeeds on mock.
3. Redirect chain > 5 → `E_REDIRECT_LIMIT`.

### WebSearch (3)
1. Returns title+url+snippet triples.
2. Empty query → validation error.
3. Search provider switch: Brave vs Kagi via `WEB_SEARCH_PROVIDER`.

### TodoWrite (3)
1. Creates todo list, returns normalized payload.
2. Overwrites on second call (no merge).
3. Validates `status ∈ {pending, in_progress, completed}`.

### Task / Subagent (5) — **critical, patch #001 regression coverage**
1. Spawns subagent, receives `subagent_start` + `subagent_stop` events.
2. Parent thread blocks until subagent completes.
3. Subagent's Bash tool invocation fires PreToolUse hook (patch #001).
4. Subagent's PostToolUse hook receives correct tool result.
5. Parallel `Task` calls run concurrently, not serially.

### NotebookEdit (3)
1. Insert cell at index.
2. Edit cell by id.
3. Delete cell updates downstream cell ids.

### mcp__playwright__browser_snapshot (4)
1. Returns a11y tree JSON within 5s.
2. Respects `--cdp-endpoint` override.
3. Handles page still loading via internal wait.
4. Returns current URL + title in metadata.

### mcp__playwright__browser_click / type / navigate (4)
1. `browser_navigate` to about:blank succeeds.
2. `browser_click` on snapshot-relative ref.
3. `browser_type` with `submit: true` presses Enter.
4. Tab isolation: new click in tab A doesn't leak to tab B.

Total: **50 unit tests**.

---

## 4. Integration tests (20)

Real LLM calls, Haiku tier, single-turn with a constrained tool set.

1. "Run `ls /tmp`" → invokes Bash exactly once.
2. "Read package.json and tell me the name" → Read + text_delta.
3. "Create /tmp/genie-test/hello.txt with content 'hi'" → Write + text_delta.
4. "Replace 'foo' with 'bar' in this file" → Edit.
5. "Find all .md files in this repo" → Glob.
6. "Grep TODO in src/" → Grep, content mode.
7. "Fetch https://example.com" → WebFetch.
8. "Search: latest OpenCode version" → WebSearch.
9. "Plan a 3-step task" → TodoWrite with exactly 3 items.
10. "Spawn a subagent that runs `pwd`" → Task → Bash.
11. "Open about:blank in the browser and snapshot" → browser_navigate + browser_snapshot.
12. Provider failover: kill Anthropic via msw, expect OpenRouter used, result intact.
13. Cost accounting: usage.input_tokens + output_tokens match stub.
14. Session resume: start, kill mid-way, `--session-id` continues.
15. Hook: PreToolUse on Bash writes a marker file.
16. Hook: PostToolUse receives tool_use_result JSON on stdin.
17. Stream-stderr JSONL parses cleanly for 1000 entries.
18. `--max-turns 2` aborts after the second turn with a clear reason.
19. `--max-cost-usd 0.01` aborts pre-call when estimate exceeds.
20. `--add-dir` containment: Read outside it → E_OUT_OF_SCOPE.

Each integration test runs against msw-intercepted providers so $ cost is $0.

---

## 5. Scenario tests (15)

Full multi-turn flows. Uses the 12 canonical wishes from
`test/canonical-wishes.json` plus 3 edge cases:

13. **malformed-wish** — Empty transcript. Expects one Telegram message
    explaining the wish was empty, no tool calls.
14. **mcp-down** — Playwright MCP unreachable. Expects graceful degradation
    for non-browser parts, clear error for browser parts.
15. **budget-trip** — Wish intentionally expensive. Expects
    `--max-cost-usd` cap to fire, partial result delivered.

Each scenario asserts:

- Final `result` event fires with non-null `result_text` (except malformed-wish).
- Tool sequence matches `expected_tools` from `canonical-wishes.json`.
- `expected_result_shape` produced (text | url | order_id | payment_url).
- Within `timeout_seconds` and `max_cost_usd` budget.
- LLM judge (§10) scores ≥ 4/5 on rubric.

Dry-run wishes (Uber Eats, LinkedIn DMs, Calendly scheduling) stop one click
short of a destructive action. Asserted by inspecting the final
`tool_use_start` payload for the expected "review order" / "send message"
selector without a matching `tool_use_result` containing confirmation text.

---

## 6. Comparison harness (10 tests)

`test/comparison/harness.mjs` runs the same wish through jellyclaw and Claurst,
capturing both trace files. Matrix test verifies for each of 10 wishes:

- **Event count delta < 20%** (jellyclaw may emit more due to 15-event superset).
- **Final result semantic equivalence** (LLM judge compares both outputs).
- **Cost delta < 25%** (provider-driven, acceptable drift).
- **Tool sequence shape equivalence** — same tools invoked in the same order
  modulo whitelisted diffs (e.g. extra `browser_snapshot` calls are fine).
- **No tool jellyclaw invoked that Claurst lacked access to**.

Output: `test/comparison/report.md` with a pass/fail matrix.

---

## 7. MCP mock server fixture

`test/helpers/mcp-mock-server.mjs` is a tiny stdio JSON-RPC server that
implements the MCP protocol subset jellyclaw uses: `initialize`, `tools/list`,
`tools/call`. Responses are loaded from `test/fixtures/mcp-responses/*.json`
keyed by `{tool}-{hash_of_input}.json`.

Unknown inputs hit a passthrough mode that either (a) returns a generic stub
or (b) errors with `E_FIXTURE_MISSING` to force explicit recording.

To record a fixture from a live MCP session:

```bash
JELLYCLAW_MCP_RECORD=1 jellyclaw run -p "…" --mcp-config /tmp/real-mcp.json
# Fixtures appear in test/fixtures/mcp-responses/
```

---

## 8. Playwright test profile on port 9333

The mock never touches Chrome. For tests that need a real browser (scenario
tests 2, 3, 6, 7, 9), launch a dedicated Chromium on port **9333**:

```bash
CHROME_USER_DIR=$(mktemp -d)
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9333 \
  --user-data-dir="$CHROME_USER_DIR" \
  --no-first-run --no-default-browser-check \
  --headless=new &
```

**Never use 9222** — that's George's real, logged-in Chrome. Polluting it
would send actual LinkedIn DMs during test runs.

MCP settings for the test profile override the CDP endpoint via env:

```json
{ "args": ["-y", "@playwright/mcp@0.0.41", "--cdp-endpoint", "http://127.0.0.1:9333"] }
```

Teardown kills Chrome and rm-rf's the user dir.

---

## 9. Resume / crash / idempotency

Two test files:

### `test/integration/resume.test.mjs`
- Start wish, capture `session_id` from `system_ready` event.
- SIGKILL the subprocess after 3 tool calls.
- Re-run with `--session-id <same>` and `--resume`.
- Assert: next event stream does NOT re-execute the first 3 tools.
- Assert: idempotency log (`~/.jellyclaw/sessions/<id>/tools.log`) records
  each tool invocation once.

### `test/integration/crash-recovery.test.mjs`
- Simulate parent Genie server crash (SIGKILL the dispatcher process).
- Orphaned jellyclaw child should either (a) finish gracefully and flush
  trace, or (b) self-terminate within 30s of detecting parent loss via
  `process.ppid === 1`.

---

## 10. Cost accounting validation

After every scenario and comparison test, reconcile billed cost against
provider APIs:

- **Anthropic:** `GET https://api.anthropic.com/v1/organizations/{org}/usage_report`
  filtered to the test window and test API key.
- **OpenRouter:** `GET https://openrouter.ai/api/v1/generation?id={generation_id}`
  (each `usage` event in the stream includes a `generation_id` field).

Assert `|billed - reported| / reported < 0.03` (3% drift allowed for
mid-window rounding).

A whole-CI-run cost accountant runs last and fails the job if total spend
exceeds `$1.00`.

---

## 11. Golden stream-json fixtures + LLM judge

### Golden fixtures
`test/fixtures/stream-json/*.jsonl` are real captured runs, trimmed for size
(drop `thinking_delta`, summarize long `text_delta` batches). Used by:
- Event parser unit tests (feed fixture → assert dispatcher produces correct
  Telegram message sequence).
- Comparison harness baseline.

Update procedure:
```bash
UPDATE_FIXTURES=1 vitest test/fixtures/
# Review diff, commit if intentional.
```

### LLM judge (`test/helpers/llm-judge.mjs`)
Input: `{ wish, expected_tools, expected_result_shape, actual_trace, actual_result }`.
Model: `claude-haiku-4-5` via Anthropic direct.
Prompt asks for a 1-5 score plus a single-sentence rationale. Temperature 0,
max_tokens 200. Schema-enforced JSON output.

Pass threshold: ≥ 4. Failure prints rationale and test fails.

---

## 12. CI workflow

`.github/workflows/test.yml` (abridged):

```yaml
name: test
on: [push, pull_request]
jobs:
  test:
    runs-on: macos-14
    timeout-minutes: 45
    env:
      JELLYCLAW_CONFIG_PATH: ${{ github.workspace }}/test/fixtures/jellyclaw-config
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_TEST_KEY }}
      OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_TEST_KEY }}
      CI_COST_CAP_USD: "1.00"
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - run: ./scripts/build.sh
      - run: ./scripts/apply-patches.sh   # applies patches/001-subagent-hook-fire.patch
      - run: node scripts/start-test-chrome.mjs --port 9333
      - run: npx vitest run test/unit --reporter=verbose
      - run: npx vitest run test/integration --reporter=verbose
      - run: npx vitest run test/scenario --reporter=verbose
      - run: npx vitest run test/comparison --reporter=verbose
      - run: node test/helpers/cost-accountant.mjs   # fails if total > CI_COST_CAP_USD
      - run: node test/helpers/stop-test-chrome.mjs
```

---

## 13. 48h burn-in protocol

Before flipping `GENIE_ENGINE` default to `jellyclaw` in W3:

**Hour 0-24 — shadow mode:**
- `GENIE_ENGINE=claurst` (primary, user-facing).
- Every successful Claurst run triggers a post-hoc jellyclaw replay of the
  same transcript on a second machine / worker pool.
- Diff stored in `traces/shadow-diff-*.json`.
- Target: ≥ 95% semantic-equivalent outcomes (LLM judge) on live traffic.

**Hour 24-48 — primary mode:**
- Flip to `GENIE_ENGINE=jellyclaw` on a single worker.
- Remaining workers stay on Claurst.
- Monitor: success rate, Telegram cadence, median cost per wish, stall count.
- Pass gate: primary worker matches Claurst workers within 2 percentage
  points on success rate and within 25% on cost.

Fail handling: one-line revert (see `integration/GENIE-INTEGRATION.md §8`),
open GitHub issue with the failing transcript and both traces.

---

## 14. 15-item manual acceptance checklist (George)

Run through before W3 cutover. Sign off in an issue.

1. [ ] `jellyclaw --version` prints `1.4.4+jellyclaw.1` or newer.
2. [ ] `launchctl list | grep com.genie.jellyclaw-serve` shows RUNNING.
3. [ ] `curl http://127.0.0.1:7433/health` returns 200.
4. [ ] Say "Genie, build a landing page about coffee" on JellyJelly. Site deploys to `genie-coffee-*.vercel.app`. Telegram receipt delivered.
5. [ ] Say "Genie, DM 3 founders on LinkedIn" (dry-run). Screenshots of 3 drafted DMs on Telegram. No message actually sent (verify in LinkedIn outbox).
6. [ ] Say "Genie, order me an iced latte from Blue Bottle" (dry-run). Checkout page screenshot on Telegram. No order placed (verify Uber Eats order history).
7. [ ] Say "Genie, research the latest on AI regulation". 3+ sources cited in receipt.
8. [ ] Say "Genie, create a $49 Stripe payment link". `buy.stripe.com/...` URL in receipt, link opens.
9. [ ] Say "Genie, fact-check [claim]". 3 subagents fire (visible in Telegram tool stream).
10. [ ] Kill the jellyclaw subprocess mid-wish. Resume with `jellyclaw run --session-id <id> --resume`. Wish completes.
11. [ ] Inspect `traces/dispatch-jellyclaw-*.jsonl` — no `unknown event type` log entries.
12. [ ] Inspect `~/.jellyclaw/sessions/<id>/tools.log` — every tool recorded once.
13. [ ] Verify `config/genie-system.md` skills paths resolve via `~/.claurst/skills/` symlink to `~/.jellyclaw/skills/`.
14. [ ] Flip `GENIE_ENGINE=claurst`, restart server, run wish #4 again. Claurst path still works (rollback verified).
15. [ ] Flip back to `jellyclaw`. Run full 12-wish canonical set over 48h burn-in. All pass.
