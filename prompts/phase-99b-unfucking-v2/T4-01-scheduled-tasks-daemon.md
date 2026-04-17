---
id: T4-01-scheduled-tasks-daemon
tier: 4
title: "Durable scheduler daemon (launchd/systemd user service) with SQLite-persisted jobs"
scope:
  - "engine/src/daemon/scheduler.ts"
  - "engine/src/daemon/scheduler.test.ts"
  - "engine/src/daemon/store.ts"
  - "engine/src/daemon/store.test.ts"
  - "engine/src/daemon/ipc.ts"
  - "engine/src/daemon/ipc.test.ts"
  - "engine/src/cli/daemon.ts"
  - "engine/src/cli/main.ts"
  - "engine/bin/jellyclaw-daemon"
  - "scripts/daemon/com.jellyclaw.scheduler.plist"
  - "scripts/daemon/jellyclaw-scheduler.service"
  - "docs/daemon.md"
depends_on_fix:
  - T0-01-fix-serve-shim
  - T0-02-serve-reads-credentials
tests:
  - name: daemon-boot-and-heartbeat
    kind: jellyclaw-run
    description: "jellyclaw-daemon starts, writes PID file, and emits a heartbeat line within 5s"
    command: "node engine/bin/jellyclaw-daemon --foreground --state-dir /tmp/jc-daemon-$$"
    wait_for_stderr: "scheduler.heartbeat"
    timeout_sec: 10
    teardown: "kill the background process"
  - name: wakeup-fires-within-window
    kind: shell
    description: "a ScheduleWakeup-style job scheduled 10s out fires between t+9s and t+13s and records completion in SQLite"
    command: "bun run test engine/src/daemon/scheduler -t wakeup-fires-10s"
    expect_exit: 0
    timeout_sec: 30
  - name: survives-restart
    kind: shell
    description: "a job whose fire_at is in the future survives a daemon restart (store reload) and still fires"
    command: "bun run test engine/src/daemon/scheduler -t survives-restart"
    expect_exit: 0
    timeout_sec: 45
  - name: sqlite-schema-migrates
    kind: shell
    description: "fresh DB creates the jobs/events tables; opening an existing DB at the current schema_version is a no-op"
    command: "bun run test engine/src/daemon/store -t schema-migrate"
    expect_exit: 0
    timeout_sec: 15
  - name: ipc-enqueue-roundtrip
    kind: shell
    description: "the CLI ipc client can enqueue a job over the unix socket and read it back via list"
    command: "bun run test engine/src/daemon/ipc -t enqueue-and-list"
    expect_exit: 0
    timeout_sec: 20
human_gate: true
max_turns: 90
max_cost_usd: 10
max_retries: 5
estimated_duration_min: 180
---

# T4-01 — Durable scheduler daemon (substrate for ScheduleWakeup / Cron*)

## Context
Claude Code exposes `ScheduleWakeup` (one-shot delayed resume) and `CronCreate`/`CronDelete`/`CronList` (recurring jobs). Both require a process that stays alive across conversation boundaries — an inline timer in the request handler is useless because the handler exits when the turn ends. `DAEMON-DESIGN.md:1-220` sketches a tmux-resident batch worker, but it's task-queue oriented (one-shot shell tasks written into `.daemon/tasks/`), not a clock-driven scheduler with SQLite-persisted job state. This T4-01 delivers the **clock + store + IPC substrate** only. Tool-surface (ScheduleWakeup / Cron*) wiring is T4-02, which depends on this.

Reference material:
- `DAEMON-DESIGN.md:27-36` — tmux topology (we keep the supervised-process idea, drop tmux: the scheduler is a plain forking daemon).
- `DAEMON-DESIGN.md:48-60` — queue-on-disk principle. We swap the flat directory for SQLite so cron expressions + durable "next fire" semantics are tractable.
- `DAEMON-DESIGN.md:91-114` — safety rails (budget, kill switch). We inherit these as constants in the scheduler.
- `package.json:39` — `better-sqlite3` is already a runtime dep.
- `engine/src/cli/main.ts:372-407` — the Commander dispatch pattern used for `jellyclaw` and `jellyclaw-serve`. We add `jellyclaw daemon` and the `jellyclaw-daemon` bin shim the same way.

## Root cause (from audit)
There is no durable timer plane today. Every tool call is bounded by the lifetime of a single agent turn. Any "schedule X for later" tool would have nowhere to write its pending work and nowhere for it to fire from.

## Fix — exact change needed

