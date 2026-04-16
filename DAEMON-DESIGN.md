# DAEMON-DESIGN.md

> Self-iterating Claude Code harness for `jellyclaw-engine`.
> Design only. No code committed yet. Target: ~200 lines of shell + config when built.

---

## 1. Goal + non-goals

**Goal.** A tmux-resident Claude Code process that picks tasks off a local queue, executes each one in an isolated git worktree, writes a result artifact, and stops. It runs while George is asleep or distracted and leaves a review trail. It does **not** try to be autonomous — it's a batch worker with a human review gate at merge time.

**"Continuously iterate" means — three concrete success scenarios:**

1. **Stale-snapshot sweep.** Queue entry: "fix failing vitest snapshots in `test/tui/`." Daemon runs `bun run test`, identifies snapshot mismatches, updates snapshots, re-runs, commits on a `daemon/snapshot-sweep-<ts>` branch, writes result to `DAEMON-JOURNAL.md`. George reviews diff in morning.
2. **TODO(phase-XX) scoped implementation.** Queue entry: "implement TODO(phase-11) in `engine/src/testing/golden.ts`." Daemon reads the TODO + PHASE-11 runbook, writes code + tests, runs `typecheck + lint + test`, commits if green, emits a report.
3. **Weekly progress digest.** Every Sunday 22:00 local, daemon diffs `STATUS.md` + `git log --since="7 days ago"` + open TODOs and writes `reports/weekly-<YYYY-WW>.md`.

**Anti-goals (must NOT do):**

- **Cross-phase scope creep.** CLAUDE.md forbids pulling Phase 4 work into Phase 1; daemon must refuse tasks whose diff touches files outside the declared phase.
- **Unattended merges to `main`.** Daemon never pushes, never merges, never force-anything. All output lives on `daemon/*` branches locally.

---

## 2. Architecture

**tmux session.** Single session `jellyclaw-daemon` with four windows:

| Window | Name | Purpose |
|---|---|---|
| 0 | `ctl` | Control shell. Runs `daemon-loop.sh` (the dispatcher). Prints heartbeat every 60s. |
| 1 | `claude` | Current Claude Code CLI invocation. Dispatcher re-spawns this window per task. |
| 2 | `logs` | `tail -F logs/daemon.jsonl` for live observability. |
| 3 | `repl` | Untouched bash for George to poke around without disturbing the loop. |

Naming: `jellyclaw-daemon:ctl`, `jellyclaw-daemon:claude`, etc. `tmux new-session -d -s jellyclaw-daemon`.

**Claude spawn.** Each task runs:

```
claude --dangerously-skip-permissions \
       --append-system-prompt "$(cat .daemon/SYSTEM-APPEND.md)" \
       -p "$(cat .daemon/tasks/<id>/prompt.md)"
```

`--dangerously-skip-permissions` is required — daemon can't answer prompts. The append file adds hard rules: "you are in daemon mode, no network writes, no git push, no `.env` reads, stop if scope crosses a phase boundary." CLAUDE.md is inherited unchanged (it already encodes phase discipline and coding conventions).

**Queue.** A flat directory `.daemon/tasks/` — one folder per task:

```
.daemon/tasks/
  0001-snapshot-sweep/
    prompt.md          # what Claude should do
    meta.yaml          # phase, branch-prefix, time-cap, token-cap
    status             # pending | running | done | failed
    result.md          # written on completion
    diff.patch         # written on completion
```

This beats GitHub issues (works offline, no auth, one file to grep). `STATUS.md` is read-only to the daemon; it's George's source of truth, not a queue.

**Triggers.** Three ways a task enters the queue:

1. **Manual:** `daemon-enqueue <template-name> [args]` — a 30-line bash script that scaffolds a task dir from `.daemon/templates/`.
2. **Cron (launchd `.plist`):** nightly sweep at 02:00 enqueues `test-triage` if `bun run test` is red; Sunday 22:00 enqueues `weekly-digest`.
3. **File watcher:** `fswatch STATUS.md` — if a line matching `^- \[ \] DAEMON: ` appears, enqueue it. Lightweight, opt-in.

No GitHub polling. Repo is private and George works offline often.

**Isolation.** Git worktree per task: `.daemon/wt/<task-id>/` branched off `HEAD` at enqueue time. Dispatcher `cd`s into the worktree before spawning Claude. Zero risk of clobbering George's dirty working tree. On completion: `git worktree remove` unless task failed (keep for inspection).

---

## 3. Task types

