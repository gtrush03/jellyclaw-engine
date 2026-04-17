# jc-orchestrator — always-on tmux supervision for the autobuild rig

This directory ships the **supervision surface** for the jellyclaw autobuild
rig. It has two halves:

1. A tmux session (`jc-orchestrator`) George attaches to when he wants to
   watch workers live.
2. A `jc` CLI he can use from any terminal to drive the rig without
   interrupting workers.

Nothing in here mutates `.autobuild/state.json` directly. All control commands
go through `.orchestrator/inbox/*.json`; the dispatcher drains that queue on
each tick. That keeps the CLI **safe to run concurrently** with the daemon.

---

## Quick start

```bash
# One-time: put `jc` on PATH.
./install-jc.sh

# Start (or re-attach to) the supervision tmux session.
./spawn.sh
tmux attach -t jc-orchestrator

# From any terminal:
jc status
jc ps
jc pause        # queue a pause
jc resume
```

Stop the tmux session cleanly:

```bash
./stop.sh
```

---

## The 5 tmux windows

When you attach with `tmux attach -t jc-orchestrator` you get:

| # | Name    | What it shows                                              |
|---|---------|------------------------------------------------------------|
| 0 | `grid`  | Live-updating table of every run (states, runtime, tests). |
| 1 | `logs`  | `tail -F logs/orchestrator.jsonl` piped through `pino-pretty` (falls back to raw tail if not installed). |
| 2 | `repl`  | Bare bash with `jc` on PATH — run any `jc` command here.   |
| 3 | `brain` | Reserved for M13 (LLM advisor). Currently a placeholder.   |
| 4 | `inbox` | Live view of `.orchestrator/inbox/` so you can see queued commands. |

Status line shows `q=<queue> run=<active>/<cap> today=$<spend>/<cap>` refreshed
every 5s via `jc status --line`.

### Optional keybindings

Source the provided `tmux.conf` from your `~/.tmux.conf` to get:

- prefix-**G** → grid
- prefix-**L** → logs
- prefix-**R** → repl
- prefix-**B** → brain
- prefix-**I** → inbox
- prefix-**P** → `jc pause`
- prefix-**U** → `jc resume`
- prefix-**H** → `jc halt`

```tmux
source-file /Users/gtrush/Downloads/jellyclaw-engine/scripts/orchestrator/tmux.conf
```

---

## `jc` — the CLI

All subcommands work whether or not the dispatcher is running. Read-only
commands read state files directly; mutating commands drop a JSON file in
`.orchestrator/inbox/` and return immediately.

### Read-only

| Command                         | What it does |
|--------------------------------|--------------|
| `jc status`                    | Pretty-printed summary of `state.json`. |
| `jc status --line`             | Compact single-line for tmux status-right (`q=7 run=2/2 today=$4.20 OK`). |
| `jc ps`                        | Table of every active run (state, runtime, tests, attempts). |
| `jc preview <id>`              | Last 200 lines of the session's `tmux.log`. |
| `jc follow <id>`               | `tail -F` the session's `tmux.log`. |
| `jc budget`                    | Today's spend, daily-cap bar, linear forecast, top runs by cost. |
| `jc log <name>`                | `tail -F` one of `orchestrator` / `dispatcher` / `tester` / `autobuild`. |
| `jc help`                      | Full command list. |

### Control (go through inbox)

| Command                         | Inbox payload |
|--------------------------------|---------------|
| `jc pause`                     | `{ cmd: "pause" }` |
| `jc resume`                    | `{ cmd: "resume" }` |
| `jc halt`                      | `{ cmd: "halt" }` |
| `jc abort <id>`                | `{ cmd: "abort",   target: <id> }` |
| `jc approve <id>`              | `{ cmd: "approve", target: <id> }` |
| `jc rerun <id>`                | `{ cmd: "rerun",   target: <id> }` |
| `jc skip <id>`                 | `{ cmd: "skip",    target: <id> }` |
| `jc tell <id> "<hint>"`        | `{ cmd: "tell",    target: <id>, payload: "<hint>" }` |
| `jc concurrency <n>\|auto`     | `{ cmd: "concurrency", payload: <n>\|"auto" }` |
| `jc pause-until <HH:MM>`       | `{ cmd: "pause-until", payload: "<HH:MM>" }` + writes `.orchestrator/paused-until` |
| `jc hint <pid> accept\|reject` | **Stubbed** — M13 not yet; prints "M13 not yet". |

---

## Inbox command-file format

Every mutating `jc` command writes a JSON file at:

