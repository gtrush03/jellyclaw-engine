# Hooks

Jellyclaw's hook engine runs user-configured shell commands at well-defined
lifecycle points. Hooks can observe, modify, or block activity — subject
to the composition rules documented below. They live in
`engine/src/hooks/` and compose with the [permission engine](./permissions.md)
for tool-call gating.

A hook is just a program. It receives JSON on stdin, writes an optional
JSON decision on stdout, signals a hard block via exit code 2, and is
audit-logged to `~/.jellyclaw/logs/hooks.jsonl`.

## Event kinds

| Event                 | Fires…                                     | Blocking? | Modifies payload? |
|-----------------------|--------------------------------------------|-----------|-------------------|
| `SessionStart`        | engine init                                | no        | no                |
| `InstructionsLoaded`  | after `CLAUDE.md` + system prompt built    | no        | no                |
| `UserPromptSubmit`    | user sends a message                       | yes       | yes               |
| `PreToolUse`          | before each tool invocation                | **yes**   | **yes**           |
| `PostToolUse`         | after each tool result                     | no (async by default) | no                |
| `SubagentStart`       | `task` tool spawns a subagent              | no        | no                |
| `SubagentStop`        | subagent finishes                          | no        | no                |
| `PreCompact`          | token budget hits compaction threshold     | yes       | no                |
| `Stop`                | end of turn                                | no        | no                |
| `Notification`        | engine or tool emits a notification        | no (never)| no                |

"Blocking" means an exit-2 or `decision: "deny"` on stdout aborts the
corresponding action. For events that are not blocking, `decision` is
ignored with a warning.

## Hook contract

### stdin

A single JSON object, terminated by `\n`:

```json
{"event":"PreToolUse","payload":{"sessionId":"s1","toolName":"Bash","toolInput":{"command":"rm -rf /"},"callId":"c1"}}
```

See `engine/src/hooks/types.ts` for the per-event payload schemas; every
event kind has a zod schema registered in `events.ts`.

### stdout

Either empty (neutral) or a JSON object:

```json
{"decision":"allow"}
{"decision":"deny","reason":"rm blocked by policy"}
{"decision":"modify","modified":{"toolInput":{"command":"ls"}}}
```

- `decision` is one of `allow`, `deny`, `modify`, or omitted.
- `reason` is free-form; surfaced to the model on deny.
- `modified` carries the rewritten payload. Only honoured when the event
  kind is in the modifiable set (`PreToolUse`, `UserPromptSubmit`).

### exit codes

| Exit | Meaning                                            |
|------|----------------------------------------------------|
| `0`  | Whatever's on stdout. Empty stdout = neutral.      |
| `2`  | **Hard block.** stderr is read as the deny reason. |
| other| Treated as neutral + warned.                       |

### timeout

Default 30 000 ms. Maximum 120 000 ms. Timeout fires `SIGTERM`, waits
1 000 ms, then `SIGKILL`. Timed-out hooks are recorded as neutral + warn.

## Config

Hooks are listed under the top-level `hooks:` array in `jellyclaw.json`.

```jsonc
{
  "hooks": [
    {
      "event":   "PreToolUse",
      "matcher": "Bash(rm *)",
      "command": "/usr/local/bin/jellyclaw-guard",
      "args":    ["--strict"],
      "timeout": 5000,
      "name":    "bash-guard"
    },
    {
      "event":   "PostToolUse",
      "matcher": "Bash",
      "command": "/usr/local/bin/audit-to-remote",
      "blocking": false
    },
    {
      "event":   "UserPromptSubmit",
      "command": "/opt/secrets/scrub.py",
      "blocking": true
    }
  ]
}
```

### Field reference

| Field      | Required | Notes                                                   |
|------------|----------|---------------------------------------------------------|
| `event`    | yes      | One of the 10 event kinds.                              |
| `matcher`  | no       | Semantics depend on event (see below).                  |
| `command`  | yes      | Absolute path preferred. Relative paths are warned — they shift under `PATH`. |
| `args`     | no       | Argv array. **Never shell-interpolated.**               |
| `timeout`  | no       | Milliseconds. `1 ≤ t ≤ 120_000`. Default 30 000.        |
| `blocking` | no       | Only meaningful for `PostToolUse`. Default `true`.      |
| `name`     | no       | Log label. Defaults to `${command}#${index}`.           |
| `env`      | no       | Extra env vars set for this hook only.                  |

### Matcher grammar

