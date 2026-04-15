# Jelly-Claw × jellyclaw-engine — End-to-End Integration Design

**Phase:** 17 (Genie-in-the-Call)
**Timebox:** 4 weeks
**Primary artifacts:**
- `/Users/gtrush/Downloads/jellyclaw-engine/` — the standalone OpenCode-derived engine (Node/TypeScript, Bun-compiled).
- `/Users/gtrush/Downloads/jelly-claw/` — the macOS video-calling app (Swift/AppKit/SwiftUI + WKWebView + Cloudflare Workers signaling).
- Sibling docs: `AUDIT.md` (what the app already is), `BRIDGE-DESIGN.md` (the Swift ↔ Node IPC contract).

Read those two first. This doc is the product-level story: what the user sees, what the feature surfaces look like, what gets delivered in which week.

---

## 0. Thesis in one paragraph

The Jelly-Claw macOS app already ships a **first-generation Genie layer** — `JellyGenieKit` Swift package, a bundled Node `genie-server/` process in `Contents/Resources/`, SSE events over loopback port 7778, `GenieServerMonitor` with auto-restart, Chrome CDP health-check, soul/skills plumbing. What it does **not** yet have is: (a) a single-binary engine that replaces the Node bundle, (b) live-call ambient listening so Genie fires on the "genie" keyword in a conversation, (c) SwiftUI surfaces that expose wishes inside call windows, post-call receipts, and settings. This phase delivers all three by **swapping the binary, adding three SwiftUI surfaces, and wiring `SpeechManager` to the in-call audio mix**. We preserve the 20 production behaviors documented in the in-tree `engine/INTEGRATION.md §1`, we ship three new guarantees (idempotency, per-wish tab isolation, crash-safe resume), and we light up "Genie is in the call with you" as the hero feature of the next release.

## 1. Context

### 1.1 Where the user is today

- They open the Jelly-Claw menu bar icon; the popover offers Post-Jelly + three call buttons (1:1, Group, Voice Room).
- They start a call; a floating `NSPanel` opens a WKWebView running the call's JS. The WebView owns mic + camera for the call's duration.
- Genie exists but is invisible to the calling surface — it runs in the background, reacts to JellyJelly firehose events, comments on clips, runs browser wishes via Chrome CDP:9222. Users interact with it via Telegram or Jelly Chat, not in-app.

### 1.2 Where we're going

- Genie shows up **inside the app** with its own SwiftUI surfaces — not just a background process.
- During a call, Genie **listens** for the trigger word and reacts in real time.
- After a call, the app shows Genie **receipts** (what did Genie do while I was talking?).
- Settings let the user tune Genie (keys, trigger keyword, enable/disable per-call).

### 1.3 Constraints from the audit (see `AUDIT.md`)

| Constraint | Implication |
| --- | --- |
| App is **not sandboxed** (`app-sandbox=false`) | Can spawn child binaries trivially; don't architect around sandbox. |
| `JellyGenieKit.SSEParser` is production-hardened | Reuse verbatim; don't rewrite. |
| Two "jelly-claw" engines exist (`engine/` in-tree + `jellyclaw-engine/` standalone) | **Unify.** The standalone engine is the canonical one; the in-tree `engine/` directory becomes a symlink or is retired. |
| Bundled Node `genie-server/` already lives in `Contents/Resources/` on port 7778 | Keep the wire, swap the binary. |
| `SpeechManager` is dormant but functional | Revive, rewire to consume WKWebView mic-tap frames. |
| Keychain helper exists | All secrets go there, never UserDefaults. |
| App is not yet notarized | Plan notarization with this release. |

## 2. Architecture (target)

