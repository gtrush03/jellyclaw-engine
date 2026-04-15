# Jelly-Claw App — Pre-Integration Audit

**Target repo:** `/Users/gtrush/Downloads/jelly-claw/`
**Audit date:** 2026-04-14
**Purpose:** Ground the `jellyclaw-engine` integration plan in what's already in the app, so we know what to reuse, what to replace, and what surprises are waiting.

---

## 1. What the app is

Jelly-Claw is a **macOS menu-bar app** (NSStatusItem-driven; `LSUIElement=false`, so it also shows in the Dock) whose primary job is two things:

1. A **voice/jelly clip recorder** that uploads to `jellyjelly.com` — this is the legacy core (`AudioRecorder`, `JellyUploader`, `WaveformView`, `JellyAccount`, `SupabaseAuth`).
2. A **multi-mode video-calling stack** layered on top (`plan.md` is the reference). Three call modes ship already:
   - **1:1 Call** (free, P2P mesh) — `CallManager` + `CallWebView` + `CallWindow`, signalled through `wss://signal.jelly-claw.com/call/:id`.
   - **Group Call** (≤8 participants, video) — `SfuRoomManager` + `SfuRoomWebView` + `SfuRoomWindow` in `.video` mode, backed by Cloudflare Realtime SFU.
   - **Voice Room** (≤8 participants, audio-only, clubhouse-style) — same `SfuRoomWindow` in `.voice` mode.

   Spectator / listener fan-out pages live on the web (`jelly-claw.com/room/:id/watch`, `/voice/:id/listen`).

So the "video calling app" framing in the task is slightly narrower than reality — the app is a **call-centric content + communication tool** with a Jelly recorder on the side.

## 2. Tech stack

| Layer | Concrete choice |
| --- | --- |
| UI | **SwiftUI hosted inside AppKit** (`NSHostingController` in an `NSPopover`). Call / SFU windows are `NSPanel` subclasses hosting WKWebView. |
| Video/audio runtime | **WKWebView with JS/WebRTC**, not native libwebrtc. Host and guest run identical JS; the Swift side talks to the WebView via `WKScriptMessageHandler`. This is a deliberate choice (`plan.md §2`) to avoid the ~50 MB libwebrtc dep. |
| Media capture | `AVAudioEngine` (`AudioRecorder.swift`) and `AVCaptureSession` (`CameraManager.swift`). Both are **released** to the WebView during a call via a documented `suspendForSpeech()` → `stop()` → WebView `getUserMedia` → resume handshake. |
| Speech | `SpeechManager.swift` wraps `SFSpeechRecognizer` for on-device transcription. The file exists and is functional, but a comment in `JellyClawApp.swift` notes it's **currently disabled** ("speech recognition is no longer used"). This is a gift for Genie: the codepath is already written, we just need to re-enable it and feed the mic from a different source during a call. |
| Signaling server | **Cloudflare Workers + Durable Objects**, deployed at `signal.jelly-claw.com`. Written in TypeScript (`signaling-server/src/{index,call-room,sfu-room,sfu,types}.ts`), dev runtime is `wrangler`, tiny local dev runner at `local-dev.mjs`, deps: `ws` + `@cloudflare/workers-types`. Not a Node process — it's a Workers runtime. |
| Web frontend | `web/call/` contains the **guest-side** static HTML/JS/CSS bundled with the same signaling conventions. The Cloudflare-hosted site at `jelly-claw.com/room/:id`, `/watch`, `/voice/:id`, `/listen` etc. lives here — it's the "browser guest" surface, not an admin panel. |
| Build system | **Classic Xcode project** (`Jelly-Claw.xcodeproj`) — no Tuist, no XcodeGen, no CocoaPods, no Podfile at root. One **Swift Package** is wired in via local path: `JellyGenieKit` (a SwiftPM target that the Xcode project depends on for Genie plumbing). |
| Target | **macOS 12+** (`JellyGenieKit/Package.swift: .macOS(.v12)`). Universal binary (Intel + Apple Silicon) is already shipped (`TESTING.md §Step 1`). |
| Auth & cloud | `SupabaseAuth.swift` + `KeychainHelper.swift` — credentials already land in the Keychain, so token storage for the engine is a solved problem we can lean on. |

## 3. Existing AI / LLM integration — **there is already a Genie layer**

This is the single most important finding. The task framing implied we're bolting Genie onto a bare video app. We're not. The app ships a full Genie layer already, and the existing engine directory is more or less a sibling to what we're building in `/Users/gtrush/Downloads/jellyclaw-engine/`:

