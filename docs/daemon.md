# Jellyclaw Scheduler Daemon

The scheduler daemon provides durable job scheduling for ScheduleWakeup (one-shot delayed tasks) and Cron (recurring tasks). It persists jobs in SQLite and survives process restarts.

## Quick Start

```bash
# Start the daemon in foreground (for testing)
jellyclaw daemon start --foreground

# Start as a background process
jellyclaw daemon start

# Check status
jellyclaw daemon status

# Stop the daemon
jellyclaw daemon stop
```

## Installation

### macOS (launchd)

1. Copy the plist to LaunchAgents:
   ```bash
   cp scripts/daemon/com.jellyclaw.scheduler.plist ~/Library/LaunchAgents/
   ```

2. Create log directory:
   ```bash
   mkdir -p ~/Library/Logs/jellyclaw
   ```

3. Load and start the service:
   ```bash
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.jellyclaw.scheduler.plist
   ```

4. Verify it's running:
   ```bash
   jellyclaw daemon status
   ```

#### Uninstall (macOS)

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.jellyclaw.scheduler.plist
rm ~/Library/LaunchAgents/com.jellyclaw.scheduler.plist
```

### Linux (systemd user service)

1. Copy the service file:
   ```bash
   mkdir -p ~/.config/systemd/user
   cp scripts/daemon/jellyclaw-scheduler.service ~/.config/systemd/user/
   ```

2. Enable and start:
   ```bash
   systemctl --user daemon-reload
   systemctl --user enable --now jellyclaw-scheduler
   ```

3. Verify it's running:
   ```bash
   systemctl --user status jellyclaw-scheduler
   jellyclaw daemon status
   ```

#### Uninstall (Linux)

```bash
systemctl --user disable --now jellyclaw-scheduler
rm ~/.config/systemd/user/jellyclaw-scheduler.service
systemctl --user daemon-reload
```

## State Directory

By default, the daemon stores its state in:

- **macOS**: `~/.jellyclaw/`
- **Linux with XDG**: `$XDG_DATA_HOME/jellyclaw/` (typically `~/.local/share/jellyclaw/`)
- **Linux without XDG**: `~/.jellyclaw/`

Contents:
- `scheduler.db` — SQLite database with jobs and events
- `scheduler.sock` — Unix domain socket for IPC
- `scheduler.pid` — PID file for the running daemon

Override with `--state-dir`:
```bash
jellyclaw daemon start --foreground --state-dir /custom/path
```

## Log Files

### macOS (launchd)
- stdout: `~/Library/Logs/jellyclaw/scheduler.stdout`
- stderr: `~/Library/Logs/jellyclaw/scheduler.stderr`

### Linux (systemd)
```bash
journalctl --user -u jellyclaw-scheduler -f
```

### Foreground mode
Logs go to stderr in NDJSON format. Use `pino-pretty` for human-readable output:
```bash
jellyclaw daemon start --foreground 2>&1 | npx pino-pretty
```

## CLI Commands

### `jellyclaw daemon start`

Start the scheduler daemon.

| Flag | Description |
|------|-------------|
| `--foreground` | Run in foreground (don't daemonize) |
| `--state-dir <dir>` | Override state directory |

### `jellyclaw daemon stop`

Stop the running daemon (SIGTERM, then SIGKILL after 10s).

| Flag | Description |
|------|-------------|
| `--state-dir <dir>` | Override state directory |

### `jellyclaw daemon status`

Show daemon status.

| Flag | Description |
|------|-------------|
| `--state-dir <dir>` | Override state directory |
| `--pretty` | Human-readable output |

Example output (JSON):
```json
{
  "running": true,
  "pid": 12345,
  "pending": 3,
  "running": 0,
  "uptime_s": 3600,
  "db_path": "/Users/you/.jellyclaw/scheduler.db"
}
```

### `jellyclaw daemon tail`

Live-stream job events (requires subscribe verb — not yet implemented).

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                   jellyclaw-daemon                       │
│                                                         │
│  ┌─────────────┐   ┌─────────────┐   ┌──────────────┐  │
│  │  Scheduler  │◄──│  IPC Server │◄──│ CLI / Tools  │  │
│  │  (tick loop)│   │ (unix sock) │   │              │  │
│  └──────┬──────┘   └─────────────┘   └──────────────┘  │
│         │                                               │
│         ▼                                               │
│  ┌─────────────┐                                       │
│  │  JobStore   │                                       │
│  │  (SQLite)   │                                       │
│  └─────────────┘                                       │
└─────────────────────────────────────────────────────────┘
```

- **Scheduler**: Polls for due jobs every 250ms. Claims jobs atomically, dispatches to registered handlers.
- **JobStore**: SQLite with WAL mode. All writes use `BEGIN IMMEDIATE` for atomicity.
- **IPC Server**: Unix domain socket (`scheduler.sock`) with length-prefixed JSON frames.

## Job Schema

```sql
CREATE TABLE jobs (
  id             TEXT PRIMARY KEY,     -- ULID
  kind           TEXT NOT NULL,        -- 'wakeup' | 'cron'
  fire_at        INTEGER NOT NULL,     -- Unix ms
  cron_expr      TEXT,                 -- null for wakeup
  payload        TEXT NOT NULL,        -- JSON blob
  created_at     INTEGER NOT NULL,
  last_fired_at  INTEGER,
  fire_count     INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL,        -- pending|running|done|failed|cancelled
  error          TEXT,
  owner          TEXT NOT NULL         -- session id or 'system'
);
```

## Troubleshooting

### Daemon won't start

1. Check for stale PID file:
   ```bash
   cat ~/.jellyclaw/scheduler.pid
   ps aux | grep <pid>
   rm ~/.jellyclaw/scheduler.pid  # if process is dead
   ```

2. Check socket permissions:
   ```bash
   ls -la ~/.jellyclaw/scheduler.sock
   # Should be 0600 (rw-------)
   ```

### "Socket not found" error

The daemon isn't running. Start it:
```bash
jellyclaw daemon start
```

### Jobs not firing

1. Check daemon status:
   ```bash
   jellyclaw daemon status --pretty
   ```

2. Check job status in database:
   ```bash
   sqlite3 ~/.jellyclaw/scheduler.db "SELECT id, status, fire_at FROM jobs"
   ```

3. Check logs for errors.