### 1. `engine/src/daemon/store.ts` — SQLite-backed job store
- Default DB path: `~/.jellyclaw/scheduler.db` (respect `XDG_DATA_HOME` when set — fall back to `$HOME/.jellyclaw/` on macOS, `$XDG_DATA_HOME/jellyclaw/` on Linux). Override with `--state-dir <dir>`.
- Use `better-sqlite3` with `journal_mode = WAL`, `synchronous = NORMAL`, `busy_timeout = 2000`, `foreign_keys = ON`.
- Schema (migration-managed, `schema_version` table):
  ```sql
  CREATE TABLE jobs (
    id             TEXT PRIMARY KEY,         -- ulid
    kind           TEXT NOT NULL,            -- 'wakeup' | 'cron'
    fire_at        INTEGER NOT NULL,         -- unix ms; for cron, next occurrence
    cron_expr      TEXT,                     -- null for wakeup
    payload        TEXT NOT NULL,            -- JSON blob, opaque to scheduler
    created_at     INTEGER NOT NULL,
    last_fired_at  INTEGER,
    fire_count     INTEGER NOT NULL DEFAULT 0,
    status         TEXT NOT NULL,            -- 'pending' | 'running' | 'done' | 'failed' | 'cancelled'
    error          TEXT,
    owner          TEXT NOT NULL             -- session id or 'system'
  );
  CREATE INDEX idx_jobs_fire_at ON jobs (status, fire_at);

  CREATE TABLE job_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id     TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    ts         INTEGER NOT NULL,
    event      TEXT NOT NULL,       -- 'fired' | 'completed' | 'error' | 'skipped'
    detail     TEXT
  );
  ```
- All writes MUST be atomic via `BEGIN IMMEDIATE; …; COMMIT;`. No partial inserts.
- Expose typed API: `insertJob(job)`, `markFiring(id)`, `markDone(id, ts)`, `markError(id, err)`, `listDue(now)`, `listAll(filter?)`, `cancel(id)`, `appendEvent(jobId, event, detail?)`.
- Zod schemas for the typed forms of all rows (respect repo CLAUDE.md convention: "types flow from Zod, not the other way around").

### 2. `engine/src/daemon/scheduler.ts` — the tick loop
- Default tick cadence: **250ms** (so a ScheduleWakeup accuracy budget stays <500ms on a loaded machine).
- On each tick: `store.listDue(Date.now() + 250)` → for each due job:
  1. Atomic `UPDATE … SET status='running' WHERE id=? AND status='pending' RETURNING *` (claim). Skip if the claim affects 0 rows (another tick already claimed it, or it was cancelled).
  2. Emit a `job.fired` record via `appendEvent`.
  3. For `kind='wakeup'`: dispatch to the registered handler (see §3 dispatcher API). On handler return → `markDone`. On throw → `markError`.
  4. For `kind='cron'`: dispatch the handler, then compute next fire time from `cron_expr` using a **local mini-parser** for the five-field cron grammar (`m h dom mon dow`, no seconds, no quartz extensions). Re-insert or update the row with `status='pending'`, new `fire_at`, `fire_count += 1`. No third-party cron lib — implement it in ~120 lines with exhaustive unit tests in `scheduler.test.ts`.
- Emit a structured heartbeat on stderr every 5 seconds: `{"level":20,"msg":"scheduler.heartbeat","pending":N,"due_next_ms":N}` via the existing `engine/src/logger.ts` pino instance.
- Graceful shutdown: on SIGTERM / SIGINT, stop accepting new work, drain running handlers with a 10s timeout, then `process.exit(0)`. Write a final `scheduler.shutdown` log line.

### 3. Dispatcher API (seam for T4-02)
- Export `registerHandler(kind: "wakeup" | "cron", fn: (job: Job) => Promise<void>)` from `scheduler.ts`. T4-02 will register the actual ScheduleWakeup / Cron handlers. This prompt's scope only defines the seam and wires a trivial **noop handler** that writes `{"event":"test.fired","id":job.id}` to stdout so the test harness can assert fires happened. No real agent resume path yet.

### 4. `engine/src/daemon/ipc.ts` — control plane
- Unix domain socket at `<state-dir>/scheduler.sock` (0600 permissions). Length-prefixed JSON frames. Verbs: `enqueue`, `list`, `cancel`, `status`, `shutdown`.
- Each frame envelope: `{ "id": string, "verb": string, "params": unknown }` → response `{ "id": string, "ok": boolean, "result"?: unknown, "error"?: { "code": string, "message": string } }`.
- Zod-validate both directions. Unknown verb → `{ code: "unknown_verb" }`.
- Client helper `ipcClient(socketPath)` exposes typed methods matching the verbs — this is what T4-02 will import.