- **`JellyGenieKit/`** — SwiftPM package (~2.7k LOC Swift). Key classes:
  - `GenieManager` (1,650 LOC) — state machine for server status, dispatches, wish events, install progress, auth sync, SSE consumption.
  - `GenieServerMonitor` (152 LOC) — heartbeat + wake-from-sleep + CDP health-check + auto-restart + Jelly-Chat recovery notifications.
  - `SSEParser` (90 LOC) — production-quality line-based SSE parser with CRLF tolerance, `id:` stickiness, blank-line-flush, reconnect-safe `resetPending()`. **This is exactly the parser we need; don't rewrite it.**
  - `GenieEvent`, `GenieLogLine`, `GenieConfig`, `SoulBuilder`, `SoulStore`, `Auth/`, `Views/` — event typing, config persistence, "soul" (personalisation) scaffolding, and SwiftUI surface components.
- **`genie-server/`** — a bundled Node.js service (has `package.json`, `scripts/`, `src/`, `skills/`, `config/`, `docs/`). The `GenieManager.bundledServerURL` line in `JellyClawApp.swift` shows the app **already ships this inside `Contents/Resources/genie-server/`** and points the Genie layer at it at launch. It listens on `http://127.0.0.1:7778` and exposes `/status`, `/dispatches`, `/events` (SSE). The existing engine pattern is already loopback-HTTP + SSE.
- **`engine/`** (new, April 2026) — contains `SPEC.md` and `INTEGRATION.md` for a **new** OpenCode-based engine explicitly meant to replace Claurst. This engine is **named "jelly-claw"** inside that spec (confusingly, same as the app). The `INTEGRATION.md` maps 20 production behaviors from the current Claurst-based Genie onto the new engine and describes the `dispatcher.mjs` diff to switch. So the repo already thinks in terms of a binary called `jelly-claw` that speaks `stream-json` on stdout and exposes an HTTP+SSE `serve` mode.
- **`desktop/SPEC.md`** — the SwiftUI layer's spec for the Genie control surface.

**Collision warning.** The standalone engine we are wrapping at `/Users/gtrush/Downloads/jellyclaw-engine/` and the in-tree engine at `/Users/gtrush/Downloads/jelly-claw/engine/` refer to the *same* lineage (both OpenCode-derived). The integration story is not "build a bridge" so much as **"unify the binary and the bridge, and replace the bundled Node `genie-server` at `127.0.0.1:7778` with the compiled `jellyclaw` engine."** This dramatically simplifies the work.

## 4. Signaling server — details