```
+--------------------- Jelly-Claw.app ----------------------------------+
|                                                                       |
|  SwiftUI popover / SFU / Call windows                                 |
|   |                                                                   |
|   +-- CallManager ---- CallWebView (WKWebView, JS WebRTC)             |
|   |       \                        \                                   |
|   |        \__ SpeechManager <------ AudioWorklet PCM tap             |
|   |                                                                   |
|   +-- GenieManager (JellyGenieKit) -- URLSession HTTP + SSE           |
|             |                                                         |
|             v                                                         |
|   +-- EngineSupervisor (NEW) -- spawns + watches child                |
|             |                                                         |
|             v   Process()                                             |
|      Contents/Resources/jellyclaw-engine/jellyclaw  serve             |
|             |   bind 127.0.0.1:<os-picked>                            |
|             |   token via JELLYCLAW_AUTH_TOKEN env                    |
|             |   PID file in ~/Library/Application Support/JellyClaw/  |
|             |                                                         |
|             +----> Chrome (CDP:9222, user profile) — existing pattern |
|             +----> OpenRouter / Anthropic API                         |
|             +----> MCP servers (Playwright, Filesystem, ...)          |
+-----------------------------------------------------------------------+
```

The **signaling layer** (Cloudflare Workers Durable Objects at `signal.jelly-claw.com`) is unchanged and is not in the diagram.

## 3. Engine integration — the five workstreams

### 3.1 Binary bundling (see `BRIDGE-DESIGN.md §3`)

Bun `--compile` produces a single executable per arch; `lipo` merges; Xcode Copy-Files phase drops it in `Contents/Resources/jellyclaw-engine/jellyclaw`. The legacy `genie-server/` Copy-Files phase is **left intact during Week 1-2** as a fallback path, then **deleted in Week 3** when the SwiftUI surfaces all talk to the new endpoints.

### 3.2 Process supervision (see `BRIDGE-DESIGN.md §4`)

`EngineSupervisor` is a new class inside `JellyGenieKit`. It owns the `Process`, the handshake (port-announce file), the shutdown dance (SIGTERM → SIGKILL), and the PID file. `GenieServerMonitor` (already shipping) continues doing wake-from-sleep + heartbeat + Chrome CDP checks; we only swap the subject it watches.

### 3.3 Wire protocol (see `BRIDGE-DESIGN.md §2`)

Three legacy endpoints stay (`/status`, `/dispatches`, `/events` SSE). Three new endpoints added (`/v1/runs`, `/v1/runs/:id/cancel`, `/healthz`). All require `Authorization: Bearer <token>` except `/healthz` which is bypassable so monitor probes don't churn on Keychain. `webhookBase` becomes dynamic on the Swift side — driven by whatever port the engine printed.

### 3.4 Trigger-word listening (see `BRIDGE-DESIGN.md §8`)

`SpeechManager` is un-dormanted. A new `beginRecognition(from: PassthroughSubject<AVAudioPCMBuffer, Never>)` overload consumes PCM frames posted from the WebView's `AudioWorkletNode` through `WKScriptMessageHandler`. On "genie" (fuzzy match), the trailing utterance is extracted and POSTed to `/v1/runs` with `context` carrying the `callId`, `participants`, and a trailing-60s transcript window.

Edge cases handled:
- **False positives** on words like "hygiene" / "Eugenie" — require a 300 ms silence pause after the word to reduce trigger rate.
- **Multi-speaker drift** — v1 only listens to the local mic (your voice). v2 can capture mixed audio via `CATapDescription` if needed.
- **Privacy** — a small red "Genie is listening" dot shows in the call window's footer whenever the trigger tap is active. User can disable trigger-per-call from the footer kebab.

### 3.5 Browser wishes during/after calls

The Chrome CDP pattern carries over unchanged. The engine uses the **same logged-in browser profile** at `~/.genie/browser-profile/`; wishes that need to act as the user (LinkedIn, Gmail, Vercel, Stripe) run there. During a call this is fine: Genie works headfully on a **second tab** while the user is on-camera. After the call, Genie can surface the browser state as a receipt (see §4.3).

## 4. SwiftUI surfaces

Four new surfaces land in `Jelly-Claw/` (and reusable components inside `JellyGenieKit/Sources/JellyGenieKit/Views/`):

### 4.1 Pre-call Genie panel (in the menu-bar popover)

File: `Jelly-Claw/GenieLaunchpadView.swift` (new).

