---
id: T4-04-monitor-tool
tier: 4
title: "Monitor tool — stream events from a long-running background process"
scope:
  - "engine/src/tools/monitor.ts"
  - "engine/src/tools/monitor.test.ts"
  - "engine/src/tools/monitor-registry.ts"
  - "engine/src/tools/monitor-registry.test.ts"
  - "engine/src/tools/index.ts"
  - "engine/src/daemon/handlers/monitor.ts"
  - "engine/src/daemon/handlers/monitor.test.ts"
  - "engine/src/daemon/scheduler.ts"
  - "engine/src/events.ts"
  - "docs/tools/monitor.md"
depends_on_fix:
  - T4-01-scheduled-tasks-daemon
  - T1-01-cap-tool-output-bytes
tests:
  - name: monitor-tail-file-emits-events
    kind: shell
    description: "Monitor 'tail -f' on a fixture file; writing three lines yields three monitor.event emissions"
    command: "bun run test engine/src/tools/monitor -t tail-file-emits"
    expect_exit: 0
    timeout_sec: 45
  - name: monitor-stop-cleans-up
    kind: shell
    description: "MonitorStop kills the child process, removes the registry row, and no further events fire"
    command: "bun run test engine/src/tools/monitor -t stop-cleans-up"
    expect_exit: 0
    timeout_sec: 30
  - name: monitor-persistent-across-restart
    kind: shell
    description: "a monitor with persistent:true is recreated on daemon restart from the store"
    command: "bun run test engine/src/daemon/handlers/monitor -t survives-restart"
    expect_exit: 0
    timeout_sec: 60
  - name: monitor-line-cap-enforced
    kind: shell
    description: "each emitted line is capped at 8KB; longer lines are truncated with elision marker"
    command: "bun run test engine/src/tools/monitor -t line-cap"
    expect_exit: 0
    timeout_sec: 20
  - name: monitor-rate-limit
    kind: shell
    description: "a monitor emitting >100 lines/sec is coalesced into batched events, not dropped"
    command: "bun run test engine/src/tools/monitor -t rate-limit-batching"
    expect_exit: 0
    timeout_sec: 30
human_gate: true
max_turns: 70
max_cost_usd: 10
max_retries: 5
estimated_duration_min: 140
---

# T4-04 — Monitor tool

## Context
`Monitor` lets an agent tail a long-running signal (a log file, a build output, a polled endpoint) and receive each emitted line as an event without blocking the agent turn. Claude Code's semantics: one `Monitor` call starts a watcher, returns a handle, and subsequent events arrive as `monitor.event` deltas on the stream. `MonitorStop({ id })` terminates it. This is structurally similar to T4-03's team events and T4-02's scheduler fires — it piggybacks on the same SSE/event plumbing but the event source is a subprocess or fs-watch, not a scheduled fire.

Reference material:
- `engine/src/daemon/scheduler.ts` (T4-01) — we reuse the SQLite store and handler-registration seam so persistent monitors survive daemon restart.
- `engine/src/tools/index.ts` — registration site.
- `engine/src/events.ts` — where new event variants are declared.
- `chokidar` (`package.json:40`) — already a dep; use for `watch:` variant (directory / file events).
- `execa` (`package.json:42`) — already a dep; use for `tail:` and `cmd:` variants (spawn a subprocess and tail its stdout/stderr).

Claude Code surface we match:
```ts
Monitor({
  kind: "tail" | "watch" | "cmd",
  target: string,           // path for tail/watch; shell for cmd
  pattern?: string,         // optional regex; only matching lines emit
  max_lines?: number,       // optional cutoff; stops after N emissions
  persistent?: boolean,     // default false; if true, survives daemon restart
  notify: "agent" | "user"  // default "agent"
}) => { monitor_id, started_at }
MonitorStop({ id }) => { id, stopped_at, total_events }
MonitorList() => Array<{ id, kind, target, status, events_emitted, started_at }>
```

## Root cause (from audit)
Agents currently have no way to observe a long-running signal without blocking on `Bash tail -f`, which kills the turn. This forces workarounds like repeated short Bash calls, which are expensive (per-invocation overhead) and lose line ordering. `Monitor` is the missing primitive for "watch and react."

## Fix — exact change needed

### 1. `engine/src/tools/monitor-registry.ts` — durable registry
- Schema table `monitors` added to the scheduler SQLite DB (bump schema_version; migration writes the new table):
  ```sql
  CREATE TABLE monitors (
    id              TEXT PRIMARY KEY,       -- ulid
    owner           TEXT NOT NULL,
    kind            TEXT NOT NULL,          -- 'tail' | 'watch' | 'cmd'
    target          TEXT NOT NULL,
    pattern         TEXT,
    max_lines       INTEGER,
    persistent      INTEGER NOT NULL,       -- 0/1
    notify          TEXT NOT NULL,          -- 'agent' | 'user'
    status          TEXT NOT NULL,          -- 'running' | 'stopped' | 'exhausted' | 'error'
    events_emitted  INTEGER NOT NULL DEFAULT 0,
    started_at      INTEGER NOT NULL,
    stopped_at      INTEGER,
    error           TEXT
  );
  CREATE INDEX idx_monitors_owner_status ON monitors (owner, status);
  ```
- Owner-scoped reads, same pattern as T4-01's jobs + T4-03's teams.
- API: `create`, `markExhausted`, `markStopped`, `markError`, `incrementEmitted`, `listAll(owner)`, `listPersistent()`.

