# Phase 99 — Unfucking — Prompt 06: Ink TUI rebuild with paste-in API key

**When to run:** After 99-05 (vendored gone). Can run in parallel with 99-04.
**Estimated duration:** ~150 minutes
**New session?** Yes
**Model:** Claude Opus 4.6 (1M context)

<!-- BEGIN SESSION STARTUP -->
<!-- Use /Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/STARTUP-TEMPLATE.md -->
<!-- Phase doc: /Users/gtrush/Downloads/jellyclaw-engine/phases/PHASE-99-unfucking.md -->
<!-- Working API key for live demo: <REDACTED_API_KEY> -->
<!-- END SESSION STARTUP -->

---

## Why this exists

The vendored OpenCode TUI is gone. Build a fresh Ink TUI that consumes the same `/v1/events` SSE stream the desktop will use (one protocol, two renderers). Includes the original Phase 10.5 ask: paste-in-TUI API key flow on first run.

## Files to read first

1. `engine/src/cli/tui.ts` (post-99-05 — the slim version with the NotImplementedError stub).
2. `engine/src/tui/client.ts` (built in 99-05).
3. `engine/src/cli/credentials.ts` + `credentials-prompt.ts` — reuse for storage.
4. `engine/src/cli/shared/spawn-server.ts` — embedded server boot.
5. `engine/src/tui/jellyfish-spinner.ts` + `theme-schema.ts` + `logo.*` — keep, port into Ink.
6. `jellyfish-spinner-spec.txt` (repo root) — frame data + reduced-motion behavior.
7. `engine/src/events.ts` — `AgentEvent` for reducer typing.

## Pre-flight (run first to confirm starting state)

```bash
# Confirm 99-05 completed (no vendored tree, no stock TUI spawn, no dead bypass)
test ! -d /Users/gtrush/Downloads/jellyclaw-engine/engine/src/tui/_vendored && echo "vendored gone: OK" || echo "vendored still present: BLOCKER"
grep -n "spawnStockTui\|void spawnServer\|_vendored" /Users/gtrush/Downloads/jellyclaw-engine/engine/src/cli/tui.ts || echo "cli/tui.ts clean: OK"

# Confirm credentials.ts is intact (reused by the API-key flow)
test -f /Users/gtrush/Downloads/jellyclaw-engine/engine/src/cli/credentials.ts && echo "credentials.ts: OK"

# Confirm Anthropic key works against Haiku with tool_use (end-to-end sanity)
ANTHROPIC_API_KEY=<REDACTED_API_KEY> \
  curl -s https://api.anthropic.com/v1/messages \
  -H "content-type: application/json" -H "anthropic-version: 2023-06-01" -H "x-api-key: $ANTHROPIC_API_KEY" \
  -d '{"model":"claude-haiku-4-5","max_tokens":50,"messages":[{"role":"user","content":"say pong"}]}' \
  | head -c 200
```

## Install deps

```bash
bun add ink@^5 ink-text-input ink-spinner react@^18 react-devtools-core
bun add -d ink-testing-library
```

Pin `react@^18` (Ink 5 needs it). Ensure `yoga-layout` works under Bun — Ink 5 uses `yoga-wasm-web` which is Bun-clean.

**Verified 2026-04-15** on this machine: `bun add ink@^5 react@^18` in a scratch dir succeeds — `bun 1.3.5` installs `ink@5.2.1 + react@18.3.1` with 41 packages resolved (~756ms), no yoga/native-build failures. Safe to proceed.

## Build

### File layout

```
engine/src/tui/
  app.tsx                    # Ink <App> root
  client.ts                  # (from 99-05)
  state/
    reducer.ts               # AgentEvent → UI state (pure, snapshot-testable)
    types.ts
  hooks/
    use-events.ts            # subscribes to SSE via client
    use-reduced-motion.ts    # JELLYCLAW_REDUCED_MOTION / NO_COLOR / non-TTY
  components/
    transcript.tsx
    tool-call.tsx
    input-box.tsx
    status-bar.tsx
    jellyfish.tsx
    api-key-prompt.tsx
    permission-modal.tsx
  index.ts                   # launchTui() — mounts Ink, returns dispose handle
```

### App layout (Ink)

```
┌───────────────────────────────────────────────┐
│ ◈ jellyclaw  ·  sonnet  ·  ses_abc123 · 1.2k tok  ◈ ⠁  │  ← StatusBar
├───────────────────────────────────────────────┤
│  user > say pong                              │
│  ◈ pong                                       │  ← Transcript
│  ┌─ tool: bash ─────────────────────────┐   │
│  │ $ ls /tmp                              │   │  ← ToolCall card
│  │ → 3 files                              │   │
│  └─────────────────────────────────────────┘   │
├───────────────────────────────────────────────┤
│ > _                                           │  ← InputBox (multiline w/ Meta+Enter)
└───────────────────────────────────────────────┘
```

