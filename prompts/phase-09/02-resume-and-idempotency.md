# Phase 09 — Session persistence + resume — Prompt 02: Resume, JSONL transcript, idempotency

**When to run:** After Phase 09 prompt 01 (SQLite schema) is ✅ in `COMPLETION-LOG.md`.
**Estimated duration:** 4–5 hours
**New session?** Yes — always start a fresh Claude Code session per prompt
**Model:** Claude Opus 4.6 (1M context)

<!-- BEGIN: paste from /Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/STARTUP-TEMPLATE.md -->
<!-- STOP if 09.01 not ✅. -->
<!-- END paste -->

## Research task

1. Re-read `/Users/gtrush/Downloads/jellyclaw-engine/phases/PHASE-09-sessions.md`, Steps 1–2, 4–6.
2. Read `/Users/gtrush/Downloads/jellyclaw-engine/engine/SPEC.md` — event stream format; JSONL lines are one event each.
3. Read prompt 09.01 output — understand `writer.ts` queue and schema.
4. Research JSONL durability patterns: writes → `fs.write` (append mode) → `fsync` on turn end (not per event — too slow).
5. Read Phase 03 event stream — event envelope shape you'll serialize.
6. Read Claude Code's resume behavior: does `--resume` replay all events or just restore messages? jellyclaw's choice (per phase doc): rehydrate messages, todos, and memory; skip stale tool outputs on tight context budgets.

## Implementation task

Add three capabilities on top of the Phase 09.01 storage:
1. **JSONL transcript** writer (append-only, fsync-on-turn-end, rotation).
2. **Resume / continue**: rebuild engine state from JSONL + SQLite.
3. **Idempotency ledger** at `~/.jellyclaw/wishes/<wishId>.json` preventing double-action on crash-resume.

### Files to create/modify

- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/session/jsonl.ts` — append-only writer with open file handle per session; `flush()` fsyncs; rotates at 100 MB to `<id>.jsonl.1`, `.2`, ...
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/session/meta.ts` — `.meta.json` writer; atomic rename; updates on turn end.
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/session/replay.ts` — reads JSONL line-by-line, tolerates truncated last line (skip + warn), yields events in order.
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/session/resume.ts` — `resumeSession(sessionId): EngineState` — rebuilds messages, todos, memory, cumulative usage; re-registers permission/hook/MCP/skills registries.
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/session/continue.ts` — finds newest session for current `project-hash`; errors if none.
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/session/idempotency.ts` — wish ledger: `begin(wishId)`, `complete(wishId, result)`, `fail(wishId, err)`, `check(wishId)`.
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/cli/sessions.ts` — `jellyclaw sessions list|search|show|rm`.
- Tests: `jsonl.test.ts`, `replay.test.ts`, `resume.test.ts`, `continue.test.ts`, `idempotency.test.ts`, `cli-sessions.test.ts`.
- `/Users/gtrush/Downloads/jellyclaw-engine/docs/sessions.md`.

### JSONL writer

- Per session, keep an open `fs.promises.FileHandle` in append mode (`"a"`).
- On every event: `handle.appendFile(JSON.stringify(event) + "\n")`. No flush per event.
- On turn end (`Stop` event): `await handle.sync()`; update `.meta.json` with atomic write (`.tmp` + rename).
- On rotation (size check at turn end): rename `<id>.jsonl` → `<id>.jsonl.1`, shift older, gzip files > .3 for space.
- On engine shutdown: flush all open handles.
- On crash: the last partial line is recoverable — `replay.ts` tolerates it.

### Replay semantics

- Read line-by-line using a streaming reader (`readline` on `createReadStream`).
- For each line: `JSON.parse` → typed event. On parse error of the LAST line only → skip + warn (crash mid-write). On parse error mid-file → fail loudly (corruption).
- Events are emitted in order; caller `reduce`s them into state.
- Reconstructed state:
  - `messages`: all user + assistant messages in turn_index order.
  - `todos`: final TodoWrite state.
  - `memory`: aggregated memory hints from `session.update` events.
  - `usage`: cumulative from every usage delta.

### Context-budget trimming during resume

- Config: `resume.maxContextTokens` (default = model's context window minus a safety margin).
- If rehydrated messages exceed budget:
  - Drop oldest `tool_result` payloads first (keep the `tool_use` call, replace result with `"<dropped on resume; re-fetch if needed>"`).
  - Then summarize oldest conversation turns (delegate to the compaction code path from Phase 08's `PreCompact`).
- Never drop the most recent user prompt or the active tool call chain.

### Idempotency ledger

- File per wish: `~/.jellyclaw/wishes/<wish-id>.json`.
- On `--wish-id <id>`:
  1. `check(id)`:
     - File missing → create `{ status: "running", started_at, attempt: 1 }`, proceed.
     - `status: "running"` → **refuse** unless `--force`; exit with error `"wish <id> already running (attempt <n>) since <ts>. Pass --force to override."`.
     - `status: "done"` → return cached `result_json` immediately without running. CLI prints `"(cached)"`.
     - `status: "failed"` → allow retry; bump `attempt`; set `status: "running"`.
  2. On completion: write `{ status: "done", finished_at, result_json }`.
  3. On failure (caught exception) → `{ status: "failed", finished_at, error }`.
  4. Writes are atomic (`.tmp` + rename) so a crash leaves either the old or new state, never a torn write.
- Cross-indexed into the SQLite `wishes` table (from 09.01) for searchability.

### CLI: `jellyclaw sessions *`

- `jellyclaw sessions list [--project <hash>|--all] [--limit 20]` — query SQLite `sessions` table; pretty table output.
- `jellyclaw sessions search "<query>" [--project <hash>]` — FTS5 search; result: session-id + snippet.
- `jellyclaw sessions show <id>` — pretty-print messages + tool_calls.
- `jellyclaw sessions rm <id>` — move JSONL + meta to `sessions/.trash/<id>/`; set `status='archived'` in SQLite; don't actually delete (recoverable).

### Shell commands

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine
bun run typecheck
bun run test engine/src/session
bun run lint
```

