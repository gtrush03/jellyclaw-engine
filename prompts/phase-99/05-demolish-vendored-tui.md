# Phase 99 — Unfucking — Prompt 05: Demolish vendored OpenCode + slim TUI client

**When to run:** Can run in parallel with 04 (no dependency on stream-json work). Run after 99-03.
**Estimated duration:** ~90 minutes
**New session?** Yes
**Model:** Claude Opus 4.6 (1M context)

<!-- BEGIN SESSION STARTUP -->
<!-- Use /Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/STARTUP-TEMPLATE.md -->
<!-- Phase doc: /Users/gtrush/Downloads/jellyclaw-engine/phases/PHASE-99-unfucking.md -->
<!-- Working API key for live tests: <REDACTED_API_KEY> -->
<!-- END SESSION STARTUP -->

---

## Pre-flight (run first to confirm starting state)

```bash
# Confirm vendored tree exists and size (~899M — mostly node_modules)
du -sh /Users/gtrush/Downloads/jellyclaw-engine/engine/src/tui/_vendored/
# Expected: 899M (893M node_modules + 5.3M opencode/)

# Confirm the `void` bypass is still present in tui.ts (lines ~458-460)
grep -n "void spawnServer" /Users/gtrush/Downloads/jellyclaw-engine/engine/src/cli/tui.ts
# Expected: single hit around line 458

# Confirm spawnStockTui is still the default path
grep -n "spawnStockTui\|_vendored/opencode" /Users/gtrush/Downloads/jellyclaw-engine/engine/src/cli/tui.ts
```

## Why this exists

`engine/src/cli/tui.ts:458-460` deliberately suppresses the embedded-server + SDK-adapter path with `void spawnServer; void waitHealth; void launchTui;` and falls through to `spawnStockTui()` (lines 232-294), which spawns the vendored OpenCode TUI as a standalone `bun run src/index.ts` subprocess (see line 279). The vendored tree at `engine/src/tui/_vendored/` is **899M total** (893M in a hoisted `node_modules/`, 5.3M in `opencode/`) and completely bypasses jellyclaw's engine — it talks directly to Anthropic with its own keys and its own agent loop. It must die before the new Ink TUI (prompt 06) lands.

Separately, `launchTui()` via `engine/src/tui/sdk-adapter.ts` is wired only along the `attach` subcommand (tui.ts:417-444), which nobody reaches because default-action users don't pass `attach <url>`.

## Files to read first

1. `engine/src/cli/tui.ts` — full file (504 lines). Key regions:
   - lines 186-294: `SpawnStockTuiOptions` + `ensureAnthropicKey` + `spawnStockTui` (the vendored spawn).
   - lines 417-444: `attach` path (uses `launchTui` — the real code path).
   - lines 446-474: the `void spawnServer; void waitHealth; void launchTui;` bypass + `spawnStockTui` fall-through.
2. `engine/src/tui/_vendored/opencode/jellyclaw-bridge.ts` (876 bytes).
3. `engine/src/tui/_vendored/opencode/package.json` (5954 bytes) — the vendored app's manifest.
4. `engine/src/tui/sdk-adapter.ts` — translates between OpenCode SDK shape and jellyclaw HTTP (441 lines). Keep as basis for slimmed `client.ts`.
5. `engine/src/tui/event-map.ts` — server emits canonical event names; only called from sdk-adapter.ts:414. Delete once adapter is slimmed.
6. `engine/src/cli/credentials.ts` (164 lines) + `credentials-prompt.ts` — KEEP, reused in prompt 06. The storage shape today is just `{anthropicApiKey?: string, openaiApiKey?: string}` at `~/.jellyclaw/credentials.json` mode 0600.
7. `engine/src/cli/shared/spawn-server.ts` — embedded server boot logic. KEEP.
8. `package.json` — find `@opentui/*`, `solid-js`, `opencode-ai` deps to remove.

## Build

### Step A — Delete

```bash
# Frees ~899M of disk (mostly node_modules).
rm -rf engine/src/tui/_vendored

# Exact files/dirs to verify gone:
#   engine/src/tui/_vendored/LICENSE.vendored
#   engine/src/tui/_vendored/UPSTREAM-SHA.txt
#   engine/src/tui/_vendored/_upstream-patches/
#   engine/src/tui/_vendored/bun.lock
#   engine/src/tui/_vendored/bunfig.toml
#   engine/src/tui/_vendored/node_modules/            (893M)
#   engine/src/tui/_vendored/opencode/                (5.3M — bunfig.toml, jellyclaw-bridge.ts, migration/, package.json, parsers-config.ts, src/, sst-env.d.ts, tsconfig.json)
#   engine/src/tui/_vendored/package.json
#   engine/src/tui/_vendored/plugin/
#   engine/src/tui/_vendored/script/
#   engine/src/tui/_vendored/sdk/
#   engine/src/tui/_vendored/server/
#   engine/src/tui/_vendored/util/
```