### State reducer

```ts
type UiState = {
  sessionId: string | null;
  model: string;
  messages: Array<TextMessage | ToolCallMessage | ErrorMessage>;
  status: 'idle' | 'streaming' | 'awaiting-permission' | 'error';
  pendingPermission?: { tool: string; input: unknown; resolve: (granted: boolean) => void };
  usage: { input: number; output: number; costUsd: number };
};

function reduce(state: UiState, event: AgentEvent): UiState;
```

Pure, no I/O. Snapshot-tested in isolation.

### API-key paste flow

`launchTui()` invariant:

1. Read from credentials.ts: `loadCredentials()` (returns `{anthropicApiKey?, openaiApiKey?}`). Fall back to `process.env.ANTHROPIC_API_KEY`.
2. If key present: boot embedded server with key in env, mount `<App/>`.
3. If absent: mount `<ApiKeyPrompt/>` first. On submit:
   - Validate by hitting `https://api.anthropic.com/v1/messages` with a 1-token ping to `claude-haiku-4-5`.
   - On success: call `updateCredentials({anthropicApiKey: value})` (atomic write to `~/.jellyclaw/credentials.json`, mode 0600 enforced).
   - On success: save via `credentials.ts` to `~/.jellyclaw/credentials.json` (mode 0600).
   - On failure: render error, allow retry.
   - Then transition to embedded-server boot + `<App/>`.

`<ApiKeyPrompt/>` UX:
- Masked input (show `••••••••` after typing)
- `Enter` submit, `Esc` quit
- Live validation indicator (`⠁ validating…` → `✓ valid` / `✗ invalid`)
- Footer: "paste your Anthropic key — get one at console.anthropic.com/settings/keys"

### Reduced motion

`useReducedMotion()` returns true if any of:
- `JELLYCLAW_REDUCED_MOTION=1`
- `NO_COLOR=1` (out of caution)
- `CLAUDE_CODE_DISABLE_ANIMATIONS=1`
- `!process.stdout.isTTY`

When true: `<Jellyfish/>` renders the static frame, no spinner advance.

### Session continuation

- `--continue` flag → reads last session id from `~/.jellyclaw/state.json`, hits `client.resumeSession(id)`.
- `--resume <id>` → same but explicit.
- Otherwise: starts fresh.

### Permission modal

When SSE delivers `permission.requested`: render modal blocking input box. Yes/No → POST `/v1/permissions/:id { granted: bool }`. Server resolves the loop's pending permission gate.

### Ctrl-C handling

- First Ctrl-C: cancel current run via `client.cancel(runId)`. Show "press Ctrl-C again to quit".
- Second within 2s: `dispose()` and `process.exit(130)`.

## Tests

Create `engine/test/tui/`:

1. `reducer.test.ts` — table tests over canned event logs.
2. `app.snapshot.test.tsx` — `ink-testing-library` `lastFrame()` snapshots for: welcome, streaming message, tool-call card (pending/ok/error), permission prompt, api-key prompt, reduced-motion static spinner, narrow terminal (40 cols).
3. `client-reconnect.test.ts` — verifies SSE reconnect with `Last-Event-Id`.
4. `boot.test.ts` — `launchTui()` against in-process `createApp()`. No orphan timers after dispose.
5. `win-guard.test.ts` — `tuiAction({ platform: 'win32' })` returns 2 immediately.
6. `api-key-prompt.test.tsx` — paste → validate (mock fetch 200) → save → transition.

Lock terminal width to 80 in snapshots (`{ columns: 80 }`).

## Manual smoke (live)

```bash
unset ANTHROPIC_API_KEY
rm -f ~/.jellyclaw/credentials.json
./engine/bin/jellyclaw tui
# Should show api-key prompt. Paste:
# <REDACTED_API_KEY>
# Press Enter. Should validate, save, and transition to chat.
# Type: "say pong"
# Should stream "pong" character-by-character.
# Type: "run: ls /tmp | head -3"
# Should render a tool-call card with the bash output.
# Ctrl-C. Ctrl-C again. Clean exit.
```

## Out of scope

- Not yet wiring Genie to use TUI (Genie uses headless `jellyclaw run`, not `tui`).
- Not building macOS-native menubar UI.

## Done when

- All test gates green
- Manual smoke transcript pasted into COMPLETION-LOG.md
- `bun run tsc --noEmit` clean
- Snapshots committed

<!-- BEGIN SESSION CLOSEOUT -->
<!-- Tag commit `phase-99-tui-real`. Take a screenshot of the working TUI for the README. -->
<!-- END SESSION CLOSEOUT -->