- Lives at the bottom of the `ContentView` popover, between "START A CALL" and "POST JELLY".
- Shows:
  - Three recent wishes (clip title + status icon + timeAgo), sourced from `GenieManager.allDispatches.prefix(3)`.
  - Three **suggested wishes** based on local context:
    - "Summarize my last call" (if the user has any recent call recording, pre-fills a prompt).
    - "Open my Linear board" (if Linear MCP is configured).
    - "Draft a follow-up to <last guest>" (if the user has call history with contacts).
  - A text field "What do you want?" → Enter triggers `runWish(prompt:)`.
- Height: compact, ~180 pt. Uses `GenieManager.serverStatus` for a tiny status dot (green/yellow/red).

### 4.2 In-call Genie overlay

File: `Jelly-Claw/CallGenieOverlay.swift` (new) + edits to `CallWindow.swift` and `SfuRoomWindow.swift` to host it.

- When a wish starts during a call, a **banner slides down** from the top of the call window: "🧞 Genie is working: <prompt summary>" with a `>` to expand.
- Expanded state: a mini-timeline (reuses `GenieEvent.timeline` renderings from `JellyGenieKit/Sources/JellyGenieKit/Views/`) with:
  - Live tool events (`tool.call.start` / `tool.call.end`).
  - Running assistant text (`message.part.updated`).
  - Cost counter.
  - Cancel button → `POST /v1/runs/:id/cancel`.
