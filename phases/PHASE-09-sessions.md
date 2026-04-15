---
phase: 09
name: "Session persistence + resume"
duration: "2 days"
depends_on: [03]
blocks: [10, 11]
---

# Phase 09 — Session persistence + resume

## Dream outcome

`jellyclaw run --resume <id>` rehydrates a session with its full transcript, todos, and memory. `--continue` picks up the most recent session for the current project. Every turn is append-only-logged to JSONL; an SQLite FTS5 index enables `jellyclaw sessions search "auth bug"`. An idempotency log at `~/.jellyclaw/wishes/` prevents double-execution of the same wish id.

## Deliverables

- `engine/src/session/store.ts` — JSONL writer (append-only, fsync on turn end)
- `engine/src/session/index.ts` — SQLite FTS5 index (better-sqlite3)
- `engine/src/session/resume.ts` — rehydration
- `engine/src/session/idempotency.ts` — wish ledger
- CLI: `jellyclaw sessions list|search|show|rm`
- Tests
- `docs/sessions.md`

## Layout

```
~/.jellyclaw/
  sessions/
    <project-hash>/
      <session-id>.jsonl        # events in order
      <session-id>.meta.json    # summary, model, cost, last_turn_ts
    index.sqlite                # FTS5 over jsonl
  wishes/
    <wish-id>.json              # { status, session_id, started_at, finished_at, cost }
```

`project-hash` = `sha1(cwd)` short.

## Step-by-step

### Step 1 — JSONL writer
Append event line on every emit. `fsync` once per turn end (not per line — too slow). Rotate at 100 MB.

### Step 2 — Meta
On turn end, update `.meta.json`: last assistant message (first 240 chars), model, cumulative usage.

### Step 3 — SQLite FTS5
`better-sqlite3` opens `index.sqlite`. Schema:
```sql
CREATE VIRTUAL TABLE sessions USING fts5(
  session_id UNINDEXED, project_hash UNINDEXED,
  role, content, ts UNINDEXED
);
```
On each assistant message, insert row. Reindex command: `jellyclaw sessions reindex`.

### Step 4 — Resume
`resume(sessionId)` reads jsonl, replays events into engine state (messages, todos, memory). Skip tool outputs older than a configurable cutoff if context is tight; re-fetch on demand.

### Step 5 — `--continue`
Find newest session for current `project-hash`. Error if none.

### Step 6 — Idempotency
Wish ledger: before running a wish with `--wish-id=<id>`, check `~/.jellyclaw/wishes/<id>.json`:
- missing → proceed, create file with `status: running`
- `status: running` → refuse unless `--force`
- `status: done` → return cached result without re-running
- `status: failed` → allow retry, bump `attempt`

### Step 7 — CLI
```
jellyclaw sessions list                  # latest 20, project-filtered
jellyclaw sessions search "auth bug"     # FTS5
jellyclaw sessions show <id>             # pretty-print
jellyclaw sessions rm <id>               # archive to sessions/.trash/
```

### Step 8 — Tests
- Resume round-trip: 20-turn session → resume → state equal
- FTS5 finds terms across sessions
- Idempotency: concurrent same wish-id → second refused
- JSONL corruption: truncated last line recovered (skip + warn)

## Acceptance criteria

- [ ] Session jsonl written on every turn, survives crash mid-turn (partial line discarded)
- [ ] Resume reproduces state exactly
- [ ] `--continue` picks correct session per project
- [ ] FTS5 search returns hits in <100 ms on 1000-session corpus
- [ ] Idempotency prevents double-execution
- [ ] CLI commands all functional

## Risks + mitigations

- **Transcript size** → rotate + compress sessions older than 30 d (gzip `.jsonl.gz`).
- **Cross-machine sync** (future) → leave hook; store is filesystem-based.
- **SQLite corruption** → `PRAGMA integrity_check` on boot; auto-reindex from jsonl if corrupt.

## Dependencies to install

```
better-sqlite3@^11
```

## Files touched

- `engine/src/session/{store,index,resume,idempotency}.ts`
- `engine/src/cli/sessions.ts`
- `engine/src/session/*.test.ts`
- `docs/sessions.md`
