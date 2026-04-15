# Sessions

Jellyclaw persists every wish — every tool call, token usage update, and
assistant message — to a durable, append-only log on disk. The session store
is the source of truth for resume, continue, and full-text search; the
`jellyclaw sessions` CLI is the primary way humans browse it.

This document covers the on-disk layout, the CLI, the durability model, and
the resume / idempotency semantics.

## Overview

Two artifacts per session:

1. **`<id>.jsonl`** — append-only NDJSON of `AgentEvent` values. One line per
   event. Never rewritten; only rotated.
2. **`<id>.meta.json`** — denormalized summary (model, status, last-turn
   timestamp, cumulative usage, 240-char summary). Written atomically via
   `<final>.<randomHex>.tmp` + `rename()`.

A single SQLite index (`sessions/index.sqlite`) is a **derived cache** over
the JSONL: it powers `sessions list` and the FTS search. If the DB ever
disagrees with the JSONL, **the filesystem wins** — the DB can be deleted
and rebuilt from JSONL (reindex in a future phase).

Durability:

- Every `write(event)` appends one NDJSON line. Not `fsync`ed per event.
- `flushTurn()` issues one `fsync` at the end of every turn and on graceful
  shutdown — survives any crash except a kernel-level disk failure.
- Meta files are written via atomic rename: readers either see the old meta
  or the new meta, never a torn byte-range.
- SQLite runs in `WAL` mode with `synchronous = NORMAL`.

Replay tolerates exactly one torn final line (the one the process was
mid-writing on crash); any corruption earlier than that is a hard error.

## File layout

```
~/.jellyclaw/
  sessions/
    <project-hash>/                     project-hash = sha1(realpath(cwd)).slice(0,12)
      <session-id>.jsonl                durable event log
      <session-id>.jsonl.1              rotated shards (100 MB threshold)
      <session-id>.jsonl.2
      <session-id>.jsonl.3
      <session-id>.jsonl.4.gz           gzipped beyond .3
      <session-id>.meta.json            atomic-write summary
    .trash/
      <project-hash>/<session-id>/...   `sessions rm` moves files here
    index.sqlite                        FTS + list index (cache, not SoT)
  wishes/
    <wish-id>.json                      idempotency ledger (Phase 09.02)
```

Project hashes bucket sessions by working directory. Two checkouts at the
same path collide, by design — the path IS the identity.

## CLI reference

All commands honour `JELLYCLAW_HOME` to override `~/.jellyclaw`. This is
how tests keep themselves isolated and how you can maintain multiple
separate stores (e.g. one per machine identity).

### `jellyclaw sessions list`

```
jellyclaw sessions list [--project <hash>|--all] [--limit 20]
```

- Default: filters to sessions whose `project_hash = sha1(realpath(cwd))`.
  This matches Claude Code's "show me the sessions for *this* project"
  behaviour.
- `--project <hash>` — explicit bucket override.
- `--all` — cross-project, including archived.
- Excludes `status = 'archived'` unless `--all`.
- Ordered by `last_turn_at DESC`.

Example output:

```
ID            UPDATED              MODEL          STATUS   SUMMARY
01J1...       2026-04-15 11:12:33  sonnet-4-6     active   Fix auth bug in login flow
01J0...       2026-04-14 22:07:02  sonnet-4-6     ended    Refactor widget pane
```

Timestamps are always rendered in UTC (`YYYY-MM-DD HH:MM:SS`) with a fixed
`en-US` locale so output is deterministic across machines.

### `jellyclaw sessions search`

```
jellyclaw sessions search "<query>" [--limit 20]
```

