-- version 1
--
-- Jellyclaw session index schema. Applied by `db.ts` migration runner on
-- first open. Future migrations live as `schema.v2.sql`, etc.; runner
-- applies in order, each wrapped in a transaction.
--
-- Do NOT inline this file's PRAGMAs into `db.ts` — the runner needs to
-- execute them verbatim so `sqlite3 <db> ".schema"` output matches source.

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
  DELETE FROM messages_fts WHERE rowid = old.id;
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
  DELETE FROM messages_fts WHERE rowid = old.id;
  INSERT INTO messages_fts(rowid, content, session_id, role, ts)
  VALUES (new.id, new.content, new.session_id, new.role, new.ts);
END;
