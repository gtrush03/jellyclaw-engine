---
id: T4-02-schedule-wakeup-cron-tools
tier: 4
title: "ScheduleWakeup + CronCreate/CronDelete/CronList tools on top of the scheduler daemon"
scope:
  - "engine/src/tools/schedule-wakeup.ts"
  - "engine/src/tools/schedule-wakeup.test.ts"
  - "engine/src/tools/cron.ts"
  - "engine/src/tools/cron.test.ts"
  - "engine/src/tools/index.ts"
  - "engine/src/daemon/handlers/resume.ts"
  - "engine/src/daemon/handlers/resume.test.ts"
  - "engine/src/daemon/scheduler.ts"
  - "docs/tools/scheduling.md"
depends_on_fix:
  - T4-01-scheduled-tasks-daemon
  - T2-01-wire-mcp-tools-into-loop
tests:
  - name: schedule-wakeup-fires
    kind: shell
    description: "ScheduleWakeup with delaySeconds=60 schedules a job in SQLite with fire_at within ±2s of now+60s"
    command: "bun run test engine/src/tools/schedule-wakeup -t schedules-correctly"
    expect_exit: 0
    timeout_sec: 30
  - name: cron-create-fires-on-schedule
    kind: shell
    description: "CronCreate with expression '*/1 * * * *' fires once in a 90s fake-clock window"
    command: "bun run test engine/src/tools/cron -t fires-on-schedule"
    expect_exit: 0
    timeout_sec: 60
  - name: cron-list-returns-jobs
    kind: shell
    description: "CronList returns all cron jobs owned by the current session with expression, next_fire_at, fire_count"
    command: "bun run test engine/src/tools/cron -t list-returns-owned"
    expect_exit: 0
    timeout_sec: 30
  - name: cron-delete-cancels
    kind: shell
    description: "CronDelete removes a job from the store; subsequent CronList does not return it"
    command: "bun run test engine/src/tools/cron -t delete-cancels"
    expect_exit: 0
    timeout_sec: 30
  - name: survives-daemon-restart
    kind: shell
    description: "a ScheduleWakeup scheduled before daemon restart still fires after restart"
    command: "bun run test engine/src/daemon/handlers/resume -t survives-restart"
    expect_exit: 0
    timeout_sec: 60
  - name: tools-registered-in-index
    kind: shell
    description: "listTools() includes ScheduleWakeup, CronCreate, CronDelete, CronList"
    command: "bun run test engine/src/tools -t scheduling-tools-registered"
    expect_exit: 0
    timeout_sec: 20
human_gate: true
max_turns: 80
max_cost_usd: 10
max_retries: 5
estimated_duration_min: 150
---

# T4-02 — ScheduleWakeup + Cron* tools

## Context
T4-01 landed the scheduler daemon and left a handler-registration seam (`registerHandler(kind, fn)`). This prompt delivers the tool-surface side: four new builtins — `ScheduleWakeup`, `CronCreate`, `CronDelete`, `CronList` — that invoke the daemon over its IPC socket, plus a real "resume" handler that replays the attached prompt back through the agent loop when a job fires.

Reference material:
- `engine/src/daemon/ipc.ts` (shipped in T4-01) — the client used by these tools.
- `engine/src/daemon/scheduler.ts` (shipped in T4-01) — the handler registration point; this prompt replaces the noop handler with a real one.
- `engine/src/tools/index.ts` — where builtin tools are registered. All four new tools register here alongside Bash/Read/Grep/etc.
- `engine/src/agents/loop.ts:48-79` — `AgentLoopOptions`. The resume handler calls into the same loop with a continuation payload.
- Claude Code's own surface: `ScheduleWakeup({ delaySeconds, prompt, reason })`, `CronCreate({ expression, prompt, reason })`, `CronDelete({ id })`, `CronList()`. We match this exactly.

## Root cause (from audit)
Without these tools, agents have no way to produce durable follow-ups. Every "check back in 20 minutes" request today either blocks with a sleep (wastes budget) or is silently forgotten. Claude Code's scheduling surface is one of the three load-bearing features we haven't yet shipped.

## Fix — exact change needed

### 1. `engine/src/tools/schedule-wakeup.ts` — one-shot delayed resume
- Tool definition exported under name `ScheduleWakeup`. Zod input schema:
  ```ts
  z.object({
    delaySeconds: z.number().int().min(60).max(3600),
    prompt:       z.string().min(1).max(8192),
    reason:       z.string().min(1).max(512),
  })
  ```
- Clamps match the Claude Code spec verbatim: [60, 3600] seconds. Output: `{ job_id: string, fire_at_unix_ms: number }` (Zod output schema too — validate both ends).
- Implementation opens the ipc client (reuse `engine/src/daemon/ipc.ts`), calls `enqueue` with kind `"wakeup"`, payload `{ prompt, reason, owner_session, model_hint }`. Owner comes from `AgentLoopOptions.sessionId` — requires threading `sessionId` into `ToolContext` (already done for hooks — follow the same pattern).
- Failure mode: if the daemon socket is not reachable (file missing, ECONNREFUSED), throw `ToolError` with `code: "daemon_unreachable"` and a user-readable message ("run `jellyclaw daemon start` or install the launchd/systemd unit; see docs/daemon.md").

### 2. `engine/src/tools/cron.ts` — three tools
- `CronCreate` input:
  ```ts
  z.object({
    expression: z.string().regex(/^(\S+\s+){4}\S+$/, "5-field cron"),
    prompt:     z.string().min(1).max(8192),
    reason:     z.string().min(1).max(512),
  })
  ```
  Output: `{ job_id: string, next_fire_at_unix_ms: number }`. Call `store.insertJob` via ipc with `kind: "cron"`, `cron_expr: expression`, compute `fire_at = nextOccurrence(expression, now)` using the T4-01 parser.