FTS5 over message content. The query is sanitized before binding — see
[Search](#search) below. One hit per line: `<session-id>  <role>  <snippet>`.

If stdout is a TTY, the FTS `<b>...</b>` snippet highlights are rendered as
ANSI bold; otherwise they are stripped.

### `jellyclaw sessions show`

```
jellyclaw sessions show <id>
```

Loads `.meta.json`, replays the JSONL, reduces to `EngineState`, and
pretty-prints:

```
session 01J1...
  project   abc123def456
  cwd       /Users/alice/src/foo
  model     sonnet-4-6
  status    ended
  created   2026-04-15 10:11:12
  lastTurn  2026-04-15 11:12:33

messages:
[user] fix the login bug

[assistant] I'll start by reading the auth handler...

tool calls:
  tool Read({"path":"/src/auth.ts"}) -> {"bytes":1402} (12ms)
  tool Edit(...) -> {"ok":true} (33ms)

usage:
  input  1205 tokens
  output 330 tokens
  cache  0 read / 0 write
  cost   $0.0042
```

If the session is unknown, exit code 1 and `session not found: <id>` to
stderr.

### `jellyclaw sessions rm`

```
jellyclaw sessions rm <id>
```

**Non-destructive.** Moves `<id>.jsonl`, every `<id>.jsonl.N[.gz]` shard, and
`<id>.meta.json` into `~/.jellyclaw/sessions/.trash/<project-hash>/<id>/`,
preserving filenames. Then updates `sessions.status = 'archived'` in the DB.

A subsequent `sessions list` hides the session; `sessions list --all` still
shows it. Recover by moving files back out of `.trash` and re-running
reindex (when it lands). No retention — the trash grows forever; prune it
yourself.

Unknown session → exit 1.

### `jellyclaw sessions reindex`

Stub. Prints a deferred-to-later notice and exits 0. Phase 09.03+ will
rebuild the SQLite cache from the JSONL canonical files.

## Resume & continue

**Not yet wired into `jellyclaw run`.** Phase 09.02 delivered the pure
reducer (`reduceEvents`), the `.meta.json` sidecar, and the session index.
The CLI wiring for `--resume <id>` / `--continue` lands in Phase 10 along
with the live engine loop.

What the library surface already supports:

- `replayJsonl(path)` streams the NDJSON back into validated `AgentEvent`
  values with tolerant-tail handling.
- `reduceEvents(events, { truncatedTail })` folds the event sequence into
  a fully-typed `EngineState` (messages, tool calls, permissions, usage,
  `lastSeq`/`lastTs`).
- `readSessionMeta(paths, projectHash, id)` returns the sidecar.

The reducer is **pure** and deterministic: same JSONL input → same
`EngineState`. Tool-result events are matched to their preceding
`tool.called` by id (reverse-scan, most-recent-unresolved wins); a crash
mid-tool-call leaves the tool entry with `result: null` and the caller
decides whether to prune or re-emit.

An unfinished assistant message (`final: false` at crash) is flushed as a
partial `ReplayedMessage` so rendering never silently drops bytes.

## Idempotency (`--wish-id`)

Long-running wishes — especially triggered from CI or a scheduler — need to
be replay-safe: if the orchestrator retries the same wish twice, Jellyclaw
must recognise the second call as a duplicate rather than re-running it.

The wish ledger at `~/.jellyclaw/wishes/<wish-id>.json` tracks each wish's
lifecycle. `WishCheckOutcome` is one of:

- **`fresh`** — first time we've seen this id; begin normally.
- **`cached`** — this id previously completed (`status = 'done'`); replay
  the cached result without re-executing.
- **`running`** — another process is actively holding this id. Callers
  should either wait or pass `--force` to take over.
- **`retry`** — previous attempt failed (`status = 'failed'`); caller may
  re-run.

The ledger is maintained via atomic writes (tmp-file + rename) so there's
never a half-written ledger entry. SQLite's `wishes` table mirrors the
ledger for easy queries; on divergence, the filesystem ledger wins.

`--force` skips the running-conflict check and takes over the id,
incrementing `attempt`. Use it when you are certain the previous worker is
dead (e.g. after a reboot).

## Context trimming

`ResumeOptions.maxContextTokens` (soft cap) triggers trimming when the
rehydrated transcript is too large to feed back into the model.

Trimming rules:

1. Oldest `tool.result` payloads are dropped first. The `tool_use` id and
   the placeholder string (default: `<dropped on resume; re-fetch if
   needed>`) are retained so the model's structural expectations still hold.
2. If still over budget, oldest turns are summarised into a
   `system`-role message at the front of the transcript.
3. The active tool-call chain (any `tool.called` without a matching
   `tool.result`) is **always** preserved, even if its age would otherwise
   cull it.

Dropped tool-result bodies are still on disk in the JSONL (and, up to the
1 MB inline limit, in the SQLite `tool_calls.result_json` column), so
callers can lazy-rehydrate a specific result by `tool_id`.

## Search

FTS5 powers `sessions search`. The virtual table `messages_fts` is
populated exclusively by triggers in `schema.sql` (`messages_ai`,
`messages_au`, `messages_ad`); writers never touch it directly.

Tokenizer: `porter unicode61`. Queries are sanitized in `fts.ts`: each
whitespace-separated token is stripped of fts5 metacharacters and wrapped
in double quotes, then joined with implicit AND. This means:

- `auth bug` → `"auth" "bug"` (all hits contain both terms).
- Boolean operators (`OR`, `NOT`), column filters (`role:user`), and prefix
  matches (`auth*`) are NOT supported today. A future `--advanced` flag may
  opt in to raw fts5 syntax.
- Arbitrary characters including `"`, `*`, `(`, `:` never throw.

Empty queries short-circuit to zero hits.

## Rotation & cleanup

JSONL rotation at 100 MB (override via `DEFAULT_ROTATE_BYTES` or
`OpenJsonlOptions.rotateBytes`):

- `<id>.jsonl` → `<id>.jsonl.1`
- `.1` → `.2`, `.2` → `.3`
- `.3` and beyond are gzipped (streamed; never held in memory) into
  `.N.gz`.
- Rotation MUST only be called at turn boundary — at any other point there
  may be a write in flight.

No retention cap — disk is cheap, deleting a user's history is expensive.
`sessions rm` moves files into `.trash/` but never deletes them.

## MCP servers on resume

When a session is resumed after a crash or cold-start, MCP servers are
**restarted fresh**. No state is restored:

- Browser-automation tabs are NOT re-attached.
- HTTP session cookies / bearer tokens in an MCP server are lost.
- Background subscriptions, long polls, and WebSocket connections are
  re-established from scratch.

This is the conservative choice: MCP servers are third-party code, many of
them hold connections that may have timed out anyway, and the event log
only records the tool-call boundaries. Recover any server-side state by
re-running whatever tool established it (e.g. re-open the browser tab).

## Known limitations (Phase 09.02)

- **Todos and memory** are not reconstructed by the reducer. The
  `AgentEvent` union does not yet carry todo-list or memory variants;
  Phase 10's engine loop will add them and the reducer will extend to
  reconstruct both.
- **No live `--resume` on `run`.** The CLI stub does not persist today, so
  there is no session to resume from. Wiring lands with Phase 10.
- **Reindex not implemented.** `sessions reindex` prints a deferred notice.
  Until then, if you lose `index.sqlite`, delete it and `openDb` will
  recreate a fresh (empty) copy — your JSONL transcripts remain intact but
  won't appear in `list` / `search` until reindex lands.
- **Trash is not pruned.** Manually remove `~/.jellyclaw/sessions/.trash/`
  when you want the disk back.
