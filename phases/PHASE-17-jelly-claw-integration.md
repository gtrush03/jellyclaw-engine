---
phase: 17
name: "Integration into jelly-claw video-calling app"
duration: "5 days"
depends_on: [13, 14]
blocks: [18]
---

# Phase 17 — Integration into jelly-claw

## Dream outcome

During a live video call in `jelly-claw` (the macOS SwiftUI app at `/Users/gtrush/Downloads/jelly-claw/`), the user says "@genie summarize what we just discussed" and a SwiftUI side panel streams the answer in real time. Jellyclaw runs as an embedded Node sidecar inside the Xcode app bundle; Swift talks to it over a loopback HTTP port or Unix socket. The voice-trigger pattern is ported from Genie's JellyJelly poll into the jelly-claw transcript stream.

## Deliverables

- Swift Package: `JellyclawKit` — Swift client for jellyclaw's SSE API
- Sidecar bundle: Node + `@jellyclaw/engine` packaged into `Resources/jellyclaw/`
- `JellyclawManager` Swift actor: lifecycle, health, restart
- `GenieAgent.swift` — trigger parser (port of Genie's `trigger.mjs`)
- `TranscriptListener.swift` — consumes jelly-claw's live transcript, matches `@genie` prefix
- `GeniePanel.swift` — SwiftUI side panel with timeline + approval UI
- Unix socket preferred; loopback HTTP fallback
- Entitlements + sandboxing review

## Step-by-step

### Step 1 — Review jelly-claw structure
Open `/Users/gtrush/Downloads/jelly-claw/` in Xcode. Identify:
- App target + entitlements
- Existing transcript pipeline (if any; if not, this phase adds a stub)
- Where a side panel belongs in the SwiftUI view tree

### Step 2 — Sidecar packaging
Package the engine:
```bash
cd /Users/gtrush/Downloads/jellyclaw-engine/engine
pnpm run build
npx ncc build dist/cli/main.js -o ../integration/sidecar-bundle
```
Copy `sidecar-bundle/` into the Xcode project's `Resources/jellyclaw/`. Ship a `node` binary too (or require system Node — decision: **bundle node** for reliability).

### Step 3 — Lifecycle actor
`JellyclawManager`:
```swift
actor JellyclawManager {
  private var process: Process?
  private(set) var endpoint: URL?
  private(set) var token: String?
  func start() async throws { /* spawn Resources/jellyclaw/node + main.js serve --host unix:/tmp/jellyclaw-<uuid>.sock */ }
  func stop() { process?.terminate() }
}
```
Start on app launch, stop on quit. Restart with backoff on crash.

### Step 4 — Unix socket vs HTTP
Prefer Unix socket (`--socket /tmp/jellyclaw-<uuid>.sock`) for avoiding port allocation + sandbox-friendly. Hono supports UDS via `@hono/node-server` `listen({ path })`. Fallback to 127.0.0.1 ephemeral if UDS fails under sandbox.

### Step 5 — Swift SSE client
`JellyclawKit/Sources/JellyclawClient.swift`. Use `URLSession` with `bytes(for:)` streaming, parse SSE lines into typed events (matching `shared/src/events.ts`).

### Step 6 — Transcript listener
In jelly-claw's video-call scene, tap into the transcript stream (WebRTC/RTC captions). On each new line, match `/^@genie (.+)/`. On match, call `JellyclawClient.run(prompt)`.

### Step 7 — Port Genie trigger pattern
Read `/Users/gtrush/Downloads/genie-2.0/src/core/trigger.mjs`. Port its regex + cooldown + context-collection logic into `GenieAgent.swift`. Include: last N seconds of transcript in the prompt, speaker attribution, call metadata (participants, duration).

### Step 8 — Side panel UI
`GeniePanel.swift` (SwiftUI):
- Collapsible right-side panel
- Live event timeline
- Approval buttons for PreToolUse events
- Copy-to-clipboard final result

### Step 9 — Entitlements
- `com.apple.security.app-sandbox = true`
- `com.apple.security.network.client` (for MCP/web)
- Allow child process execution (may require hardened runtime exemption)
- User-selected read/write if file tools are exposed (restrict in video-call mode)

### Step 10 — Safety
Video-call mode runs jellyclaw with `--permission-mode plan` by default OR `acceptEdits` with hook that denies Bash + Write. Owner toggles full mode explicitly.

### Step 11 — Manual test script
`integration/test-calls/` — checklist:
- Start call → Genie panel shows "ready"
- Say "@genie hello" → response streams in <3 s
- Say "@genie summarize" after 2 min of conversation → summary accurate
- Kill sidecar externally → manager restarts within 5 s
- Close app → sidecar exits cleanly

## Acceptance criteria

- [ ] jelly-claw builds with embedded sidecar; `.app` under signed distribution
- [ ] Sidecar starts and stops with app lifecycle
- [ ] @genie triggers produce SSE-streamed responses in the panel
- [ ] Transcript context included in prompts
- [ ] Default mode prevents destructive tool use in video-call context
- [ ] Crash → auto-restart within 5 s
- [ ] Manual checklist passes end-to-end on a real call

## Risks + mitigations

- **macOS sandbox blocks sidecar spawn** → test early; if blocked, ship sidecar as a LaunchAgent user-level helper registered by the app.
- **Video-call performance impact** → pin sidecar to low CPU priority; measure — must add <5% CPU during idle.
- **Accidental tool execution mid-call** → default to plan mode + hook deny-list.
- **Large Node binary inflates .app size** → acceptable (~70 MB); document.

## Dependencies to install

jelly-claw side: `JellyclawKit` local Swift Package.
jellyclaw side:
```
@vercel/ncc@^0.38  # single-file bundler
```

## Files touched

- `jelly-claw/<AppName>/JellyclawManager.swift`
- `jelly-claw/<AppName>/GenieAgent.swift`
- `jelly-claw/<AppName>/TranscriptListener.swift`
- `jelly-claw/<AppName>/Views/GeniePanel.swift`
- `jelly-claw/Packages/JellyclawKit/**`
- `jelly-claw/<AppName>/Resources/jellyclaw/**`
- `jellyclaw-engine/integration/sidecar-build.mjs`
- `jellyclaw-engine/integration/test-calls/CHECKLIST.md`