- `CronDelete` input: `{ id: string }`. Sends `cancel` verb; only the owner session may cancel — the daemon enforces this in §4 below. Unknown id → `ToolError("unknown_job")`. Not owned → `ToolError("forbidden")`.
- `CronList` input: `{}`. Returns `Array<{ id, expression, prompt, reason, next_fire_at_unix_ms, fire_count, last_fired_at_unix_ms?, status }>`, filtered to the current session's `owner`. Pagination is not needed at this tier — Zod `.array().max(500)`.

### 3. Registration in `engine/src/tools/index.ts`
- Append all four tools to the builtin registry in the same pattern existing tools use. Preserve alphabetical order where current code maintains it; otherwise append.
- Gate behind a single shared helper `requireScheduler(ctx)` that lazy-connects the ipc client once per session and caches the socket path (default `<state-dir>/scheduler.sock`; override via `JELLYCLAW_SCHEDULER_SOCKET` env var).

### 4. `engine/src/daemon/handlers/resume.ts` — the real job handler
- Replace T4-01's noop handler with one that:
  1. Reads the stored payload (`{ prompt, reason, owner_session, model_hint }`).
  2. Spawns a fresh agent turn by invoking a shared `continueSession(sessionId, prompt, reason)` helper that wraps `runAgentLoop`. If the owner session's transcript still exists on disk under `~/.jellyclaw/sessions/<id>/`, the new turn appends to it; if not (session was GC'd), it starts a new session with a header referencing the scheduled job's id.
  3. On completion writes `job_events.completed`; on thrown error writes `job_events.error` with a truncated stack.
  4. Respects the daily budget cap inherited from `DAEMON-DESIGN.md:107-114` — check `ledger.jsonl` before firing; if over cap, write `job_events.skipped` with reason `budget_exceeded` and re-schedule the job for the next UTC day (cron jobs advance to their next legitimate fire; wakeup jobs are marked `failed` with `error="budget_exceeded"` and NOT re-queued).
- Ownership enforcement for `CronDelete`: add an `owner` match to the `cancel` verb's WHERE clause in `engine/src/daemon/ipc.ts` (requires a small edit to the IPC verb handler shipped by T4-01 — this is allowed by scope-glob because `scheduler.ts` is in-scope).

### 5. Owner-scoping in the scheduler
- `store.listAll({ owner })` filter required — confirm T4-01 shipped this; if not, add. The worker may edit `engine/src/daemon/scheduler.ts` to thread the `owner` filter if T4-01's implementation omitted it.
- The `list` IPC verb accepts an optional `owner` param and a system-wide `--all` flag (CLI only, not tool-accessible).

### 6. `docs/tools/scheduling.md`
- One-page reference: tool names, input schemas (from Zod), example call sequences, and the failure-mode table:
  | Error code            | Meaning                                              | User action                                    |
  | --------------------- | ---------------------------------------------------- | ---------------------------------------------- |
  | `daemon_unreachable`  | Scheduler socket missing or connection refused       | `jellyclaw daemon start` (or install service)  |
  | `invalid_expression`  | Cron expression failed to parse                      | Fix to 5-field `m h dom mon dow`               |
  | `unknown_job`         | `CronDelete`/`CronList` target id not found          | Check id via `CronList`                        |
  | `forbidden`           | Attempted to act on a job owned by another session   | —                                              |
  | `budget_exceeded`     | Daily spend cap hit (see DAEMON-DESIGN.md)           | Wait until UTC midnight                        |

### 7. Tests
- `schedule-wakeup.test.ts`: `schedules-correctly` asserts the enqueue payload. Uses a fake ipc client that records calls.
- `cron.test.ts`: `fires-on-schedule` boots a real daemon on an ephemeral socket + fake clock, creates `*/1 * * * *`, advances 90s, asserts exactly one fire. `list-returns-owned` asserts the owner filter. `delete-cancels` verifies post-delete `list` is empty.
- `handlers/resume.test.ts`: `survives-restart` — create a wakeup 30s out, stop the daemon, restart, advance fake clock, assert the resume handler ran exactly once.
- `tools/index.test.ts` (or the existing equivalent): `scheduling-tools-registered` — `listTools()` includes all four by name.

## Acceptance criteria
- ScheduleWakeup round-trips through the daemon and fires (maps to `schedule-wakeup-fires`).
- CronCreate + `*/1 * * * *` fires at least once in a 90s window (maps to `cron-create-fires-on-schedule`).
- CronList returns only the calling session's jobs (maps to `cron-list-returns-jobs`).
- CronDelete removes a job and CronList no longer returns it (maps to `cron-delete-cancels`).
- A pre-restart wakeup still fires post-restart (maps to `survives-daemon-restart`).
- All four tools appear in `listTools()` (maps to `tools-registered-in-index`).
- `bun run typecheck` + `bun run lint` clean.

## Out of scope
- Do NOT introduce a UI for managing jobs — CLI `jellyclaw daemon tail` is sufficient.
- Do NOT add authentication to the socket beyond filesystem permissions (0600 owner-only). That's a T4 sub-hardening prompt if ever needed.
- Do NOT implement cross-user jobs; owner is always a session id.
- Do NOT change the cron parser — T4-01 ships and owns it.
- Do NOT implement second-granularity cron (seconds field). 5-field only.

## Verification the worker should self-run before finishing
```bash
bun run typecheck
bun run lint
bun run test engine/src/tools/schedule-wakeup
bun run test engine/src/tools/cron
bun run test engine/src/daemon/handlers/resume
bun run test engine/src/tools -t scheduling-tools-registered
```