### Expected output

- 20-turn session → resume → state matches byte-for-byte on messages/todos/cumulative usage.
- Truncated last line → replay drops it + warn; resume still works.
- Concurrent same wish-id → second invocation refused.
- `sessions search` returns hits within 100 ms on a 1000-session corpus.

### Tests to add

- `jsonl.test.ts` — append, rotate, gzip threshold, fsync on turn end.
- `replay.test.ts` — well-formed file → events in order; truncated last line → skip + warn; mid-file corruption → throw.
- `resume.test.ts`:
  - Round-trip: 20 turns → resume → deep-equal messages + todos + usage.
  - Stale tool_result dropping triggered when over budget; active chain untouched.
- `continue.test.ts` — picks newest per project-hash; no sessions → explicit error.
- `idempotency.test.ts`:
  - Fresh wish runs and stores `done`.
  - Second run with same id returns cached (no re-execution).
  - Concurrent start → second refused.
  - `--force` override allowed.
  - Torn-write simulation (kill mid-write) → file is either old or new, never malformed.
- `cli-sessions.test.ts` — CLI commands functional end-to-end; search returns expected hit.

### Verification

```bash
bun run test engine/src/session   # expect: green
bun run typecheck && bun run lint

# Smoke
./dist/cli.js run "hello world"
SID=$(./dist/cli.js sessions list --limit 1 | awk 'NR==2 {print $1}')
./dist/cli.js run --resume "$SID" "what did we talk about?"
./dist/cli.js run --continue "what did we talk about?"
./dist/cli.js sessions search "hello"
# expect: resume + continue work; search returns the session
```

Idempotency smoke:

```bash
./dist/cli.js run --wish-id demo-1 "create a file test.txt with 'hi'"
./dist/cli.js run --wish-id demo-1 "create a file test.txt with 'hi'"
# second prints "(cached)" and does not re-run
./dist/cli.js run --wish-id demo-1 --force "..."   # overrides
```

### Common pitfalls

- `fsync` costs ~5–20 ms per call; per-event fsync is unusable. Per-turn-end fsync is the compromise. Document.
- Rotation: never rotate mid-turn. Always at turn boundary.
- Replay must be deterministic — same input → same state. Avoid `Date.now()` inside reducers; use the event's embedded `ts`.
- Resume with MCP: the MCP server state is NOT restored (browser tabs, sessions, etc.); document that resume restarts MCP servers cleanly.
- Stale tool_result trimming: keep the exact SAME `tool_use_id` for the `tool_use` call; only the `tool_result` content is replaced. The model's structural expectations must hold.
- Idempotency under load: use `fs.open(path, "wx")` (exclusive-create) to atomically grab the wish; if EEXIST, read + inspect status.
- The SQLite `wishes` table (from 09.01) and the `~/.jellyclaw/wishes/<id>.json` files must stay in sync. Wrap updates in a transaction that does both; on mismatch at boot, the file wins (filesystem is source of truth).
- `sessions rm` is reversible — never `rm -rf`. Write a test that un-archiving works.
- JSONL read: use a streaming reader; `readFile` for multi-GB files OOMs.

<!-- BEGIN: paste from /Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/COMPLETION-UPDATE-TEMPLATE.md -->
<!-- On success: Phase 09 fully ✅, next prompt = prompts/phase-10/01-cli-entry-point.md. -->
<!-- END paste -->