| Event                          | Matcher syntax                              |
|--------------------------------|---------------------------------------------|
| `PreToolUse` / `PostToolUse`   | `Tool` or `Tool(pattern)` — same grammar as [permission rules](./permissions.md#rule-grammar). |
| `UserPromptSubmit`             | [picomatch](https://github.com/micromatch/picomatch) glob against the first 256 chars of the prompt. |
| Other events                   | **Ignored.** The hook always fires; a warning is logged. |

## Composition with permissions

When a `PreToolUse` hook and the permission engine both have an opinion
about a tool call, the composed order is:

1. **Plan mode + side-effectful tool** → deny. Hook is NOT invoked —
   observing the attempt would leak it to user code.
2. **Hook runs.**
   - `deny` → **deny (authoritative).** Beats everything, including
     `bypassPermissions`.
   - `modify` → the rewritten `toolInput` replaces the original for the
     rest of the pipeline.
   - `allow` → **advisory only.** Does not override a later deny rule.
     Downgraded to neutral for rule evaluation.
   - `neutral` / no hook → proceed.
3. **`bypassPermissions`** → allow (hook didn't deny).
4. **Rules** evaluated per the [permissions pipeline](./permissions.md#decision-pipeline):
   deny-wins, then ask, then allow, then mode fall-through.

Key invariants:

- **Hook deny beats rule allow** (and beats `bypassPermissions`).
- **Hook allow does NOT beat rule deny** — allow is advisory.
- **Plan-mode refusal is unconditional** and not observable by hooks.

## Non-blocking `PostToolUse`

`PostToolUse` hooks default to blocking. Set `blocking: false` to opt
into fire-and-forget mode:

- The engine spawns the hook and returns immediately.
- `modified` in the hook's stdout is **ignored + warned** (the tool
  result has already been handed to the model).
- `deny` has no effect — the action has already happened.

Use non-blocking `PostToolUse` for telemetry, mirroring, or slow
enrichment. Use blocking mode only when you need the hook to shape the
tool result before the model sees it.

## Audit log

Every hook invocation appends one line to
`~/.jellyclaw/logs/hooks.jsonl`:

```json
{"ts":"2026-04-15T10:22:33.111Z","event":"PreToolUse","sessionId":"s1","hookName":"bash-guard","decision":"deny","durationMs":42,"exitCode":2,"reason":"rm blocked"}
```

- File is created with mode `0600` (user-only read/write).
- Rotation: when the file reaches **50 MB** it is renamed to `.1`, shift
  `.1 → .2`, etc., keeping **5 generations**. Oldest is deleted.
- Implementation: `engine/src/hooks/audit-log.ts`.
- Test-only override: the `HOOKS_LOG_PATH_OVERRIDE` environment variable
  reroutes the log; used by `audit-log.test.ts`. Not a supported public
  interface.

## Security

Hooks run under the same UID as the engine. They can do anything the
engine can. Treat `jellyclaw.json` as production code:

- **No shell interpolation.** `command` is `spawn`'d directly with `args`;
  user input is never concatenated into a shell string. See `SECURITY.md §2`.
- **Relative paths are warned.** Prefer absolute paths — a relative
  `command` can be hijacked by a `PATH` shift.
- **stdin/stdout/stderr are bounded.** Stdout/stderr are each capped at
  ~1 MiB per hook; excess is truncated with a flag. `PostToolUse` caps
  the embedded tool result at 256 KiB.
- **Hooks fire in subagent contexts** (see `SECURITY.md §2.8`). Any
  policy enforced via hooks applies uniformly to subagent tool calls.

## Payload examples

### PreToolUse

```json
{
  "event": "PreToolUse",
  "payload": {
    "sessionId": "s1",
    "toolName": "Bash",
    "toolInput": { "command": "git push" },
    "callId": "c42"
  }
}
```

### UserPromptSubmit

```json
{
  "event": "UserPromptSubmit",
  "payload": {
    "sessionId": "s1",
    "prompt": "write a test that..."
  }
}
```

### PostToolUse

```json
{
  "event": "PostToolUse",
  "payload": {
    "sessionId": "s1",
    "toolName": "Read",
    "toolInput": { "file_path": "src/a.ts" },
    "toolResult": "file contents here",
    "callId": "c42",
    "durationMs": 12,
    "truncated": false
  }
}
```

Full per-event schemas live in `engine/src/hooks/events.ts`.

## Troubleshooting

| Symptom                           | Cause                                      | Fix                                    |
|-----------------------------------|--------------------------------------------|----------------------------------------|
| Hook didn't fire                  | `matcher` doesn't apply to that event kind | Remove the matcher (it's ignored) or pick an event kind where matchers work. |
| Hook didn't fire on the right tool| Matcher grammar mismatch                   | Verify your matcher against [`docs/permissions.md`](./permissions.md#rule-grammar). `Bash(rm *)` matches `rm foo`, not `rm -rf /tmp/a` (globs respect `/`). |
| Hook deny ignored                 | Event is not in the blocking set           | Only `PreToolUse`, `UserPromptSubmit`, `PreCompact` can block. |
| Exit 2 ignored                    | Event is not in the blocking set, or `blocking:false` | Flip the event or `blocking`.    |
| Timeout warnings                  | Hook exceeded 30 s default                 | Raise `timeout` (cap 120 000 ms) or move the work to a non-blocking `PostToolUse`. |
| `modified` ignored                | Event not in `MODIFIABLE_EVENTS`, or `PostToolUse` non-blocking | Only `PreToolUse` / `UserPromptSubmit` can modify. |
| Hook stdout truncated             | Exceeded ~1 MiB cap                        | Reduce output; large logs belong in a sidecar file. |
| Audit log empty                   | `HOOKS_LOG_PATH_OVERRIDE` set, or the sink was swapped | Unset the env var; check the injected sink. |

## See also

- [`permissions.md`](./permissions.md) — the sibling gating layer.
- `engine/src/hooks/types.ts` — frozen TypeScript contract.
- `engine/src/hooks/events.ts` — per-event zod payload schemas.
- `engine/SECURITY.md` — threat model + hook-related mitigations.
