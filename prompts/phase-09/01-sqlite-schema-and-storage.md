# Phase 09 — Session persistence + resume — Prompt 01: SQLite schema + storage

**When to run:** After Phase 08 is fully ✅ in `COMPLETION-LOG.md`.
**Estimated duration:** 3–4 hours
**New session?** Yes — always start a fresh Claude Code session per prompt
**Model:** Claude Opus 4.6 (1M context)

<!-- BEGIN: paste from /Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/STARTUP-TEMPLATE.md -->
<!-- STOP if Phase 08 not fully ✅. -->
<!-- END paste -->

## Research task

1. Read `/Users/gtrush/Downloads/jellyclaw-engine/phases/PHASE-09-sessions.md` in full.
2. Read `/Users/gtrush/Downloads/jellyclaw-engine/engine/SPEC.md` — session model section.
3. Use context7 to fetch `better-sqlite3@^11` docs: `prepare`, `transaction`, `pragma`, FTS5 virtual tables. Confirm the Node ABI compat story (prebuilts for Node 20/22; Bun native builds).
4. Research SQLite FTS5 tokenizer options (`porter unicode61`) so search matches stem variants.
5. Read Phase 03 event stream — the event types you'll persist are defined there.

## Implementation task

Implement the SQLite schema, single-writer queue, and durable storage layer — **no resume/idempotency logic yet** (that's prompt 02). Focus: durability and correctness under crash.

### Files to create/modify

- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/session/schema.sql` — DDL as a versioned migration.
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/session/db.ts` — better-sqlite3 open, WAL mode, pragmas, migration runner.
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/session/writer.ts` — single-writer queue (serial `Promise` chain); exposes `appendMessage`, `appendToolCall`, `updateUsage`, `upsertSession`.
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/session/fts.ts` — FTS5 index maintenance triggers.
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/session/paths.ts` — path layout helpers (project-hash, session-id filenames).
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/session/index.ts` — barrel.
- Tests: `db.test.ts`, `writer.test.ts`, `fts.test.ts`, `migration.test.ts`.
- `engine/package.json` — add `better-sqlite3@^11`.

### Layout

```
~/.jellyclaw/
  sessions/
    <project-hash>/           # project-hash = sha1(realpath(cwd)).slice(0, 12)
      <session-id>.jsonl      # primary durable log (Phase 09.02 writes this)
      <session-id>.meta.json  # denormalized quick summary
    index.sqlite              # single DB, all projects
  wishes/
    <wish-id>.json            # idempotency ledger (Phase 09.02)
```

### Schema (DDL — copy exactly)

```sql
-- version 1

PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_version (v INTEGER PRIMARY KEY);
INSERT OR IGNORE INTO schema_version (v) VALUES (1);

CREATE TABLE IF NOT EXISTS sessions (
  id                TEXT PRIMARY KEY,           -- ulid or uuid
  project_hash      TEXT NOT NULL,
  cwd               TEXT NOT NULL,
  model             TEXT,
  created_at        INTEGER NOT NULL,           -- epoch ms
  last_turn_at      INTEGER NOT NULL,
  parent_session_id TEXT,
  status            TEXT NOT NULL,              -- 'active' | 'ended' | 'archived'
  summary           TEXT                        -- first 240 chars of last assistant message
);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_hash, last_turn_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_parent  ON sessions(parent_session_id);

CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_index  INTEGER NOT NULL,
  role        TEXT NOT NULL,                    -- 'user' | 'assistant' | 'system'
  content     TEXT NOT NULL,
  ts          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_session_turn ON messages(session_id, turn_index);

CREATE TABLE IF NOT EXISTS tool_calls (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  call_id       TEXT NOT NULL,                  -- matches the model's tool_use_id
  tool_name     TEXT NOT NULL,
  input_json    TEXT NOT NULL,
  result_json   TEXT,
  duration_ms   INTEGER,
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER,
  UNIQUE(session_id, call_id)
);
CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id, started_at);

CREATE TABLE IF NOT EXISTS tokens (
  session_id     TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  input_tokens   INTEGER NOT NULL DEFAULT 0,
  output_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_creation INTEGER NOT NULL DEFAULT 0,
  cache_read     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS cost (
  session_id    TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  usd_cents     INTEGER NOT NULL DEFAULT 0      -- store cents to avoid float
);

CREATE TABLE IF NOT EXISTS wishes (
  id           TEXT PRIMARY KEY,                -- wish-id
  session_id   TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  status       TEXT NOT NULL,                   -- 'running' | 'done' | 'failed'
  attempt      INTEGER NOT NULL DEFAULT 1,
  started_at   INTEGER NOT NULL,
  finished_at  INTEGER,
  result_json  TEXT,
  error        TEXT
);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content,
  session_id UNINDEXED,
  role       UNINDEXED,
  ts         UNINDEXED,
  tokenize='porter unicode61'
);

-- keep FTS in sync
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content, session_id, role, ts)
  VALUES (new.id, new.content, new.session_id, new.role, new.ts);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content);
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content);
  INSERT INTO messages_fts(rowid, content, session_id, role, ts)
  VALUES (new.id, new.content, new.session_id, new.role, new.ts);
END;
```

### Pragmas & boot checks

- `journal_mode = WAL` (concurrent reads during writes).
- `synchronous = NORMAL` (WAL mode makes FULL unnecessary).
- `foreign_keys = ON`.
- On open: run `PRAGMA integrity_check`. If not `ok`, rename the DB to `index.sqlite.corrupt-<ts>` and start fresh; log a loud warning. Phase 09.02 will reconcile from JSONL.

### Single-writer queue

- Better-sqlite3 is synchronous; the queue prevents multiple concurrent engine coroutines from interleaving transactions.
- Implement as `this.writeQueue = this.writeQueue.then(() => fn())` with an error boundary that catches and re-exposes errors to the caller's promise.
- Batch-friendly: `db.transaction(() => { ... })` for multi-row writes.
- Never call a blocking synchronous query from a hot async path; let the queue absorb bursts.

### Migration runner

- Read `PRAGMA user_version` or the `schema_version` table.
- For v1, DDL is the initial schema. Future migrations: add files `schema.v2.sql`, etc.; runner applies in order.
- Wrap each migration in a transaction.

### Shell commands

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine
bun add better-sqlite3@^11
bun add -d @types/better-sqlite3
bun run typecheck
bun run test engine/src/session
bun run lint
```

### Expected output

- DB opens with WAL, PRAGMA integrity ok, schema applied.
- Writer inserts serialize; concurrent callers see no deadlock and no missing rows.
- FTS index populates on `messages` insert.

### Tests to add

- `db.test.ts`:
  - Opens in temp dir; pragmas set; schema applied.
  - Corrupt DB (inject bad bytes) → renamed + fresh DB created.
  - Migration idempotent: running twice is a no-op.
- `writer.test.ts`:
  - `appendMessage` under concurrent calls: ordering preserved per session; no row loss.
  - `upsertSession` creates then updates `last_turn_at`.
  - Transaction rollback on mid-batch error; DB state unchanged.
- `fts.test.ts`:
  - Insert 3 messages, search `"auth bug"`; expected hit.
  - Update message content; search reflects new text.
  - Delete message; FTS row removed.
- `migration.test.ts`:
  - v1 applied; `schema_version` updated.

### Verification

```bash
bun run test engine/src/session   # expect: green
bun run typecheck && bun run lint

# Inspect:
sqlite3 ~/.jellyclaw/sessions/index.sqlite ".schema"
# expect: tables sessions, messages, tool_calls, tokens, cost, wishes, messages_fts
```

### Common pitfalls

- better-sqlite3 requires native builds — Bun sometimes needs `bun install --force` on Apple Silicon. Document in `docs/development.md`.
- WAL mode creates `-wal` + `-shm` sidecar files — don't delete them mid-write; treat as opaque.
- FTS5 triggers: if you later ALTER the `messages` schema, you must drop + recreate triggers. Write a migration test.
- Cost stored in integer cents — never floats. A `0.001` cent mistake compounds.
- `session_id`: use ULID (`ulid` package) or a crypto-random prefix-sortable id so LIST queries are fast.
- Concurrent openers: two engine processes opening the same DB is safe in WAL mode, but write transactions still serialize at the OS level. Document that the CLI and server sharing a DB is supported.
- Do NOT store tool results > 1 MB inline — truncate with `"truncated": true` marker and keep full copy in the JSONL only.
- Backup strategy is out of scope; just ensure nothing forbids copying the DB at rest.

<!-- BEGIN: paste from /Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/COMPLETION-UPDATE-TEMPLATE.md -->
<!-- On success: 09.01 ✅, next prompt = prompts/phase-09/02-resume-and-idempotency.md. -->
<!-- END paste -->