```
.orchestrator/inbox/<iso-timestamp>-<cmd>-<rand>.json
```

Shape:

```json
{
  "cmd": "abort",
  "issued_at": "2026-04-17T12:34:56.789Z",
  "target": "T0-01-fix-serve-shim",
  "payload": null
}
```

- `cmd` — required. One of the verbs above.
- `issued_at` — ISO timestamp the CLI wrote the file.
- `target` — optional, the run id the command applies to.
- `payload` — optional, string or number. `tell` uses it for the hint; `concurrency` for the number; `pause-until` for `"HH:MM"`.

Files are append-only from the CLI's point of view. The dispatcher is expected
to process and **delete** them (or move to `.orchestrator/processed/`); the CLI
never reads them back.

---

## Budget gates (informational)

These are enforced by the rig (`scripts/autobuild/lib/budget.mjs`), not by
`jc`; `jc budget` just surfaces them.

| Gate              | Trigger | Effect |
|-------------------|---------|--------|
| Soft self-check   | $5 per session | Claude is asked "continue?" — fail-closed. |
| Hard kill         | $10 per session | Worker is killed unconditionally. |
| Daily cap         | $25 across the day | Dispatcher halts; no new spawns. |

---

## Launchd (macOS, optional)

Template at `com.jellyclaw.orchestrator.plist.tpl`. Install:

```bash
REPO="/Users/gtrush/Downloads/jellyclaw-engine"
sed "s|{{REPO_ROOT}}|${REPO}|g" \
  "${REPO}/scripts/orchestrator/com.jellyclaw.orchestrator.plist.tpl" \
  > ~/Library/LaunchAgents/com.jellyclaw.orchestrator.plist
launchctl load -w ~/Library/LaunchAgents/com.jellyclaw.orchestrator.plist
```

`spawn.sh` is idempotent, so the launchd `KeepAlive` + `ThrottleInterval=30`
pattern is safe — if the script exits after the session is created, launchd
relaunches it 30s later and it no-ops.

Uninstall:

```bash
launchctl unload ~/Library/LaunchAgents/com.jellyclaw.orchestrator.plist
rm ~/Library/LaunchAgents/com.jellyclaw.orchestrator.plist
```

---

## Troubleshooting

### `jc` says "rig state dir missing"

You haven't started the rig yet. Run:

```bash
scripts/autobuild/bin/autobuild run
```

…which creates `.autobuild/` and seeds `state.json`. (If you're working from a
different repo checkout, export `AUTOBUILD_ROOT=/path/to/repo` before invoking
`jc`.)

### `jc` not found after `./install-jc.sh`

Check that `/usr/local/bin` is on your PATH:

```bash
echo $PATH
```

If it isn't, either add it or install to `~/bin` instead:

```bash
mkdir -p ~/bin
ln -sf "$PWD/scripts/orchestrator/jc" ~/bin/jc
# ensure ~/bin is on PATH in .zshrc / .bashrc
```

### `spawn.sh` says "session already running"

Expected and safe — `spawn.sh` is idempotent. Attach with
`tmux attach -t jc-orchestrator`, or kill and recreate:

```bash
./stop.sh && ./spawn.sh
```

### `logs` window is empty

The rig hasn't written anything to `logs/orchestrator.jsonl` yet. The window is
`tail -F` so it'll pick up new output as soon as the dispatcher starts logging.

### `brain` window says "M13 not yet implemented"

That's the placeholder. Use the `repl` window for `jc` commands; the brain
pane is reserved for the M13 LLM advisor milestone.

---

## Files in this directory

| File                                          | Purpose |
|-----------------------------------------------|---------|
| `jc`                                          | Node CLI (shebang `#!/usr/bin/env node`). |
| `grid.mjs`                                    | Live-updating TUI table (used by window 0). |
| `spawn.sh`                                    | Idempotent tmux launcher (creates the 5 windows). |
| `stop.sh`                                     | Kills the `jc-orchestrator` tmux session. |
| `install-jc.sh`                               | Symlinks `jc` to `/usr/local/bin/jc`. |
| `tmux.conf`                                   | Optional keybindings (`source-file` this). |
| `com.jellyclaw.orchestrator.plist.tpl`        | Launchd agent template (not auto-installed). |
| `SYSTEM-APPEND.md`                            | Placeholder for M13 brain pane. |
| `test/jc-commands.test.mjs`                   | Node-test coverage for the CLI. |
| `test/grid-render.test.mjs`                   | Snapshot-style tests for the grid renderer. |

Run tests:

```bash
node --test scripts/orchestrator/test/
```