### 5. `engine/src/cli/daemon.ts` + `engine/bin/jellyclaw-daemon`
- `jellyclaw daemon start [--foreground] [--state-dir <dir>]` — if not `--foreground`, double-fork and detach; write PID to `<state-dir>/scheduler.pid`.
- `jellyclaw daemon stop` — reads PID file, sends SIGTERM, waits up to 10s for exit, then SIGKILL.
- `jellyclaw daemon status` — opens the socket, issues `status`, prints `{pid, pending, running, uptime_s, db_path}` as JSON (or human-readable with `--pretty`).
- `jellyclaw daemon tail` — subscribes over the socket to a live `job_events` stream (implement via a `subscribe` verb that sends newline-delimited event JSON).
- The `jellyclaw-daemon` shim mirrors T0-01's pattern: basename-dispatch at `engine/src/cli/main.ts:372` — if `basename(process.argv[1]) === "jellyclaw-daemon"`, prepend `"daemon"` to argv and extend the `invokedDirectly` guard at `engine/src/cli/main.ts:391-402` with `entry.endsWith("/bin/jellyclaw-daemon")`.

### 6. Launchd + systemd unit files
- `scripts/daemon/com.jellyclaw.scheduler.plist` — `RunAtLoad=true`, `KeepAlive=true`, `ProgramArguments = [<bin>/jellyclaw-daemon, start, --foreground]`, `StandardErrorPath = ~/Library/Logs/jellyclaw/scheduler.stderr`, `StandardOutPath = …/scheduler.stdout`. Label: `com.jellyclaw.scheduler`.
- `scripts/daemon/jellyclaw-scheduler.service` (systemd user unit) — `ExecStart=%h/.local/bin/jellyclaw-daemon start --foreground`, `Restart=on-failure`, `RestartSec=5`, `Environment=XDG_DATA_HOME=%h/.local/share`. `WantedBy=default.target`.
- `docs/daemon.md` — install steps for both platforms (`launchctl bootstrap gui/<uid> <plist>` / `systemctl --user enable --now jellyclaw-scheduler`), uninstall, log-paths, and the `jellyclaw daemon status` verification sequence.

### 7. Tests
- `store.test.ts` — schema migration; insert/cancel/listDue ordering; wal checkpoint after 100 jobs; concurrent writer coordination via `BEGIN IMMEDIATE` under `Promise.all`.
- `scheduler.test.ts` — `wakeup-fires-10s` (inject fake clock; assert the registered handler was called with the right payload between +9s and +13s of scheduled fire); `survives-restart` (insert a future job, close the scheduler, reopen with a new instance, advance clock, assert fire); `cron-expression-parser` (table-driven vs a reference set of 20 expressions including `*/5 * * * *`, `0 */2 * * *`, `0 0 * * 1-5`, day-of-week boundary, DST transition skipped).
- `ipc.test.ts` — enqueue a job over the socket, read it back via `list`, cancel, verify `status` drops. Spawn the scheduler in-process on an ephemeral socket path.

## Acceptance criteria
- `jellyclaw daemon start --foreground --state-dir <tmp>` binds a socket, writes a PID file, and emits `scheduler.heartbeat` on stderr within 5 seconds (maps to `daemon-boot-and-heartbeat`).
- A job scheduled 10 seconds out fires within the ±3s accuracy budget and `job_events` records both `fired` and `completed` rows (maps to `wakeup-fires-within-window`).
- Closing and reopening the scheduler with the same `--state-dir` preserves pending jobs (maps to `survives-restart`).
- Migration of an existing DB is a no-op at the current schema version (maps to `sqlite-schema-migrates`).
- CLI `jellyclaw daemon status` returns JSON that includes `pid`, `db_path`, and `pending` count.
- `bun run typecheck` + `bun run lint` + full suite pass.

## Out of scope
- **Do NOT** implement `ScheduleWakeup` / `CronCreate` / `CronDelete` / `CronList` tool surfaces — that is T4-02's responsibility. Register a noop handler only.
- Do NOT touch `engine/src/agents/loop.ts` or the tool registry.
- Do NOT add new runtime dependencies beyond what's in `package.json`. `better-sqlite3`, `pino`, `commander`, `zod` are already present.
- Do NOT implement any notification sinks (push, email, Slack) — the scheduler only fires local handlers.
- Do NOT implement `jellyclaw daemon install` / `uninstall` launchd plumbing; the plist + service files are shipped as docs-only scaffolding in this prompt.

## Verification the worker should self-run before finishing
```bash
bun run typecheck
bun run lint
bun run test engine/src/daemon
node engine/bin/jellyclaw-daemon start --foreground --state-dir /tmp/jc-daemon-selfcheck &
sleep 2
node engine/bin/jellyclaw daemon status --state-dir /tmp/jc-daemon-selfcheck
kill %1 && wait 2>/dev/null || true
rm -rf /tmp/jc-daemon-selfcheck
```