| Type | Trigger | Output | Artifact path | Review |
|---|---|---|---|---|
| `snapshot-sweep` | Cron nightly, or manual | Updated `.snap` files, commit on `daemon/snapshot-<ts>` | `result.md`, `diff.patch` | `git diff daemon/snapshot-<ts>` |
| `test-triage` | Cron nightly if red | Classification of each failure (flaky / real bug / stale / env), no code change | `reports/triage-<ts>.md` | Read file |
| `todo-implement` | Manual, scoped to one `TODO(phase-XX)` | Impl + tests + typecheck/lint clean, commit on `daemon/todo-<slug>` | `result.md` + branch | Diff + local checkout |
| `phase-dod-check` | Manual per phase | Walks the phase's DoD list, ticks boxes, reports gaps | `reports/phase-<NN>-dod.md` | Read file |
| `log-anomaly` | `jellyclaw serve` running, pino jsonl tail | Flags ERROR-level entries and clusters them | `reports/log-<date>.md` | Read file |
| `weekly-digest` | Cron Sunday 22:00 | Diff of STATUS.md, commit log, burn-rate delta | `reports/weekly-<YYYY-WW>.md` | Read file |

All artifacts land under `.daemon/` (gitignored) except branches, which stay in the local repo until George deletes them.

---

## 4. Safety rails

**MUST NOT without explicit human approval:**

- `git push`, `git push --force`, `git reset --hard origin/*`, `git branch -D`, close/merge PRs.
- Write to or read `.env`, `~/.jellyclaw/credentials.json`, or anything matched by the logger redact list.
- Run `bun add`, `bun remove`, `npm install <new>`, or modify `package.json` dependency blocks.
- Network writes beyond the Anthropic API (no Slack, Discord, Linear, webhook POSTs, no `gh` outside read-only queries).
- Touch files outside the declared phase scope (`meta.yaml.phase_paths` allowlist).

Enforcement is two-layer: (a) the append-system-prompt instructs refusal; (b) a post-run `validate.sh` greps the diff for forbidden paths/commands and marks the task `failed` if it sees violations — branch stays for forensics, never auto-deleted.

**Fail loud, not silent.** On any non-zero exit: status → `failed`, write `error.log`, append a red line to `DAEMON-JOURNAL.md`, play the macOS `Sosumi` sound (`afplay /System/Library/Sounds/Sosumi.aiff`). No retries. Human triage only.

**Kill switch (one command):**

```
tmux kill-session -t jellyclaw-daemon && launchctl unload ~/Library/LaunchAgents/com.jellyclaw.daemon.plist
```

Aliased to `daemon-stop`. In-flight Claude process gets SIGTERM; the worktree and partial artifacts persist for review.

**Budget cap.** Anthropic spend is enforced two ways:

