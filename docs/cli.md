# CLI reference

`jellyclaw` is the command-line entry point to the engine. The CLI is a thin
Commander shell; every subcommand is lazy-loaded so `jellyclaw --help` runs
without paying the cost of engine bootstrap, SQLite open, or MCP connects.

This document is the stable reference for flags, exit codes, environment
variables, and known divergences from Claude Code / Claurst. Engineering
details live in [`phases/PHASE-10-cli-http.md`](../phases/PHASE-10-cli-http.md).

> **Status.** Phase 10.01 (this document) ships the CLI surface. Phase 10.02
> ships `serve`, `resume`, `continue` beyond cache-hits, and reconciles the
> HTTP server. See [Known limitations](#known-limitations) at the bottom.

## Overview

```
jellyclaw [--version] <command> [command-options]
```

Three top-level philosophies:

1. **Thin.** No subcommand holds engine state; each opens/closes what it needs
   and returns an exit code.
2. **Read-only by default.** `skills list`, `agents list`, `mcp list`,
   `config show`, `doctor`, and `sessions list|search|show` do not mutate
   config or session state.
3. **Stream-first.** `run` streams `AgentEvent` records to stdout line-by-line
   (`stream-json` when stdout is not a TTY) so that Genie and other wrappers
   can consume output without waiting for completion.

## Subcommand index

| Command                       | Purpose                                                  |
|-------------------------------|----------------------------------------------------------|
| `run [prompt]`                | Dispatch a wish; stream `AgentEvent` to stdout.          |
| `resume <id> [prompt]`        | Sugar for `run --resume <id>`.                           |
| `continue [prompt]`           | Sugar for `run --continue`.                              |
| `serve`                       | HTTP server (Phase 10.02 — currently a stub).            |
| `sessions <subcommand>`       | `list | search | show | rm | reindex`.                   |
| `skills list`                 | List registered skills across user/project/legacy roots. |
| `agents list`                 | List registered subagents (Phase 06 stub).               |
| `mcp list`                    | List configured MCP servers + reachable tools.           |
| `config show`                 | Print the effective merged config (redacted by default). |
| `config check`                | Lint the permission + MCP blocks.                        |
| `doctor`                      | Diagnose install state (node, opencode, providers, MCP). |

Every subcommand supports `--help`.

## `run` flag reference

```
jellyclaw run [prompt] [options]
```

Reads stdin for the prompt when `prompt` is omitted and stdin is not a TTY.

| Flag                              | Type    | Default          | Example                              |
|-----------------------------------|---------|------------------|--------------------------------------|
| `--output-format <format>`        | enum    | `stream-json` when stdout is not a TTY, else `text` | `--output-format json`               |
| `--stream-stderr <format>`        | enum    | _(off)_          | `--stream-stderr jsonl`              |
| `--resume <id>`                   | string  | _(none)_         | `--resume 01H…`                      |
| `--continue`                      | bool    | `false`          | `--continue`                         |
| `--session-id <id>`               | string  | _(generated)_    | `--session-id 01J…`                  |
| `--permission-mode <mode>`        | enum    | `default`        | `--permission-mode acceptEdits`      |
| `--model <id>`                    | string  | provider default | `--model claude-sonnet-4-5`          |
| `--provider <name>`               | enum    | `primary`        | `--provider secondary`               |
| `--fallback-provider <name>`      | enum    | _(none)_         | `--fallback-provider secondary`      |
| `--mcp-config <path>`             | path    | _(effective config)_ | `--mcp-config ./mcp.json`        |
| `--max-turns <n>`                 | integer | _(none)_         | `--max-turns 8`                      |
| `--max-cost-usd <n>`              | number  | _(none)_         | `--max-cost-usd 0.50`                |
| `--wish-id <id>`                  | string  | _(none)_         | `--wish-id cart-refactor-v3`         |
| `--append-system-prompt <text>`   | string  | _(none)_         | `--append-system-prompt "Be terse."` |
| `--allowed-tools <csv>`           | csv     | _(none)_         | `--allowed-tools Read,Grep`          |
| `--disallowed-tools <csv>`        | csv     | _(none)_         | `--disallowed-tools Bash`            |
| `--add-dir <path>` _(repeatable)_ | path    | `[]`             | `--add-dir ./vendor`                 |
| `--cwd <path>`                    | path    | `process.cwd()`  | `--cwd /tmp/workspace`               |
| `--config-dir <path>`             | path    | `~/.jellyclaw`   | `--config-dir /opt/jc`               |
| `--verbose`                       | bool    | `false`          | `--verbose`                          |

**Conflict rule.** `--resume <id>` conflicts with `--continue`. Passing both
produces a Commander validation error (exit 2).

**Argument-string globbing.** `--allowed-tools` and `--disallowed-tools`
accept the same `Tool(pattern)` grammar documented in
[`docs/permissions.md`](permissions.md). The CSV is a convenience layer; every
entry is parsed independently.

### Output formats

| Format        | Shape                                                                 |
|---------------|-----------------------------------------------------------------------|
| `stream-json` | One JSON-encoded `AgentEvent` per line. Default for piped stdout.     |
| `text`        | Human-prose. Assistant deltas to stdout, tool calls to stderr (`--verbose` only). |
| `json`        | A single JSON array emitted at completion. Buffers the whole run.     |

See `engine/src/cli/output-types.ts` for the frozen producer/writer contract.

## `resume` / `continue` / `serve`

```
jellyclaw resume <id> [prompt]
jellyclaw continue [prompt]
jellyclaw serve [options]
```

- **`resume`** is sugar for `run --resume <id>`. Inherits every `run` flag
  through the underlying action. Phase 10.01 implements the cache-hit
  short-circuit path (wish-id replay); full replay from session store lands
  in Phase 10.02.
- **`continue`** resolves the newest session for the current project (hash
  of `cwd` per [`engine/src/session/paths.ts`](../engine/src/session/paths.ts))
  and forwards to `run --resume <id>`.
- **`serve`** starts the Hono HTTP server (Phase 10.02). Loopback-only by
  default, bearer auth mandatory, CORS allowlist locked down. Full
  endpoint reference — auth, SSE envelope, error shapes — lives in
  [`docs/http-api.md`](http-api.md).

  | Flag                         | Type    | Default                                | Notes |
  |------------------------------|---------|----------------------------------------|-------|
  | `--port <n>`                 | integer | `8765`                                 | TCP port to listen on. |
  | `--host <addr>`              | string  | `127.0.0.1`                            | Non-loopback binds require `--i-know-what-im-doing` AND `--auth-token`. |
  | `--auth-token <token>`       | string  | `OPENCODE_SERVER_PASSWORD` → `JELLYCLAW_TOKEN` → auto-generated | Auto-generated token is printed to stderr exactly once. |
  | `--cors <csv>`               | csv     | `http://localhost:*,http://127.0.0.1:*` | Exact origins or `localhost`/`127.0.0.1` wildcards only. `*` refused. |
  | `--i-know-what-im-doing`     | bool    | `false`                                | Required to bind a non-loopback address. Also requires `--auth-token`. |
  | `--verbose`                  | bool    | `false`                                | Pretty-print request logs to stderr. |

  The `OPENCODE_SERVER_PASSWORD` env var name is retained for compatibility
  with the Genie dispatcher; see
  [`integration/GENIE-INTEGRATION.md`](../integration/GENIE-INTEGRATION.md)
  §4 for the LaunchAgent template that consumes it.

## `sessions`

```
jellyclaw sessions <list | search | show | rm | reindex> [options]
```

The sessions dispatcher is owned by Phase 09.02. Its flag surface (project
scoping, FTS query grammar, `--limit`, `--since`, `--format`, etc.) is
documented in [`docs/sessions.md`](sessions.md). The CLI action in
`engine/src/cli/sessions.ts` translates the sub-args and returns a numeric
exit code to `main.ts`.

## `skills list`

```
jellyclaw skills list
```

Loads the skill registry via the default search roots in order:

1. `~/.jellyclaw/skills`        — user-level skills
2. `<cwd>/.jellyclaw/skills`    — project-level skills
3. `<cwd>/.claude/skills`       — legacy Claude-Code-shared skills

First-wins across roots; within a single root, `dir/SKILL.md` wins over a
flat `dir.md`. Skills that fail to parse are logged as warnings and skipped —
one malformed skill does not abort the command.

Output is a three-column table (`NAME`, `SOURCE`, `DESCRIPTION`). An empty
environment prints `no skills found` and exits 0. See
[`docs/skills.md`](skills.md) for authoring skills.

## `agents list`

```
jellyclaw agents list
```

Prints the registered subagents. Phase 06 (subagents) is currently a stub;
until Phase 06 lands the command prints:

```
No agents registered (subagents service is a Phase 06 stub — `.list()` returns [])
```

and exits 0. This is a placeholder surface so consumers can wire the command
into their workflow now and light it up transparently when Phase 06 ships.

## `mcp list`

```
jellyclaw mcp list
```

Loads the effective `mcp[]` config, boots an `McpRegistry` with a 5-second
per-server connect timeout and a 10-second overall budget, and prints:

```
SERVER                    STATUS      TOOLS
playwright                live        mcp__playwright__browser_navigate, mcp__playwright__browser_click, …
github                    retrying
legacy                    dead
```

Rows are truncated to 120 characters so one server with hundreds of tools
cannot blow up the terminal. The command exits 0 regardless of individual
server health — `dead` / `retrying` is what you asked for.

Disabled servers (`enabled: false` in config) are omitted from the output.

## `config show` / `config check`

```
jellyclaw config show [--no-redact]
jellyclaw config check
```

- **`show`** prints the effective merged `JellyclawConfig` as JSON. Secrets
  are redacted by default — `apiKey`, `authToken`, `password`, `secret`,
  `token`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`,
  `OPENCODE_SERVER_PASSWORD`, and every value under `mcp[].env` /
  `mcp[].headers` — are replaced with the literal string `[REDACTED]`.
  Pass `--no-redact` to see the raw values (useful for copying into a
  debugging shell; never paste the output into a bug report).
- **`check`** compiles the permission rules via
  [`engine/src/permissions/rules.ts`](../engine/src/permissions/rules.ts) and
  lints the MCP block (duplicate server names, transport / field mismatch).
  Each warning prints as `⚠ <location>: <message>`. Exits 0 when clean,
  1 when any warning fires.

Both commands resolve config the same way as the library entrypoint:

1. `--config-path` if provided.
2. `./jellyclaw.json` in `cwd`.
3. Built-in defaults (no file on disk).

## `doctor`

```
jellyclaw doctor
```

Runs install checks:

- Node `>=20.18`
- `opencode-ai` version matches the pinned range
- `ANTHROPIC_API_KEY` reachable
- `OPENROUTER_API_KEY` reachable (optional)
- `~/.jellyclaw/` exists and is writable
- Every configured MCP server connects

Output is a pretty table. Exits 0 when every check passes, 1 otherwise.
Implementation lives in `engine/src/cli/doctor.ts` (Agent A's surface for
Phase 10.01).

## Exit codes

| Code | Meaning                                                                      |
|------|------------------------------------------------------------------------------|
| 0    | Success.                                                                     |
| 1    | Generic failure (uncaught exception, doctor check failed, config warning).   |
| 2    | User error (bad flag, missing prompt, `--resume`/`--continue` conflict, Commander validation failure, known typed errors like `BindViolationError` / `OpenCodeVersionError`). |

Commander `--help` / `--version` paths map to 0 (they are not errors).

## Environment variables

| Variable                | Read by               | Purpose                                                          |
|-------------------------|-----------------------|------------------------------------------------------------------|
| `ANTHROPIC_API_KEY`     | provider / doctor     | API key for the Anthropic provider (primary).                    |
| `OPENROUTER_API_KEY`    | provider / doctor     | API key for the OpenRouter provider (secondary / fallback).      |
| `ANTHROPIC_BASE_URL`    | provider              | Override for the Anthropic API base URL (proxies, mock servers). |
| `OPENROUTER_BASE_URL`   | provider              | Override for the OpenRouter API base URL.                        |
| `JELLYCLAW_TOKEN`       | `serve`               | Bearer token for the HTTP server (Phase 10.02).                  |
| `JELLYCLAW_HOME`        | session store, skills | Override for `~/.jellyclaw`.                                     |
| `JELLYCLAW_LOG_LEVEL`   | logger                | Pino level (`trace` / `debug` / `info` / `warn` / `error`).      |
| `JELLYCLAW_PROVIDER`    | config loader         | Override the active provider (`anthropic` / `openrouter`).       |
| `JELLYCLAW_MODEL`       | config loader         | Override the active model id.                                    |
| `JELLYCLAW_ACKNOWLEDGE_CACHING_LIMITS` | config loader | Set to `1` to pass the OpenRouter caching-gate check.         |
| `NODE_ENV`              | logger                | When `production`, the logger disables pretty-print by default.  |

Unknown `JELLYCLAW_*` variables are ignored silently. The logger redacts
`apiKey`, `api_key`, `password`, `authorization`, `ANTHROPIC_API_KEY`,
`OPENROUTER_API_KEY`, and `OPENCODE_SERVER_PASSWORD` from every log record —
see [`engine/src/logger.ts`](../engine/src/logger.ts).

## Genie-compat flag deltas

Attribution: copied from
[`integration/GENIE-INTEGRATION.md`](../integration/GENIE-INTEGRATION.md)
§2.5. The delta table documents every flag whose name or default differs
from the prior Claurst surface Genie was built against.

| Claurst flag                           | jellyclaw flag                 | Notes                                       |
|----------------------------------------|--------------------------------|---------------------------------------------|
| `-p`                                   | `run --print`                  | OpenCode / jellyclaw use subcommand form.   |
| `--max-budget-usd`                     | `--max-cost-usd`               | Renamed to align with OpenCode.             |
| `--permission-mode bypass-permissions` | `--permission-mode bypass`     | Shortened.                                  |
| _(not available)_                      | `--session-id <uuid>`          | Resume support.                             |
| _(not available)_                      | `--stream-stderr jsonl`        | Structured stderr.                          |
| _(not available)_                      | `--fallback-provider`          | Provider failover.                          |
| _(not available)_                      | `--config-dir`                 | Explicit config path — do not rely on `$HOME`. |

Genie consumers migrating off the Claurst spawn path should update their
`args` vector as shown in §2.5 of that document.

## Known limitations

Phase 10.01 intentionally scopes this CLI to the synchronous, single-process
surface. The following gaps are tracked for Phase 10.02:

- **`serve` ships the HTTP surface but the engine loop behind it is
  stubbed.** The Hono app, bearer auth, CORS lockdown, SSE reconnect via
  `Last-Event-Id`, and the `0.0.0.0` bind safeguards are live in Phase
  10.02. The events streamed over SSE, however, come from the Phase-0
  echo loop; real tool calls, thinking blocks, and subagent events land
  with the engine-loop wiring in Phase 10.03+. See
  [`docs/http-api.md`](http-api.md#phase-1002-limitations) for the
  contract-level gap list.
- **`--resume` / `--continue` are partial.** Phase 10.01 wires the
  cache-hit short-circuit (wish-id replay) but cannot yet rehydrate full
  session state from the on-disk store. Resume-from-session is a Phase
  10.02 deliverable.
- **`mcp list` does not expose tool schemas.** The table shows namespaced
  tool names only. `mcp show <server>` with per-tool input-schema dumps
  is deferred.
- **`config check` does not cross-check hooks.** Hook command existence,
  permission-bit sanity, and `matcher` regex validity are validated at
  hook-runtime, not at config-check time. A stricter lint may land in
  Phase 08.03 follow-ups.
