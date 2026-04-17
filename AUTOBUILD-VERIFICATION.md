# Autobuild Rig Verification Report — 2026-04-17

## TL;DR

The rig starts, stops, tests-pass-under-dry-run, and processes `state.queue` correctly — but it is **not ready to complete T0-02…T0-05 autonomously**. Three concrete defects make this a loaded gun: `queue.json` is never reconciled into `state.queue`, `pipePane` is called before `tmux new-session` (so every real spawn fails on a fresh macOS with no tmux server), and there is no retry logic at all — one test-flake = permanent escalation. Confidence that a real kick-off right now completes T0-02 clean: **2/10**.

## Environment

| Item | Value |
| --- | --- |
| Node | v25.6.0 |
| Bun | 1.3.5 |
| tmux | 3.6a |
| Python (for YAML checks) | 3.14.2 |
| Repo HEAD | `4c8ced9b61671856176e47e4c8a18f755c64dd87` (commit `4c8ced9`) |
| Working tree | dirty (dashboard files modified, see `git status`) |
| Dashboard backend | port 5174 (tsx watch, PID 50100 at session start) |
| Dashboard frontend | port 5173 (vite, PID 36966) |
| Report generated | 2026-04-17T06:49Z |

---

## Phase 1 results (static)

| Check | Result | Evidence |
| --- | --- | --- |
| `.autobuild/state.json` parses & has expected shape | PASS | Parsed JSON, keys: rig_version, rig_heartbeat, concurrency, paused, halted, daily_budget_usd, runs, queue, completed, escalated. `runs.T0-01` has `status: complete`, `tests: 2/2 passed`, `commit_sha: "manual"`. |
| `.autobuild/queue.json` lists 4 remaining T0 prompts | PASS (contents), FAIL (dispatcher never reads it) | `{ "order": [ "T0-02-serve-reads-credentials", "T0-03-fix-hardcoded-model-id", "T0-04-thread-cli-flags", "T0-05-gitignore-autobuild-dirs" ] }`. But see [Finding #1](#finding-1-queuejson-is-dead-code). |
| T0-01…T0-05 YAML frontmatter valid | PASS | All five parsed by `yaml.safe_load`. All include `id`, `tier`, `scope`, `tests`, `max_turns`, `max_cost_usd`, `max_retries`. `kind` is a per-test field, not top-level — the protocol's python check was probing the wrong key. |
| `node engine/bin/jellyclaw-serve --help` | PASS | Prints "Usage: jellyclaw serve [options]" with full option list, exits 0. T0-01 fix is live in working tree. |
| `node engine/bin/jellyclaw --help` | PASS | Full CLI help prints; all subcommands discoverable. |
| `curl http://127.0.0.1:5174/api/runs` | PASS | JSON envelope with `rig_version`, `runs`, `queue`, `rig_process`, `runs_array`, `count`. Matches the route factory in `dashboard/server/src/routes/runs.ts`. |
| `node scripts/autobuild/bin/autobuild status` | PASS | Pretty summary prints. Before queuing: `queue (0)`. After `queue add`: `queue (4)`. |
| `node scripts/orchestrator/jc help` | PASS | Full command list prints (`status`, `ps`, `pause`, `halt`, `abort`, `rerun`, `budget`, etc.). |

---

## Phase 2 results (dry-run tick)

1. **First tick with empty `state.queue`** (`AUTOBUILD_DRY_RUN=1 autobuild tick`):
   ```json
   { "heartbeat": "2026-04-17T06:46:01.867Z",
     "actions": [ { "kind": "idle", "reason": "no_queued" } ] }
   ```
   Rig is idle even though `queue.json` has 4 items — because the dispatcher only consults `state.queue`.

2. **After `autobuild queue add` for all 4**, re-run the dry-run tick:
   ```json
   { "actions": [
       { "kind": "spawned", "id": "T0-02-serve-reads-credentials" },
       { "kind": "ran_tests", "id": "T0-02-serve-reads-credentials" } ] }
   ```
   Dry-run correctly synthesized a `{type:"result"}` event and short-circuited to the tester.

3. **Session artifacts written to `.autobuild/sessions/1f38454f…`:**
   `prompt.md`, `startup-context.md`, `events.ndjson` (one fake `result` line), `transitions.ndjson`, `test-results.json`.

4. **The dry-run tester ran REAL acceptance tests** (not stubs):
   - `serve-starts-with-creds-file` FAILED: the prompt declares `--port 0` which `parsePort` in `engine/src/cli/serve.ts:117` rejects. Output: `jellyclaw: invalid --port: "0" (must be 1..65535)`.
   - `serve-errors-with-no-creds` PASSED (just asserts a non-zero exit).
   Consequence: the dry-run smoke escalated T0-02 to `failed` immediately, even though the rig-level transport logic was fine. This is a design choice (run real tests in dry-run), but the fixture port is invalid.

---

## Phase 3 results (API → rig)

1. `POST /api/rig/running` → **404 Not Found**. The route is GET-only; the test-protocol instruction called POST. `GET /api/rig/running` returns `{"running":false,…}` correctly.

2. `POST /api/rig/tick` → 200, fires a real subprocess:
   ```json
   {"exit_code":0,"ok":true,
    "report":{"actions":[{"kind":"idle","reason":"no_queued"}]},
    "stdout":"...","stderr":""}
   ```
   Correctly shells out to `scripts/autobuild/bin/autobuild tick`.

3. `POST /api/rig/start` → `{ "running":true, "pid":61016, "since":"2026-04-17T06:47:13.490Z", "log_path":".../logs/dispatcher.jsonl" }`. Daemon spawned, PID written to `.orchestrator/dispatcher.pid`, log file appended to `logs/dispatcher.jsonl`. **Start works.**

4. Within ~5 seconds the daemon burned through all 3 remaining queued prompts and escalated them. State at that moment:
   - `T0-02` already `failed` from the earlier dry-run.
   - `T0-03`, `T0-04`, `T0-05` all `escalated` with identical error:
     `Command failed with exit code 1: tmux pipe-pane ... no server running on /private/tmp/tmux-501/default`
   - This is [Finding #2](#finding-2-pipepane-called-before-tmux-server-exists).

5. `GET /api/runs` still returned 200 and reported `queue: []` — correctly reflects the drained-and-escalated state.

6. `logs/dispatcher.jsonl` received the daemon output:
   ```
   [02:47:13.732] INFO autobuild dispatcher starting
   [02:47:13.832] ERROR spawn failed id=T0-03-fix-hardcoded-model-id …
   [02:47:15.896] ERROR spawn failed id=T0-04-thread-cli-flags …
   [02:47:17.961] ERROR spawn failed id=T0-05-gitignore-autobuild-dirs …
   ```
   Logging pipeline **works**.

7. `POST /api/rig/stop` → `{ "running":false, "stopped_at":"2026-04-17T06:47:23.404Z" }`. Subsequent GET confirms stopped.

8. PID file cleaned up: `.orchestrator/dispatcher.pid` removed.

**Collateral damage from the start/stop test:**
- git HEAD left on `autobuild/T0-05-gitignore-autobuild-dirs`; git-warden created and checked out three branches (`T0-03`, `T0-04`, `T0-05`) then abandoned them mid-workflow. I manually `git checkout main` after the test — those stranded branches still exist.
- Three session directories (`aac0f47e…`, `4c88d660…`, `d9cf1eb7…`) now exist with only `prompt.md`, `startup-context.md`, and a single-line `transitions.ndjson` ending at `spawning`. No `events.ndjson`, no `test-results.json`.

---

## Phase 4 results (prompt execution)

- `~/.jellyclaw/credentials.json` exists and contains an `anthropicApiKey` starting `sk-ant-api…`. Credentials path works.
- `ANTHROPIC_API_KEY` is NOT set in the process environment. So T0-02 would actually test something useful if the harness could run.
- **I did NOT spawn a real Claude Code worker.** Phase 4 was completed entirely via dry-run. Real spawn would have tripped the `pipePane`-before-`new-session` bug on this host anyway (tmux daemon is not running).
- No API credit spent beyond the `$0.01` that was already on `T0-01`. Final `daily_budget_usd.spent`: `0.02` (the second cent is the synthetic `$0.01` dry-run cost event).

---

## Phase 5 results (tests)

| Suite | Result | Notes |
| --- | --- | --- |
| `node --test scripts/autobuild/test/*.test.mjs` | **16/16 PASS** (327 ms) | budget-gate, budget-kill, state, prompt-parser, completion-log-format, smoke-dispatch. Coverage is good for the *happy path*. |
| `node --test scripts/orchestrator/test/{jc-commands,grid-render}.test.mjs` | **26/26 PASS** (2.5 s) | Tests cover CLI parsing + grid rendering. |
| `node engine/test/smoke/run-smoke.mjs --output json` | **PASS** | All 5 smoke suites green (`smoke-01-wish-hello` through `smoke-05-http-roundtrip`). |
| `bun run test:unit` (dashboard) | **2 / 54 FAIL** | `server/tests/routes/runs.test.ts`: test expects `body.runs` to be an array `[]`, but the route returns `runs` as a keyed `Record` and a separate `runs_array`. Looks like the route contract changed after the test was last updated. |
| `bun run typecheck` | **FAIL** | `src/components/autobuild-v3/logic.ts(23,3)` and `(261,14)`: `autoSelectRunId` is re-exported from v2 on line 23 **and** redeclared as `export const autoSelectRunId = autoSelectRunIdV2` on line 261. `TS2323: Cannot redeclare exported variable`. |
| `bun run build` | **FAIL** | Same TS error kills the build before Vite ever runs. |

---

## Phase 6 results (dashboard UI liveness)

1. `curl http://127.0.0.1:5173/` → 1172-byte SPA index.html with Vite HMR scripts, title `jellyclaw engine · dashboard`. Frontend is up.
2. `/tmp/jc-dashboard.log` exists and is being written to. Every SSE heartbeat (once per second) produces:
   ```
   Error [ERR_HTTP_HEADERS_SENT]: Cannot write headers after they are sent …
       at responseViaResponseObject (…/@hono/node-server/…)
   ```
   Non-fatal (request still returns 200) but noisy and suggests an unreleased response in the `/api/events` SSE handler or one of the wrappers.
3. Both processes alive (`ps aux` confirms `tsx watch`, `vite`, `esbuild --service`).

---

## Phase 7 — Honest assessment

### What works

- **`autobuild queue add <id>`** — validates frontmatter, mutates `queue.json` + `state.queue`, atomic writes.
- **`autobuild tick` / `autobuild status`** — work exactly as documented.
- **`jc` CLI** — full help surface, 26/26 unit tests green, all inbox-writing commands functional.
- **Dry-run path** — dispatcher correctly short-circuits to `completion_detected` without spawning claude, then actually runs the tester. Fixture test (`smoke-dispatch.test.mjs`) is a full end-to-end check.
- **Dashboard `/api/rig/start|stop|tick|running`** — atomic PID file with exclusive `wx` lock, lifecycle transitions, log rotation, cleanup on stop. This route is well-engineered.
- **Budget accounting** — $5 self-check gate and $10 hard-kill threshold have dedicated unit tests that pass; the code paths exist in `pollCostUntilResult`.
- **State atomicity** — `state.mjs` uses tmp-file + rename + `.lock` (`wx` open); `concurrent updates do not lose writes` test passes.
- **Test runner covers four kinds** — `shell`, `jellyclaw-run`, `smoke-suite`, `http-roundtrip`. All invoke real commands.
- **Completion-log append** — `appendCompletionLogEntry` idempotent per prompt; dedicated 5/5 tests passing.

### What works but flaky

- **Dashboard SSE endpoint** — returns data, but every heartbeat spews `ERR_HTTP_HEADERS_SENT` to stderr. Implies a `res.json()` or double-write somewhere in the `/api/events` middleware chain.
- **`pollCostUntilResult` in real mode** — never exercised because the first real-spawn attempt dies before a worker is born; semantically the logic looks fine but is untested end-to-end.
- **T0-01 was reported `complete` with `commit_sha: "manual"` and `turns_used: 0`** — meaning a human applied the fix, then manually flipped state. The rig never proved it could autonomously land even one prompt.

### What silently fails

- **`.autobuild/queue.json` is dead code in the dispatcher**. `readQueueFile()` is defined at `scripts/autobuild/dispatcher.mjs:83` but never called by `tickOnce` / `spawnWorker` / `runForever`. The only reader is `autobuild queue list`. So if you bootstrap `queue.json` externally (e.g. from a phase-kickoff script), the rig ignores it and reports "idle — no_queued." This is exactly the state the repo was in when this verification started. See [Finding #1](#finding-1-queuejson-is-dead-code).

- **`depends_on_fix` is parsed but never enforced.** `prompt-parser.mjs:31` extracts the list; no consumer reads it. T0-02 declares `depends_on_fix: [T0-01]`, T0-03 declares T0-02, etc. If the rig were ever allowed to run out-of-tier or out-of-dependency, it would happily do so. Today the tier-ordering logic in `pickNextQueued` (`dispatcher.mjs:212`) gives the illusion of dependency enforcement because T0-01…T0-05 are all T0, but **within a tier there is no ordering guarantee**.

- **`max_retries` is a lie.** Every prompt frontmatter declares `max_retries: 5`. State records `attempt: 1`, `max_retries: 5`, `retry_history: []`. But the dispatcher has exactly ONE reference to `attempt` (the inbox `rerun` path, `dispatcher.mjs:187`). No test-failure auto-retry. No retry_history append. README admits this ("No retries. Fail → escalate.") but the schema pretends otherwise — frontmatter authors will assume retries work.

- **Human-gate (`human_gate: false`) is unread.** No consumer.

- **Dashboard `runs` contract drift.** Frontend (v3 logic.ts) has a duplicate `autoSelectRunId` export. The backend route unit tests assume `body.runs` is an array; it is not. Neither breaks at runtime today because the frontend uses `runs_array`, but the tests + typecheck + build are all red. This is the kind of rot that tells you the CI pipeline isn't green — which means the autobuild rig can't rely on `bun run typecheck` as a health check.

### What's fully broken

- **Real-mode spawn on any host where tmux is not already running** (macOS default). `spawnWorker` at `dispatcher.mjs:318` calls `pipePane(tmux, tmuxLog)` BEFORE `newDetachedSession(...)` on line 319. `tmux pipe-pane` requires an existing session — if the tmux daemon isn't up, it errors `no server running on /private/tmp/tmux-501/default`. The outer try/catch in `tickOnce` swallows this and escalates the prompt. Evidence:
  ```
  Command failed with exit code 1: tmux pipe-pane -o -t jc-worker-T0-03-fix-hardcoded-model-id-ca67
  'cat >> …/tmux.log'   no server running on /private/tmp/tmux-501/default
  ```
  Reproduction: kill tmux, `autobuild queue add <any>`, `autobuild tick` without `AUTOBUILD_DRY_RUN=1`. See [Finding #2](#finding-2-pipepane-called-before-tmux-server-exists).

- **Stranded branches + sessions after escalation.** Even after a clean `rig/stop`, the dispatcher leaves `autobuild/T0-03`, `autobuild/T0-04`, `autobuild/T0-05` branches behind and abandons git HEAD on whichever branch it was last on. No cleanup hook. If the user does not `git checkout main` before the next session, everything goes sideways.

- **T0-02 tests are unrunnable as written.** Frontmatter specifies `--port 0` (the conventional "pick any free port" sentinel), but `parsePort` explicitly rejects 0 with "must be 1..65535" (`engine/src/cli/serve.ts:117`). Even a perfect fix of `serve.ts` will fail the `serve-starts-with-creds-file` test. The tester has a `pickFreePort()` helper for `http-roundtrip` tests but not for `jellyclaw-run` tests.

- **TypeScript build and unit tests red.** `bun run build` and `bun run typecheck` both fail on the duplicate export in `autobuild-v3/logic.ts`. `server/tests/routes/runs.test.ts` has 2 failures that look like drift between the route's return shape and the test's expectations.

- **`POST /api/rig/running`** returns 404 — the route is `GET` only. Minor; the test protocol used POST but GET is the correct verb. Noted here because the test plan specified POST.

---

## Recommendations

1. **(P0) Fix the tmux ordering bug.** Swap `dispatcher.mjs:318-320`: first `newDetachedSession(tmux, repoRoot(), cliCmd)`, then `pipePane(tmux, tmuxLog)` once. Or add a try/catch around the first `pipePane` call and retry post-`new-session`. Without this fix, every real-mode run on a fresh host fails immediately.

2. **(P0) Fix or remove `queue.json`.** Either make `tickOnce` call `readQueueFile()` and reconcile into `state.queue` at startup (authoritative queue.json → state), or delete `queue.json` and its helpers and make `state.queue` the sole source. The current split-brain is the reason the repo arrived at verification time with 4 queued prompts invisible to the rig.

3. **(P0) Fix T0-02 port fixture.** Either change `parsePort` to accept 0 as "ephemeral" (preferred — matches every other Node HTTP tool), or change the prompt to use `--port 8766` or template `${PORT}` as `http-roundtrip` tests do.

4. **(P1) Implement `max_retries` (or delete it).** If failed tests should retry, add auto-requeue in `runTestsForPrompt` up to `attempt < max_retries`. If not, strip the field from every prompt frontmatter so authors aren't misled.

5. **(P1) Enforce `depends_on_fix`.** `pickNextQueued` should skip a prompt whose `depends_on_fix` list isn't fully in `state.completed`.

6. **(P1) Green up `bun run typecheck` + `bun run test:unit`.** The autobuild rig's own acceptance tests frequently invoke these. If the baseline is red, failures are ambiguous (rig's fault or pre-existing?). Dedup the `autoSelectRunId` export. Update `runs.test.ts` to match the current route contract (use `body.runs_array`).

7. **(P1) Add cleanup-on-stop.** On `/rig/stop`, kill any running tmux session, check out `main`, optionally delete empty `autobuild/T*` branches.

8. **(P2) Silence SSE `ERR_HTTP_HEADERS_SENT` warnings** in the dashboard backend. Either downgrade to a single log, or fix the double-write in the `/api/events` handler.

9. **(P2) Prove autonomy on T0-01.** The fact that the only "complete" run has `commit_sha: "manual"` means the rig has never closed a real prompt. Until it does, the 2/10 confidence score is warranted.

---

## Findings (canonical)

### Finding #1: queue.json is dead code

- **File**: `scripts/autobuild/dispatcher.mjs:83-95` — `readQueueFile` / `writeQueueFile` defined.
- **Evidence**: `rg 'readQueueFile'` → 0 callers inside `dispatcher.mjs`. The only write is `initAutobuild()` creating an empty file if missing (`dispatcher.mjs:102`).
- **Reproduction**: populate `.autobuild/queue.json` with `{"order":["T0-02-..."]}`, run `autobuild tick` — the rig reports `"idle / no_queued"` because `state.queue` is empty.

### Finding #2: pipePane called before tmux server exists

- **File**: `scripts/autobuild/dispatcher.mjs:318-320`.
- **Code**:
  ```js
  await pipePane(tmux, tmuxLog);
  await newDetachedSession(tmux, repoRoot(), cliCmd);
  await pipePane(tmux, tmuxLog);
  ```
- **Evidence**: `logs/dispatcher.jsonl` at 06:47:13–17 shows three back-to-back `spawn failed` entries, all with `no server running on /private/tmp/tmux-501/default`. `pipePane` in `scripts/autobuild/lib/tmux.mjs:36-39` is NOT wrapped in a try/catch (unlike `killSession`).

### Finding #3: typecheck + unit tests red

- **Files**: `dashboard/src/components/autobuild-v3/logic.ts:23` and `:261`; `dashboard/server/tests/routes/runs.test.ts:85,122`.
- **Reproduction**: `cd dashboard && bun run typecheck` and `cd dashboard && bun run test:unit`.

---

## Confidence

**2 / 10** — the rig has solid bones (state atomicity, budget gates, tester plumbing, `/api/rig/*` lifecycle, pid-file locking) and its own unit tests are green. But between the three P0 defects, **a real kick-off of T0-02 right now would fail within 10 seconds** (either on the `--port 0` fixture or on the tmux ordering bug, depending on whether tmux was already running), and nothing in the rig would retry. The rig also has no feedback loop to alert the human that it's wedged — `autobuild status` just says `queue (0)` and `escalated (4)`, which a casual observer could mistake for "done."
