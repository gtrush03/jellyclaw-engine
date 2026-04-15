---
phase: 15
name: "Desktop app MVP (Tauri 2)"
duration: "5 days"
depends_on: [10]
blocks: [16]
---

# Phase 15 — Desktop app MVP

## Dream outcome

A signed macOS `.dmg` that, on launch, starts a local `jellyclaw serve` sidecar, connects over SSE, and renders: wish input, live event timeline, tool inspector, cost meter, session history. Owner can run a daily wish end-to-end without the CLI.

## Deliverables

- `desktop/` — Tauri 2 + React 19 + Zustand + XState
- `desktop/src-tauri/` — Rust shim that spawns jellyclaw sidecar
- `desktop/src/` — UI
- `desktop/dmg/` — notarized build artifact
- Apple Developer signing in CI
- `docs/desktop.md`

## Stack

- Tauri 2 (Rust + webview)
- React 19 + Vite
- Zustand for client state, XState for wish lifecycle (idle → running → waiting-approval → done)
- Tailwind v4
- SSE via `EventSource` with reconnect
- Types from `@jellyclaw/shared`

## Screens (MVP)

1. **Wish bar** — prompt input, model picker, permission mode toggle, submit
2. **Timeline** — event list (system.init, assistant.delta, tool.call.*, subagent.*, result), collapsible
3. **Tool inspector** — click a tool call → see input JSON, output, duration, cost
4. **Cost meter** — running total for session + all-time
5. **Session history** — list of sessions, click to resume
6. **Settings** — API keys (stored in OS keychain via Tauri plugin), default model

## Step-by-step

### Step 1 — Scaffold
```bash
cd /Users/gtrush/Downloads/jellyclaw-engine/desktop
pnpm create tauri-app@latest --template react-ts --identifier com.jellyclaw.desktop
pnpm add zustand xstate @xstate/react
pnpm add -D tailwindcss@next @tailwindcss/vite
```

### Step 2 — Sidecar
`src-tauri/src/main.rs` spawns the jellyclaw Node binary on an ephemeral port, captures the token, passes both to the frontend via Tauri command. Kill on app quit.

### Step 3 — SSE client
`src/lib/sse.ts` opens `/events/:id` with `Authorization` header (via EventSource polyfill `@microsoft/fetch-event-source`).

### Step 4 — State machine (XState)
```
idle -> submit -> running -> (awaiting-approval | tool-call | delta) -> done | error
```
Persist session id + resume on reopen.

### Step 5 — Tool inspector
For each `tool.call.start/end`, show a row. Click expands a panel with `<JsonView>` (use `react-json-view` or a minimal own).

### Step 6 — Keychain
Use `tauri-plugin-stronghold` (or `tauri-plugin-keyring`) to store API keys. Never write to plaintext disk.

### Step 7 — Signing + notarization
GitHub Actions:
- Apple Developer cert in secret
- `tauri build --target universal-apple-darwin`
- Notarize via `notarytool`
- Staple
Output `.dmg` artifact.

### Step 8 — Smoke test
Manual checklist:
- Install fresh, open, submit "hello"
- Cancel a running wish
- Resume an old session
- Toggle permission mode, run Bash that would be blocked → see approval modal (basic "allow this one" in MVP; full hooks in Phase 16)

## Acceptance criteria

- [ ] Signed + notarized `.dmg` builds in CI
- [ ] Sidecar starts and stops cleanly with app lifecycle
- [ ] SSE stream renders events live <100 ms latency
- [ ] Tool inspector shows inputs/outputs for every call
- [ ] Cost meter matches server-side ledger within 1%
- [ ] Session history persists across restarts
- [ ] API keys stored in keychain, not plaintext

## Risks + mitigations

- **Sidecar port collision** → use port 0 + capture; never hardcode.
- **Notarization failures** → keep a local manual fallback script.
- **SSE backpressure in UI** → batch renders via `requestAnimationFrame`.
- **Node runtime shipping size** → bundle via `pkg` or `ncc` into single binary; or require Node installed (MVP accepts this).

## Dependencies to install

Frontend:
```
zustand@^5 xstate@^5 @xstate/react@^5 @microsoft/fetch-event-source@^2
tailwindcss@next @tailwindcss/vite
```
Rust (Tauri):
```
tauri = "2"
tauri-plugin-stronghold = "2"
```

## Files touched

- `desktop/**` (new)
- `.github/workflows/desktop-build.yml`
- `docs/desktop.md`
