# Phase 08 Hosting — Prompt T5-04: Swap better-sqlite3 → bun:sqlite (single-binary unblock)

**When to run:** Independent of other T5 prompts. Must land before any release-binary CI.
**Estimated duration:** 3–4 hours
**New session?** Yes.
**Model:** Claude Opus 4.6 (1M context).

## Context

Agent 3's `docs/hosting/03-tui-distribution.md` §"Native-addon caveat" flagged the blocker: `better-sqlite3` is a native addon. Bun's `bun build --compile` can embed `.node` files, but **cross-compilation can't build them** — we can't produce `bun-linux-arm64-musl` from a mac host without a native builder. The fix: swap to `bun:sqlite` (Bun's built-in, zero native-addon footprint).

Two places use `better-sqlite3`:
1. `engine/src/session/db.ts` — the session index at `~/.jellyclaw/sessions/index.sqlite` (WAL, migrations, lifecycle).
2. `engine/src/daemon/store.ts` — the background daemon's store.

We want **dual support**: jellyclaw must keep working under `node` (for `npx`, Docker CI, users without Bun) AND under `bun` (for the single-file binary). Clean approach: a thin adapter that picks the right backend at import time — `bun:sqlite` when `typeof Bun !== "undefined"`, `better-sqlite3` otherwise.

## Research task

1. Read `engine/src/session/db.ts` in full. Inventory every `better-sqlite3` call: `new Database(path)`, `db.pragma(...)`, `db.prepare(...).run(...)`, `db.exec(...)`, `db.close()`, migration loop.
2. Read `engine/src/daemon/store.ts`. Lines 13, 14, 107, 134, 286 reference `better-sqlite3`. Inventory every method used on the `Database` handle.
3. Read Bun's SQLite docs at `https://bun.sh/docs/api/sqlite` — key differences from `better-sqlite3`:
   - `import { Database } from "bun:sqlite"` (named, not default)
   - `new Database(path, { create: true })` — `create` flag is Bun-specific
   - `db.query(sql)` + `.all()/.get()/.run()` — `db.prepare(sql)` also works (alias)
   - `db.exec(sql)` — supported, handles multi-statement SQL
   - `db.pragma()` — **does not exist** on Bun. Emulate with `db.query("PRAGMA ... = ...").get()`
   - `db.transaction(fn)` — supported identically
4. `Grep` the repo for `better-sqlite3`. Every import site is a migration target.
5. Read `engine/package.json` — confirm `better-sqlite3` is listed. Stays listed (Node fallback still uses it).
6. Read `engine/src/session/writer.ts` and `engine/src/session/writer.test.ts` — the heaviest prepared-statement user; the regression surface.
7. Check migration SQL file loader — `MIGRATIONS` in `db.ts` uses `readFileSync` on a URL. Both backends' `db.exec(sql)` accept multi-statement SQL; no change needed beyond the adapter.

## Implementation task

Scope: introduce a dual-backend SQLite adapter; update the two consumer modules to import from the adapter; prove the swap by compiling a single-file binary.

### Files to create / modify

- `engine/src/db/sqlite.ts` — **new.** Adapter interface + runtime picker (~80 LOC).
- `engine/src/db/sqlite-bun.ts` — **new.** Bun-backed impl (~60 LOC).
- `engine/src/db/sqlite-better.ts` — **new.** `better-sqlite3`-backed impl (~60 LOC).
- `engine/src/db/sqlite.test.ts` — **new.** API parity tests on an in-memory DB (~80 LOC).
- `engine/src/session/db.ts` — MODIFY. Replace `import Database from "better-sqlite3"` with `import { type SqliteDatabase, openSqlite } from "../db/sqlite.js"`. Rewire `new Database(path)` and `.pragma(...)`.
- `engine/src/daemon/store.ts` — MODIFY. Same pattern.
- `engine/src/session/writer.ts` — check `import type { Statement } from "better-sqlite3"`; re-point to the adapter's `SqliteStatement`.
- `engine/package.json` — leave `better-sqlite3` as a regular dep (Node path still uses it).
- `COMPLETION-LOG.md` — append entry.

### Adapter API (`engine/src/db/sqlite.ts`)

```ts
export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  /** Two-arg form: `db.pragma("journal_mode", "WAL")`. Normalizes both backends. */
  pragma(key: string, value?: string | number): unknown;
  transaction<Args extends unknown[], R>(fn: (...args: Args) => R): (...args: Args) => R;
  close(): void;
}

export interface SqliteStatement {
  run(params?: unknown): { changes: number; lastInsertRowid: number | bigint };
  get(params?: unknown): unknown;
  all(params?: unknown): unknown[];
  iterate(params?: unknown): IterableIterator<unknown>;
}

export async function openSqlite(path: string): Promise<SqliteDatabase> {
  if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") {
    const mod = await import("./sqlite-bun.js");
    return mod.openBun(path);
  }
  const mod = await import("./sqlite-better.js");
  return mod.openBetter(path);
}
```

### Bun backend sketch (`sqlite-bun.ts`)

```ts
import { Database } from "bun:sqlite";
// openBun: new Database(path, { create: true }) → wrap:
//   exec(sql) → db.exec(sql)
//   prepare(sql) → wrap db.query(sql)
//   pragma(key, value) → db.query(value !== undefined ? `PRAGMA ${key} = ${value}` : `PRAGMA ${key}`).get()
//   transaction(fn) → db.transaction(fn)
//   close() → db.close()
// wrapStatement: run → { changes, lastInsertRowid }; get / all / iterate forward.
```

### Node backend sketch (`sqlite-better.ts`)

```ts
import Database from "better-sqlite3";
// openBetter: new Database(path) → wrap:
//   exec(sql) → db.exec(sql)
//   prepare(sql) → wrap db.prepare(sql)
//   pragma(key, value) → db.pragma(value !== undefined ? `${key} = ${value}` : key)
//   transaction(fn) → db.transaction(fn)
//   close() → db.close()
// wrapStatement: forward run / get / all / iterate.
```

### Consumer API shift

`better-sqlite3`'s `.pragma("journal_mode = WAL")` (one-string) becomes `.pragma("journal_mode", "WAL")` (two-arg). The adapter normalizes. Pick the two-arg form and commit — every call site changes to match.

`openSqlite(path)` is async because of the dynamic `import(...)` — every caller must `await` it. This is a cascading refactor: audit `session/db.ts` + `daemon/store.ts` + every test that opens a DB; thread `await` through.

### Shell commands

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine
bun run typecheck
bun run test engine/src/db/
bun run test engine/src/session/          # regression — all session writer tests
bun run test engine/src/daemon/            # regression
bun run lint
bun run build

# The headline smoke — single-binary compilation. If this fails, T5-04 isn't done.
bun build --compile --minify --sourcemap \
  --target=bun-darwin-arm64 \
  engine/src/cli/main.ts \
  --outfile dist/jellyclaw-darwin-arm64
ls -lh dist/jellyclaw-darwin-arm64
# Expect: ~55–90 MB binary (per Agent 3's size target).

# Compiled-binary smoke: --version, doctor, run
./dist/jellyclaw-darwin-arm64 --version
./dist/jellyclaw-darwin-arm64 doctor 2>&1 | head -20
# Expect: clean; NO "better-sqlite3 .node not found" errors
./dist/jellyclaw-darwin-arm64 run "what is 2 + 2" --permission-mode bypassPermissions --max-turns 2 2>&1 | head -30
# Expect: model answers; session DB at ~/.jellyclaw/sessions/index.sqlite was written by bun:sqlite

# Node regression path
node engine/dist/cli/main.js --version
node engine/dist/cli/main.js doctor 2>&1 | head -20
# Expect: identical output via Node + better-sqlite3 path
```

### Expected output

- `bun run test engine/src/db/sqlite.test.ts` — passes under whichever runtime is running the tests.
- Session-writer + daemon tests pass (zero regression).
- `bun build --compile --target=bun-darwin-arm64` succeeds; produces a self-contained binary with NO `.node` in the bundle.
- Compiled binary runs `--version`, `doctor`, `run` end-to-end.
- Node path still uses `better-sqlite3` (dual support preserved).
- Adapter API is small, typed, covers every call site.

### Tests to add

- `engine/src/db/sqlite.test.ts`:
  - Open `":memory:"` DB; CREATE TABLE; INSERT; SELECT — all work.
  - `pragma("journal_mode", "WAL")` returns the WAL confirmation row.
  - Transaction commits on success; rolls back on thrown error.
  - `prepare().all(params)` returns the expected rows.
  - `close()` is idempotent.
- Existing `engine/src/session/db.test.ts` + `engine/src/session/writer.test.ts` pass unchanged (the whole point of the adapter).

### Common pitfalls

- **`pragma` API is THE gotcha.** `better-sqlite3` accepts one-string; `bun:sqlite` has no `.pragma()` at all — emulate with `db.query("PRAGMA ... = ...").get()`. The adapter hides this; consumers MUST use the two-arg form.
- **`lastInsertRowid` type.** `better-sqlite3` can return `bigint`; Bun returns `number`. Union type `number | bigint` in the adapter; call sites that assume number must check.
- **In-memory DB.** `":memory:"` works in both. `new Database()` with no arg means different things — always pass an explicit path.
- **Both backends are synchronous.** `openSqlite()` is async only because of dynamic `import()` at the adapter level. Every caller awaits once; the handle is sync from then on.
- **`statement.iterate()` — streaming reads.** Audit every call site. Both backends support it; the adapter's generator forwards cleanly.
- **Don't move `better-sqlite3` to `optionalDependencies`.** Safer to leave it a regular dep. Extra ~800 KB of native addon in the Node install path is fine; it's NOT in the Bun-compiled binary.
- **Migrations loop works unchanged.** `readFileSync(url)` → `db.exec(sql)` — both backends handle multi-statement SQL. No change to the migration harness.
- **Statement-prepare caching.** If consumer code caches prepared statements across transactions, both backends preserve that. Don't refactor statement lifecycles.
- **Cross-compilation matrix (INFO).** This prompt only smoke-tests `bun-darwin-arm64` (host platform). CI later exercises darwin-x64, linux-x64, linux-arm64, windows-x64 — any of those failing is a later prompt's problem, but if `bun-darwin-arm64` fails here, STOP and diagnose.
- **Fly deploy path.** Agent 1's Dockerfile runs Node (not Bun) because of an SSE bug in Bun's hono bindings. Fly therefore uses `better-sqlite3` via the adapter. Dual support is exactly what enables this.
- **`bigint: true` isn't a thing on Bun.** Don't try to force it. Use `safeInteger` if you ever need 64-bit precision — but jellyclaw's schemas don't require it today.
- **`db.loadExtension()` isn't supported on Bun.** jellyclaw doesn't use extensions; flag only if a later schema wants FTS5 (Bun bundles FTS5 by default, just not extension loading).

## Closeout

1. Update `COMPLETION-LOG.md` with `08.T5-04 ✅` — note binary size, Bun + Node test results, number of call sites rewired.
2. Print `DONE: T5-04`.

On fatal failure: `FAIL: T5-04 <reason>`.