Remove from `package.json`:
- `@opentui/core`, `@opentui/solid`, any `@opencode-ai/*` packages
- `solid-js` if not used elsewhere (grep first)

Run `bun install` to regenerate lockfile.

### Step B — Strip vendored TUI logic from cli/tui.ts

In `engine/src/cli/tui.ts` (verified line numbers as of 2026-04-15):

- Delete the entire `spawnStockTui` function (lines 232-294) and its `SpawnStockTuiOptions` interface (lines 188-193).
- Delete the stock-TUI branch inside `tuiAction` — lines **446-474**, which is the `// ---- embedded path (Phase 10.5 spike) ----` comment, the three `void spawnServer; void waitHealth; void launchTui;` statements (lines 458-460), the `ensureAnthropicKey` call (lines 466-470), and the `spawnStockTui({...})` invocation (line 471).
- Delete `ensureAnthropicKey` (lines 209-230) — the Ink TUI in prompt 06 will call `loadCredentials` / `updateCredentials` directly from its own boot.
- Replace the body of the default-action branch (where stock TUI was spawned) with a stub that throws `NotImplementedError("Phase 99-06: Ink TUI not yet built")`.
- Keep:
  - Windows guard (return 2 on win32)
  - `installRawModeGuard` (will hand ownership to Ink in 06; keep for now)
  - `attach` subcommand path if it exists
  - Embedded server boot helpers (`spawnEmbeddedServer`, `waitHealth`)

### Step C — Slim the SDK adapter into a real client

Rename `engine/src/tui/sdk-adapter.ts` → `engine/src/tui/client.ts`. Strip OpenCode-shape translation. New surface:

```ts
export interface JellyclawClient {
  health(): Promise<{ ok: boolean; version: string }>;
  createRun(opts: { prompt: string; sessionId?: string; cwd?: string; systemPrompt?: string }): Promise<{ runId: string; sessionId: string }>;
  events(runId: string, lastEventId?: string): AsyncIterable<AgentEvent>;
  cancel(runId: string): Promise<void>;
  listSessions(): Promise<SessionMeta[]>;
  resumeSession(sessionId: string): AsyncIterable<AgentEvent>;
}

export function createClient(opts: { baseUrl: string; token: string; signal?: AbortSignal }): JellyclawClient;
```

Implement using native `fetch` + `EventSource`-like SSE parsing (Node 22 / Bun supports `EventSource` natively, or use `eventsource-parser`).

Add automatic reconnect with backoff (200ms → 800ms → 3.2s capped, max 5 retries) on transient SSE errors. Surface "reconnecting" state via a callback prop.

### Step D — Delete dead helpers

- `engine/src/tui/event-map.ts` — DELETE if no remaining importer (grep first).
- Anything in `engine/src/tui/` that imported from `_vendored/` is now dead. Audit and remove.

### Step E — Tests

Create/update `engine/src/tui/client.test.ts`:

1. `health()` — mock fetch, asserts `GET /v1/health`.
2. `createRun()` — POST `/v1/runs` with bearer token.
3. `events()` — mock SSE stream with 3 events, asserts 3 yielded.
4. `events()` reconnect — first connection drops, asserts retry with `Last-Event-Id` header set to last seen event id.
5. `cancel()` — DELETE `/v1/runs/:id` returns 204.

Snapshot the new minimal `cli/tui.ts` body in a structure test (assert it does NOT contain the strings `void spawnServer`, `_vendored`, `spawnStockTui`).

## Out of scope

- Don't build the Ink UI (prompt 06).
- Don't touch the engine, server, or CLI run path.

## Done when

- `_vendored/` directory is gone
- `bun install` clean, no orphan deps
- `bun test engine/src/tui/client.test.ts` — green
- `grep -r "_vendored\|spawnStockTui\|void spawnServer" engine/src` — no matches
- `bunx tsc --noEmit` — clean
- `jellyclaw tui` exits with `NotImplementedError("Phase 99-06...")` cleanly (intentional placeholder)

<!-- BEGIN SESSION CLOSEOUT -->
<!-- Tag commit `phase-99-tui-demolition`. -->
<!-- END SESSION CLOSEOUT -->