- Runtime: Cloudflare Workers (V8 isolates). **Not a Node process**, so we cannot co-locate jellyclaw there.
- Durable Objects: one per call/room, holds WebSocket connections, does room-full logic, generates TURN credentials via `turn-credentials.ts`, brokers SFU session creation via `sfu.ts` (calls Cloudflare's Realtime API server-side using `CALLS_APP_ID`/`CALLS_APP_TOKEN` worker secrets).
- This is **irrelevant to the Genie engine bridge** — Genie doesn't need to share a process with it. But it *is* relevant for the audio-listening feature: the host's WKWebView has the mixed audio stream (`plan.md §6` describes the `AudioContext` mix already plumbed for MediaRecorder). Genie can tap that same mix.

## 5. Web frontend — details

`web/call/` is just the guest/host HTML/JS/CSS. Not an admin console. Its role in the Genie story is that **the in-call UI Genie speaks into lives in JavaScript**, not in SwiftUI — banners, chat, timeline are all DOM. So "show a Genie banner in the call" = send a `postMessage` from Swift → WKWebView → JS renders a DOM node. No SwiftUI overlay required.

## 6. Entitlements & Info.plist (as-shipped)

- `app-sandbox = false` → **the app is not sandboxed**. This is a huge unlock: we can spawn arbitrary child processes, bind arbitrary loopback ports, and open Unix domain sockets without wrestling with sandbox extensions. We do not need to fight `com.apple.security.files.user-selected.read-write` dance or `com.apple.security.inherit` for the child.
- Network client entitlement present, but no network server entitlement is listed — irrelevant when sandbox is off, but if the app ever re-enables sandbox we'd need to add `com.apple.security.network.server` for the loopback listener.
- Mic + camera device entitlements present.
- **No notarization yet** (`TESTING.md §Step 1`: "first launch will be blocked by Gatekeeper…not notarized"). For the Genie bundle we inherit this — no added pain, but we should plan to do full notarization together for the Phase-17 release.
- `Info.plist` declares the URL scheme `jellyclaw://`, which Genie can use for deep-linking ("open wish in app").
- `NSMicrophoneUsageDescription` and `NSCameraUsageDescription` are present.

## 7. Build / packaging facts

- `Jelly-Claw.xcodeproj` is the single build target. A Copy-Files (→ `Resources`) phase already places `genie-server/` inside the `.app` bundle at build time (inferred from `GenieManager.bundledServerURL = Bundle.main.url(forResource: "genie-server", ...)`).
- There's a `build/` directory at the repo root (`ls /Users/gtrush/Downloads/jelly-claw/build/`) holding the DMG artifacts — `jelly-claw.com/Jelly-Claw.dmg` (3.6 MB). That size is pre-engine; with a Bun-compiled `jellyclaw` binary (~50–90 MB on darwin-arm64) the DMG will balloon to ~60–100 MB. Acceptable.
- SPM dep wired as a **local package reference** — no remote fetch — so `JellyGenieKit` versions lock-step with the app.

## 8. Existing server state the engine must respect

From `GenieManager.swift` and its peers, these endpoints are what the SwiftUI already talks to. Anything the compiled jellyclaw engine exposes must either match them or provide adapters:

| Endpoint | Method | Shape | Consumer |
| --- | --- | --- | --- |
| `GET /status` | → `{ activeDispatches, stats:{total,done,cancelled,errored}, running:[{clipId,title,creator,transcript,jellyUrl,pid,startedAt}] }` | `checkServerStatus` every 60s heartbeat | |
| `GET /dispatches` | → `{ dispatches:[{clipId,title,creator,transcript,jellyUrl,status,model,turns,usdCost,result,errorMessage,createdAt,startedAt,completedAt}] }` | `fetchDispatches` | |
| `GET /events` | text/event-stream with `id:`, `event:`, `data:` fields | `runEventStream` (long-poll, exp-backoff reconnect) | |
| `POST /…` (webhook ingestion, chrome start, server start) | various | Called by `startServer()` / `startChrome()` | |

Port is **hardcoded to 7778** in the Swift side. The ideal end state is to **keep 7778 as the legacy compat port** and either (a) have jellyclaw bind there with `--port 7778` in compat mode, or (b) have jellyclaw bind to OS-picked port and a tiny Swift-side proxy or an updated `GenieConfig.swift` teaches the app the real port. Path (b) is cleaner; see `BRIDGE-DESIGN.md`.

## 9. Surprises / gotchas

1. **Two "jelly-claw" engines exist already** (`engine/` in-tree vs the standalone `jellyclaw-engine/` we were pointed at). These must be reconciled before coding starts, or we'll build the bridge twice.
2. **The SSE parser is already production-hardened** (`JellyGenieKit/SSEParser.swift`). Any code snippet we put in `BRIDGE-DESIGN.md` for SSE parsing should reuse `SSEParser`, not invent a new one.
3. **SpeechManager is dormant but wired.** The "genie" trigger-word implementation doesn't require new infra — re-enable the class, point its tap at the call's mic stream (or at a second tap on `AVAudioEngine`) and forward `transcribedText` changes into a keyword matcher.
4. **The WKWebView owns the mic during calls.** That means `SFSpeechRecognizer` can't tap the mic the same way `SpeechManager` currently does. Two viable fixes:
   - Ask the WebView's JS to duplicate its post-mix audio out to a `ScriptProcessorNode` / `AudioWorklet` that streams raw PCM back over `WKScriptMessageHandler`, and feed that into `SFSpeechAudioBufferRecognitionRequest.appendAudioPCMBuffer(_:)`.
   - Or run speech recognition *in the WKWebView* via `Web Speech API`. Worse (cloud-dependent on macOS Safari engine).
   Preferred path is (1) — stays on-device.
5. **GenieServerMonitor already does Chrome CDP health-checks at `http://127.0.0.1:9222/json/version`.** Our new binary does not need to re-implement this; we just need to keep feeding that check.
6. **`app-sandbox=false`** is load-bearing. If someone flips it, the whole loopback-IPC plan gets 3× more complex. Document this dependency in the design doc.
7. **`jellyclaw://` URL scheme is live.** We can use it for "open this wish" deep-links from Telegram / Jelly Chat without inventing anything.
8. **The Keychain helper already exists** (`KeychainHelper.swift`). Use it for the auth token; never use `UserDefaults`.
9. **No existing "Genie panel" in the call window.** `CallWindowOverlay.swift` handles post-recording "post as jelly" prompts but has no Genie surface. This is the SwiftUI gap the integration has to fill.
10. **The `engine/INTEGRATION.md` file already covers 20 behavior parity checks** — do not re-derive these; cite them.

## 10. One-paragraph summary for the design doc

Jelly-Claw is an existing macOS menu-bar app with a 3-mode WebRTC calling stack (WKWebView-hosted JS), a Cloudflare-Workers signalling service, a Supabase-auth'd Jelly-recorder core, and a **mature in-app Genie layer** (`JellyGenieKit` SwiftPM target + a bundled Node `genie-server` Copy-Files'd into `Contents/Resources/genie-server/`, reachable at `127.0.0.1:7778`). The engine integration is therefore not a greenfield bridge but a **swap**: replace the bundled Node server with a single Bun-compiled `jellyclaw` binary while preserving the `/status` + `/dispatches` + `/events` contract the Swift code already consumes, and extend the surface with live-call features (trigger-word listening, in-call banner, post-call receipts). Sandbox is off, Keychain exists, SSE parser is shipped, SpeechManager is dormant-but-wired — all of which compresses the risk budget significantly.
