# Monitor Tools

## Overview

The `Monitor`, `MonitorStop`, and `MonitorList` tools enable agents to watch long-running signals (log files, directories, shell commands) and receive events without blocking the agent turn.

## Monitor

Start a background monitor that tails a file, watches a directory, or runs a shell command.

### Input Schema

```json
{
  "kind": "tail" | "watch" | "cmd",
  "target": "string (required)",
  "pattern": "string (optional regex)",
  "max_lines": "integer (optional)",
  "persistent": "boolean (optional, default: false)",
  "notify": "agent" | "user" (optional, default: "agent")
}
```

### Monitor Kinds

| Kind | Description | Target |
|------|-------------|--------|
| `tail` | Tail a file like `tail -f` | Absolute path to a file |
| `watch` | Watch a directory for changes | Absolute path to a directory |
| `cmd` | Run a shell command | Shell command string |

### Examples

#### Tail a build log

```json
{
  "kind": "tail",
  "target": "/tmp/build.log",
  "pattern": "error|warning",
  "notify": "agent"
}
```

#### Watch a settings file

```json
{
  "kind": "watch",
  "target": "/etc/myapp",
  "persistent": true
}
```

#### Poll an HTTP endpoint

```json
{
  "kind": "cmd",
  "target": "while true; do curl -s http://localhost:8080/health; sleep 10; done",
  "pattern": "unhealthy"
}
```

### Output

```json
{
  "monitor_id": "mon-abc123",
  "started_at": 1710000000000
}
```

## MonitorStop

Stop a running monitor and clean up resources.

### Input Schema

```json
{
  "id": "string (required)"
}
```

### Output

```json
{
  "id": "mon-abc123",
  "stopped_at": 1710000100000,
  "total_events": 42
}
```

## MonitorList

List all monitors for the current session.

### Output

```json
[
  {
    "id": "mon-abc123",
    "kind": "tail",
    "target": "/var/log/app.log",
    "status": "running",
    "events_emitted": 42,
    "started_at": 1710000000000
  }
]
```

## Events

Monitors emit the following events:

### monitor.started

Emitted when a monitor starts successfully.

```json
{
  "type": "monitor.started",
  "monitor_id": "mon-abc123",
  "kind": "tail",
  "target": "/var/log/app.log"
}
```

### monitor.event

Emitted when a monitor captures output. Contains exactly one of:
- `lines`: Array of text lines (for `tail` and `cmd`)
- `fs_event`: Filesystem event (for `watch`)
- `dropped`: Count of dropped lines (rate limiting)

```json
{
  "type": "monitor.event",
  "monitor_id": "mon-abc123",
  "lines": ["ERROR: connection failed", "ERROR: retry failed"]
}
```

```json
{
  "type": "monitor.event",
  "monitor_id": "mon-abc123",
  "fs_event": {
    "type": "change",
    "path": "/etc/myapp/config.yaml"
  }
}
```

### monitor.stopped

Emitted when a monitor stops.

```json
{
  "type": "monitor.stopped",
  "monitor_id": "mon-abc123",
  "reason": "user",
  "total_events": 42,
  "stopped_at": 1710000100000
}
```

Stop reasons:
- `user`: Stopped via MonitorStop
- `exhausted`: Reached `max_lines` limit
- `error`: Process exited with error or file not found
- `daemon_restart`: Daemon restarted (non-persistent monitors only)

## Constraints

### Line Cap (8KB)

Each emitted line is capped at 8KB. Longer lines are truncated with an elision marker:

```
[first 8KB of line content]
[… 12345 more bytes elided …]
```

### Rate Limiting (50ms batching)

Lines emitted within the same 50ms window are coalesced into a single `monitor.event` with an array of lines. This prevents overwhelming the event stream with high-frequency output.

### Buffer Limit (1000 lines)

Each monitor buffers up to 1000 pending lines. If this limit is exceeded, lines are dropped and a `monitor.event` with `dropped: N` is emitted once per second.

### Persistent vs Ephemeral

| Feature | persistent: true | persistent: false |
|---------|-----------------|-------------------|
| Survives daemon restart | Yes | No |
| Marked stopped on restart | No | Yes (error: daemon_restart) |
| Use case | Long-running watchers | Short-lived observations |

## Security

### cmd Kind

The `cmd` kind spawns through `bash -c`. It is gated behind the same hook surface as the Bash tool. Production installations should configure PreToolUse hooks to vet commands.

### Pattern Validation

Regex patterns are validated and compiled safely. Dangerous patterns (lookbehind, recursive backrefs) are rejected.

## Notification Modes

| Mode | Behavior |
|------|----------|
| `agent` | Events are injected into the agent's next turn as context |
| `user` | Events are sent to SSE stream only, agent is not interrupted |

Use `notify: "user"` for high-volume monitoring where the agent doesn't need to react to every event (e.g., displaying build progress to the user).