- When the wish resolves, banner morphs to a receipt pill "🧞 Done — tap to see" for 10s, then slides away.
- Triggered both by (a) the voice keyword (via `SpeechManager`) and (b) an explicit "/ask Genie" chat command (via the WebView's JS chat, which sends a message over `WKScriptMessageHandler`).

### 4.3 Post-call summary

File: `Jelly-Claw/PostCallSummaryView.swift` (new).

- When a call ends AND at least one wish ran during it, a post-call sheet appears.
- Shows:
  - Call metadata: duration, participants, mode (1:1 / group / voice).
  - Per-wish receipt cards: prompt, final result (truncated), cost, "Open wish" (jellyclaw:// deep link).
  - A "Post as Jelly" button that takes the call recording + "Genie did X" and drafts a Jelly post.
- Powered by a single `GET /dispatches?since=<callStartTs>` query; no new endpoint.

### 4.4 Settings panel

File: `Jelly-Claw/SettingsView.swift` (already exists — **extend**, don't replace).

Add a "Genie" tab:
- Secure fields: OpenRouter API key, Anthropic API key — writes through `KeychainHelper` to the engine's env on next restart. Fields show `****` once saved.
- Toggles: Enable Genie (master), Enable voice trigger, Enable per-call banners, Enable post-call summaries.
- Text field: trigger keyword (default `genie`, with an inline note "Fuzzy-matched; also accepts jeanie/jinnie/djinni").
- Button: Reset Genie (rotates auth token, clears session state, confirmation dialog).
- Button: Open Genie logs (reveals `~/Library/Logs/JellyClaw/engine.jsonl`).

## 5. Call-context payload

When Genie is fired from inside a call, the `/v1/runs` body's `context` is populated so the engine can make better choices and write better summaries:

```json
{
  "prompt": "remind me to send Sarah the API doc",
  "sessionId": null,
  "context": {
    "callId": "c-9f3a...",
    "callMode": "1:1",
    "durationSec": 412,
    "participants": ["me", "@sarah_wilson"],
    "transcriptExcerpt": "...and I'll send over the API doc tomorrow, sound good? genie remind me to send Sarah the API doc after this call...",
    "callUrl": "https://sarah.jelly-claw.com/call/9f3a..."
  },
  "tierHint": "simple"
}
```

The engine's system prompt gets a **context preamble** when `context.callId` is set, explaining that the wish was uttered live during a call and that the user expects a short, action-oriented response. The preamble lives at `skills/call-wish-preamble.md` inside the engine bundle.

## 6. Reconciling the two engine directories

Today we have:
- `/Users/gtrush/Downloads/jelly-claw/engine/` — in-tree, contains `opencode/` + `opencode-anomaly/` submodules and a spec targeting the Genie dispatcher.
- `/Users/gtrush/Downloads/jellyclaw-engine/` — standalone, contains `phases/`, `skills/`, `integration/`, etc.

**Decision:** `/Users/gtrush/Downloads/jellyclaw-engine/` is the canonical repo. The in-tree `engine/` becomes a **symlink** into a checked-out submodule at `engine-src/` plus a tiny `engine-artifacts/` directory populated by `scripts/build-engine.sh`. The Xcode project references `engine-artifacts/` in its Copy-Files phase, not `engine-src/`. This keeps the app repo light (tens of MB of artifacts, not gigabytes of OpenCode source).

## 7. Week-by-week plan

### Week 1 — Foundations

- **Mon–Tue.** Audit reconciliation: walk `/Users/gtrush/Downloads/jelly-claw/engine/INTEGRATION.md` line-by-line against what `jellyclaw-engine` actually exposes; delete parity gaps. Merge or retire in-tree `engine/` per §6.
- **Wed–Thu.** Bundling script: `scripts/build-engine.sh` producing a universal signed Mach-O under 100 MB. Xcode Copy-Files phase wired. Smoke test: `Jelly-Claw.app/Contents/Resources/jellyclaw-engine/jellyclaw --version` runs.
- **Fri.** `BRIDGE-DESIGN.md` approved. `EngineSupervisor` stub compiles and spawns the child (even if the child is just a placeholder `echo` binary). Port-announce handshake verified.

**Exit criteria:** we can `scripts/build-engine.sh && xcodebuild` and the resulting `.app` contains a working engine binary that prints its version.

### Week 2 — "Hello World Wish" end-to-end

- **Mon.** `/healthz` + `/v1/runs` implemented in the engine. `EngineSupervisor` returns a supervisor that can `runWish("what is 2+2?")` and get a result back via SSE.
- **Tue–Wed.** `GenieManager.webhookBase` moves to `EngineSupervisor.port`. Bearer auth added to every request. Event classifier extended for OpenCode-native shapes.
- **Thu.** `GenieLaunchpadView` lands with "What do you want?" input. Running a wish from the popover works end-to-end.
- **Fri.** Legacy `genie-server/` Copy-Files phase disabled behind a `USE_LEGACY_GENIE_SERVER=1` build flag — default is the new binary.

**Exit criteria:** QA can type "open example.com in Chrome" in the Genie Launchpad and see the browser tab open.

### Week 3 — In-call experience

- **Mon.** `AudioWorkletNode` PCM-tap added to `call-host.js`; `WKScriptMessageHandler` wires frames into `SpeechManager`. Latency budget: <200 ms mic → Swift.
- **Tue.** Fuzzy keyword match lights up in `SpeechManager`; when it fires, a `CallContext` is built and a wish runs.
- **Wed.** `CallGenieOverlay` banner + expanded timeline.
- **Thu.** Three canonical end-to-end wishes green: "remind me later", "take a note about this call", "send them my calendar link". Each has a spec in `skills/`.
- **Fri.** `PostCallSummaryView` + Settings "Genie" tab ship.

**Exit criteria:** two people on a 1:1 call, one says "genie remind me to follow up on this tomorrow", the banner shows Genie working, the reminder lands in the user's tool of choice, and the post-call sheet shows the receipt.

### Week 4 — Hardening + release

- **Mon.** Failure-mode matrix from `BRIDGE-DESIGN.md §9` walked: simulate each row, confirm recovery.
- **Tue.** Notarization. Full `.app` signed + notarized + stapled; Gatekeeper-clean first launch.
- **Wed.** DMG build, pricing page copy updated, download-page note about Genie added.
- **Thu.** TestFlight (if iOS ever lands) / direct-download release + internal dogfood email.
- **Fri.** Retro + Phase 18 kickoff.

**Exit criteria:** a non-engineer friend can download the DMG, sign in, start a call, say "genie", see Genie work, end the call, see the summary. Zero console errors.

## 8. Risks

| Risk | Likelihood | Mitigation |
| --- | --- | --- |
| Bun `--compile` binary trips Gatekeeper/notarization due to JIT entitlements | Medium | `Engine.entitlements` with `allow-jit` + `allow-unsigned-executable-memory`; smoke test via `spctl --assess` before shipping. |
| Bundle size balloons past 100 MB | Medium | Strip OpenCode test fixtures and unused providers at build time; if still >100 MB, switch to `@yao-pkg/pkg` single-binary with Node 20. |
| Speech-recognition false triggers annoy users | High | Ship disabled-by-default in Settings; require explicit opt-in; give clear visible indicator. |
| Engine crashes during a call, losing context | Medium | `GenieServerMonitor` restarts; wish ledger at `~/.genie/wishes/<id>.json` lets us resume a mid-flight wish with `jellyclaw run --resume`. |
| Chrome profile gets locked mid-wish (CDP disconnect) | Medium | Existing `ensure-cdp.mjs` already handles relaunch; extend to surface a banner "Chrome reconnecting" during a wish. |
| Two engines drift (in-tree vs standalone) | Medium | §6 — single canonical repo, artifacts checked in. |
| App Store review blocks child-process spawning | Low (we're direct-distribution today) | If MAS ever becomes a goal, fall back to Option E (LaunchAgent + XPC helper). |

## 9. What we explicitly are NOT doing in Phase 17

- Group-call multi-participant trigger detection (only the host's local mic is listened to in v1).
- TTS reply over WebRTC (Genie speaks out loud). Cool, but v2.
- iOS target. Jelly-Claw is macOS-only today; iOS requires a different engine-embedding strategy (no `Process` class) — separate phase.
- Team-mode shared wishes. Each user's engine is local.
- In-browser mini-Genie (`WKWebView`-hosted engine). Stays out-of-process.

## 10. Deliverable map

| Artifact | Path | Owner | Week |
| --- | --- | --- | --- |
| Build script | `scripts/build-engine.sh` | Engine | 1 |
| EngineSupervisor | `JellyGenieKit/Sources/JellyGenieKit/EngineSupervisor.swift` | App | 1–2 |
| Auth helpers | `Jelly-Claw/KeychainHelper.swift` (+= engine accessors) | App | 2 |
| Bearer auth on URLSession | `JellyGenieKit/…/GenieManager.swift` edits | App | 2 |
| GenieEvent extensions | `JellyGenieKit/…/GenieEvent.swift` | App | 2 |
| GenieLaunchpadView | `Jelly-Claw/GenieLaunchpadView.swift` | App | 2 |
| PCM tap (JS) | `Jelly-Claw/Resources/call-host.js` edits | App | 3 |
| SpeechManager overload | `Jelly-Claw/SpeechManager.swift` | App | 3 |
| Keyword matcher | `JellyGenieKit/…/GenieKeywordMatcher.swift` | App | 3 |
| CallGenieOverlay | `Jelly-Claw/CallGenieOverlay.swift` | App | 3 |
| PostCallSummaryView | `Jelly-Claw/PostCallSummaryView.swift` | App | 3 |
| Settings "Genie" tab | `Jelly-Claw/SettingsView.swift` edits | App | 3 |
| Failure-mode walk | `BRIDGE-DESIGN.md §9` confirmed | Both | 4 |
| Notarization | CI pipeline | Release | 4 |

## 11. After Phase 17

Phase 18 candidates:
- TTS reply over WebRTC (Genie talks back).
- Group-call trigger detection via `CATapDescription`.
- Shared-wish mode for co-working calls ("Genie, book us all on a call Friday").
- Live translation subtitle track in the call UI.
- iOS companion app with thin-client Genie (engine hosted on the user's Mac).

---

**Decision owners:**
- Engine contract (endpoints, flags, event shapes): engine team.
- Swift surfaces and Xcode plumbing: app team.
- Reconciling `engine/` dir: both teams in Week 1 Monday.
- Notarization credentials: release owner.

**Next action (today):** read `AUDIT.md` and `BRIDGE-DESIGN.md` end-to-end and flag disagreements before Monday kickoff.