### 2. `engine/src/daemon/handlers/monitor.ts` — the runtime
- Three drivers, dispatched by `kind`:
  - **tail** — spawn a `tail -F -n 0 <target>` child via `execa`, parse stdout line-by-line (`readline`), emit one `monitor.event` per line (see §4). On child exit → `markStopped` or `markError` depending on exit code.
  - **watch** — `chokidar.watch(target, { ignoreInitial: true })`. Events are `add | change | unlink`. Emit one `monitor.event` per fs event with payload `{ type, path, stats? }`.
  - **cmd** — spawn `bash -c "<target>"` with `execa`; emit each stdout line as an event. Child exit naturally → `markStopped`.
- Pattern filter: if `pattern` is present, compile once (Zod pre-validates `SafeRegex`; reject look-behind and recursive backrefs). Lines/events that don't match are counted but not emitted.
- Rate limiter: coalesce lines emitted in the same 50ms tick into a single `monitor.event` with an array payload (`lines: string[]`). Per-monitor ceiling: 1000 pending lines buffered; above that, drop and emit `monitor.event{dropped: N}` once per second.
- Line cap: per the T1-01 convention, any single line longer than 8192 bytes is truncated with `"\n[… N more bytes elided …]"`. Whole-event payload still subject to T1-01's 200KB tool-result cap where applicable.
- `max_lines` cutoff: when `events_emitted >= max_lines`, `markExhausted` and stop.
- On daemon boot, call `registry.listPersistent()` → recreate each running monitor. Non-persistent monitors are marked `stopped` with reason `daemon_restart`.

### 3. `engine/src/tools/monitor.ts` — three tools
- `Monitor` — validate input (Zod; `target` path canonicalised for `tail` / `watch` kinds and existence-checked; `cmd` kind requires a non-empty string), ipc→daemon `createMonitor`, return `{ monitor_id, started_at }`.
- `MonitorStop` — `{ id }`. Owner-check; send ipc `stopMonitor`. Unknown → `ToolError("unknown_monitor")`, cross-owner → `ToolError("forbidden")`.
- `MonitorList` — returns the calling session's monitors with current status + events_emitted.
- Register all three in `engine/src/tools/index.ts`.

### 4. Event plumbing (`engine/src/events.ts`)
- New variants:
  - `monitor.started` — `{ monitor_id, kind, target }`
  - `monitor.event` — `{ monitor_id, ts, lines?: string[], fs_event?: {type, path}, dropped?: number }` (exactly one of `lines` / `fs_event` / `dropped` per event; enforced with Zod discriminated union).
  - `monitor.stopped` — `{ monitor_id, reason: "user"|"exhausted"|"error"|"daemon_restart", total_events, stopped_at, error? }`
- Events flow to the agent loop if `notify: "agent"` (injected as user-role tool_result-style messages on the NEXT turn) or to the user-facing SSE stream if `notify: "user"` (no agent interruption).

### 5. `docs/tools/monitor.md`
- Three worked examples: tail a build log, watch a settings file, poll an http endpoint via `cmd: "while true; do curl -s url; sleep 10; done"`.
- Describe the 8KB line cap, the 50ms batching window, and the difference between `notify: "agent"` (agent resumes on the next turn with these events as context) vs `notify: "user"` (events surface to the dashboard/TUI directly, agent is not interrupted).
- Security caveat: `kind: "cmd"` spawns through `bash -c`. Gate it behind the same hook surface as the Bash tool (PreToolUse can veto). Document the sandbox hook that production installs should configure.

### 6. Tests
- `tail-file-emits` — write a fixture file in a tmp dir, start a `tail` monitor, append 3 lines with small `await sleep(100)` gaps, assert 3 `monitor.event` emissions with matching text.
- `stop-cleans-up` — MonitorStop; verify `registry.status === "stopped"`, the child PID is no longer a process (`ps` query), further writes don't emit events.
- `survives-restart` — create a `persistent:true, kind:"watch"` monitor; simulate daemon restart (close+reopen scheduler); verify chokidar is reattached and a new write emits an event; verify non-persistent monitors are absent from the registry.
- `line-cap` — emit a 20KB line; assert the resulting event's line is ≤8192 bytes and includes the elision marker.
- `rate-limit-batching` — emit 200 lines in rapid sequence; assert the receiver sees <10 `monitor.event` messages (batched), and `sum(lines)` === 200 (nothing dropped, all preserved through batching).

## Acceptance criteria
- `Monitor({kind:"tail"})` emits per-line events (maps to `monitor-tail-file-emits-events`).
- `MonitorStop` fully cleans up (maps to `monitor-stop-cleans-up`).
- `persistent:true` monitors survive daemon restart (maps to `monitor-persistent-across-restart`).
- 20KB lines are capped (maps to `monitor-line-cap-enforced`).
- High-rate emitters are coalesced, not dropped (maps to `monitor-rate-limit`).
- `bun run typecheck` + `bun run lint` clean.

## Out of scope
- Do NOT implement websocket or polling-URL monitors as first-class kinds — use `cmd` with a user-supplied curl loop instead.
- Do NOT implement monitors over remote hosts; local-only in T4.
- Do NOT add per-monitor system-prompt augmentation; the agent sees raw events and decides.
- Do NOT modify T4-01's scheduler tick loop (monitors are handled in a separate event-loop-driven runtime, not the cron tick).

## Verification the worker should self-run before finishing
```bash
bun run typecheck
bun run lint
bun run test engine/src/tools/monitor
bun run test engine/src/tools/monitor-registry
bun run test engine/src/daemon/handlers/monitor
```