1. **Per-task ceiling** in `meta.yaml` (`token_cap: 200000`). Dispatcher passes `ANTHROPIC_MAX_TOKENS` equivalent via task prompt + hard wall-clock timeout (`timeout 1800 claude ...`).
2. **Daily roll-up.** `.daemon/ledger.jsonl` appends `{task_id, input_tokens, output_tokens, usd_est}` after each run (parsed from Claude's final usage report). Before starting a new task, dispatcher sums today's USD. If > `$5` (configurable in `.daemon/config.yaml`), it pauses the queue and writes a notice to `DAEMON-JOURNAL.md`. Resumes at local midnight.

---

## 5. Observability

**Logs.** `logs/daemon.jsonl` (rotated daily via `logrotate`-style bash one-liner at 00:05), one line per event: `{ts, task_id, phase, event, data}`. Events: `enqueue`, `start`, `tool_call`, `commit`, `done`, `failed`, `budget_pause`.

**Journal.** `DAEMON-JOURNAL.md` — human-readable append-only log. One block per task: timestamp, task id, outcome, branch, one-line summary, link to `result.md`. This is what George actually reads.

**Live-ness.** Window 0 prints `heartbeat <ts> queue=<N> today_usd=<X>` every 60s. If tmux session exists + heartbeat line in last 120s → alive. `daemon-status` script wraps this check.

**No Slack, no Discord, no push notifications.** Per George's low-ceremony preference. The macOS sound on failure is the only audible signal.

---

## 6. Bootstrap / teardown

**First-time setup** (run once, from repo root):

```
mkdir -p .daemon/{tasks,wt,templates} logs reports
cp scripts/daemon/* .daemon/            # daemon-loop.sh, daemon-enqueue, validate.sh, SYSTEM-APPEND.md
echo ".daemon/\nlogs/\nreports/" >> .gitignore
cp scripts/daemon/com.jellyclaw.daemon.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.jellyclaw.daemon.plist
```

**Spawn now:**

```
tmux new-session -d -s jellyclaw-daemon -c "$PWD"
tmux send-keys -t jellyclaw-daemon:0 './.daemon/daemon-loop.sh' C-m
tmux rename-window -t jellyclaw-daemon:0 ctl
tmux new-window  -t jellyclaw-daemon   -n claude
tmux new-window  -t jellyclaw-daemon   -n logs   'tail -F logs/daemon.jsonl'
tmux new-window  -t jellyclaw-daemon   -n repl
```

**Attach / detach:** `tmux attach -t jellyclaw-daemon`, then `Ctrl-b d`.

**Tear down cleanly:**

```
daemon-stop                             # kills session + unloads launchd
git worktree prune                      # removes dead worktree refs
# branches left intact; delete with: git branch -D $(git branch --list 'daemon/*')
```

**State that persists across restart:** queue dir, worktrees, `daemon/*` branches, ledger, logs, journal.
**State that does not:** in-flight Claude process (gets killed), tmux window contents, any shell scrollback.

Survives lid-close: launchd re-spawns the tmux session on wake if the loop died. Offline-tolerant: no Anthropic = task `failed` with `network_unreachable`, queue pauses until next heartbeat sees the API reachable again.

---

## 7. First concrete task to feed it

**Task id:** `0001-phase99-smoke`
**Template:** `todo-implement`
**Scope file:** `test/tui/` only.
**Phase:** 99 (Unfucking).

**Prompt (full, copy into `.daemon/tasks/0001-phase99-smoke/prompt.md`):**

> You are running in daemon mode. Read `CLAUDE.md`, `STATUS.md`, and `phases/PHASE-99-unfucking.md` first.
>
> STATUS.md says "Phase 99 Prompt 06 build complete — manual paste-key smoke pending" and that 8 pre-existing `tui.test.ts` spawn-timeouts are untouched. Your task:
>
> 1. Run `bun run test -- test/tui/tui.test.ts`.
> 2. For each of the 8 spawn-timeout failures, classify as: (a) genuinely flaky on this machine, (b) fixable by raising the spawn timeout, (c) real regression.
> 3. If and only if the fix is category (b) AND the change is confined to `test/tui/`, raise the timeout with a justifying comment and re-run until green 3× in a row.
> 4. Run `bun run typecheck && bun run lint`. Must pass.
> 5. Commit on branch `daemon/phase99-smoke-<ts>` with message `test(tui): stabilise spawn timeouts (daemon)`.
> 6. Write `result.md` with: failures-before, classification table, changes made, failures-after.
>
> Hard stops: do NOT touch anything in `engine/src/`, do NOT modify `package.json`, do NOT update snapshots, do NOT create new test files. If any category-(c) failure appears, stop, mark failed, and report.
>
> Token cap: 200k. Wall-clock: 30 min.

This is a good proof-of-concept because: scope is tiny and path-bounded, there's an objective pass/fail (tests green or not), failure modes are understood, and the blast radius is zero.

---

## 8. Honest risk assessment

**Probability this runs well for 2 weeks without George intervening: ~25%.**

It'll work fine for 3–5 days on narrow tasks like snapshot sweeps and digests. The degradation curve bends on anything requiring judgement — a category-(c) flaky vs real-bug call, a cross-cutting refactor, a spec ambiguity in a phase runbook. Claude Code in `--dangerously-skip-permissions` mode tends toward over-confident action when the prompt is under-specified, and queue templates will be under-specified because George writes them in two minutes.

**Most likely failure mode:** a `todo-implement` task where Claude correctly edits the target file but also makes one "helpful" edit in `engine/src/index.ts` to re-export something. `validate.sh` catches it, marks `failed`, branch sits there. After this happens 3× in a row on different tasks George loses trust and stops enqueueing. The daemon doesn't crash — it goes idle and useless, which is worse because it looks alive.

**Secondary failure modes:**

- Token budget blown in one run by a task that loops on typecheck errors it can't resolve. Mitigated by wall-clock + token caps but only after the money is spent.
- Worktree dir fills disk (`node_modules` per worktree × N tasks). Mitigated by `bun install --production=false --frozen-lockfile` and symlinking `node_modules` from main checkout when safe.
- launchd respawn loop if `daemon-loop.sh` has a syntax error. Mitigate with a `StartInterval` floor + exit-code gate.

**Kill criteria — when George should shut it down and go manual:**

1. Three consecutive `failed` tasks without a successful one in between.
2. Any task that produced a diff outside its declared scope, even if validated and rejected — means the prompt contract is leaky.
3. Daily spend > $3 for two days running with <1 accepted branch.
4. He stops reading `DAEMON-JOURNAL.md`. At that point the daemon is producing artifacts nobody reviews, which is the exact failure pattern flagged in the TRU SYNTH mega-analysis (build horizontally, abandon at 60–80%). Kill it, archive `.daemon/`, revisit in 30 days.

**Realistic recommendation:** build the harness at the minimal spec here (~200 lines), run only `snapshot-sweep` and `weekly-digest` for the first week, don't enable `todo-implement` until a week of clean runs. Treat expansion as earned, not assumed.
