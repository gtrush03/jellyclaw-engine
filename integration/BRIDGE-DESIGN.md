# Swift ↔ Node Bridge — Technical Design

**Scope:** the machinery that lets the Jelly-Claw macOS app (Swift/AppKit/SwiftUI) drive the `jellyclaw-engine` (Node/TypeScript, Bun-compiled) as its Genie AI runtime. This document is the contract between the two teams — if you're writing Swift or writing engine CLI flags, this is your source of truth.

Companion docs: `AUDIT.md` (what already exists), `JELLY-CLAW-APP-INTEGRATION.md` (the end-to-end story).

**Choice:** Option A — bundled Bun binary + loopback HTTP + SSE. Rationale is in §1.

---

## 1. Why Option A wins the audit

The app **already** ships a Node `genie-server/` process inside `Contents/Resources/` and already talks to it over `127.0.0.1:7778` with a full SSE parser hardened in `JellyGenieKit/SSEParser.swift`. Every alternative (JavaScriptCore, napi-rs FFI, XPC helper, Unix domain sockets) would require net-new Swift plumbing *and* would leave the existing HTTP/SSE pathway orphaned. Option A is literally **"replace the Node binary, keep the wire"**.

Secondary reason: `app-sandbox=false` in the current entitlements (see `AUDIT.md §6`) means `Process.run()`ing a child binary, binding loopback ports, and reading its stdout is **trivial** — no sandbox extensions, no bookmarked file access, no `com.apple.security.inherit` gymnastics.

The only reason to revisit Option A is if someone re-enables App Sandbox for Mac-App-Store distribution. In that world the recommended fallback is Option E (LaunchAgent + Mach/XPC) because sandboxed processes cannot spawn arbitrary executables.

## 2. Wire protocol

**Transport:** HTTPS? No — plaintext HTTP on `127.0.0.1`. Loopback is not sniffable by other users on the machine, and TLS on loopback buys nothing but complexity. We rely on **bearer auth** (see §5) to defend against other local processes probing the port.

**Base URL:** `http://127.0.0.1:<port>/` where `<port>` is announced by the engine on startup (see §4 handshake).

**Endpoints (engine must implement, Swift already consumes):**

| Route | Method | Semantics |
| --- | --- | --- |
| `/status` | GET | Snapshot. Shape exactly as defined in `AUDIT.md §8`. |
| `/dispatches` | GET | All wishes (running + terminal). |
| `/events` | GET | `text/event-stream`. Long-poll, no timeout. Fields: `id:` (monotonic seq), `event:` (type), `data:` (JSON payload). Engine sends `: connected <ts>` and `: keepalive <ms>` comments. Blank line terminates each record. |
| `/v1/runs` | POST | **New** (Option A introduces this). Starts a wish. Body: `{ prompt, sessionId?, context:{ callId?, participants?, transcript? }, tierHint? }`. Responds `{ wishId, sessionId, pid }`. |
| `/v1/runs/:wishId/cancel` | POST | Graceful cancel (SIGTERM to the subagent, 2s grace, then SIGKILL). |
| `/healthz` | GET | `{ ok:true, version, pid, port, startedAt }`. Used by Swift monitor. |
| `/chrome/ensure` | POST | Delegates to the existing `ensure-cdp.mjs` logic. Returns `{ alive, pid }`. |

**Shape drift:** None for the three legacy endpoints. New endpoints are additive.

## 3. Bundle strategy

### 3.1 Compiling the engine

Build step (runs in CI and locally via `scripts/build-engine.sh`):

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine
bun install
bun build ./src/cli.ts \
  --compile \
  --target=bun-darwin-arm64 \
  --outfile=dist/jellyclaw-arm64
bun build ./src/cli.ts \
  --compile \
  --target=bun-darwin-x64 \
  --outfile=dist/jellyclaw-x64
# Fat binary for the universal app target
lipo -create -output dist/jellyclaw dist/jellyclaw-arm64 dist/jellyclaw-x64
codesign --force --options runtime \
  --sign "Developer ID Application: TRU (TEAMID)" \
  dist/jellyclaw
```

`lipo` works because Bun's `--compile` emits a normal Mach-O; we verify with `file dist/jellyclaw` (expect `Mach-O universal binary with 2 architectures`).

### 3.2 Embedding in the `.app`

Target path inside the bundle:

```
Jelly-Claw.app/
  Contents/
    MacOS/Jelly-Claw
    Resources/
      genie-server/              # LEGACY — remove in Phase 17 Week 3
      jellyclaw-engine/
        jellyclaw                # the universal binary (codesigned)
        skills/                  # bundled skills dir (read-only at runtime)
        system-prompt.md         # default system prompt
        VERSION                  # semver string
```

Xcode changes:
1. **Add a new Copy Files Build Phase** (destination = Resources, subpath = `jellyclaw-engine`) that pulls from `$(SRCROOT)/engine-artifacts/` (a symlink or copy of `jellyclaw-engine/dist/`).
2. **Add a Run Script phase BEFORE the copy** that invokes `scripts/build-engine.sh` if `$(CONFIGURATION)` is `Release` and the binary is stale.
3. **Mark the binary as executable** in the Copy Files phase (tick "Code Sign On Copy"); Xcode handles the nested signing under the hardened runtime automatically.

### 3.3 Code-signing requirements

- Hardened runtime: **yes** (required for notarization).
- Library validation: **disabled on the engine binary only** — Bun's compiled blob contains an embedded V8 which is effectively a JIT, so we need the entitlement `com.apple.security.cs.allow-jit = true` AND `com.apple.security.cs.allow-unsigned-executable-memory = true` on the child. The *parent* app does **not** need these — we put them on a separate entitlements file and pass it to `codesign` for the engine binary only.
- Timestamp: `--timestamp` (required for notarization).
- Notarization: the whole `.app` is submitted; the nested engine binary's signature is verified transitively.

Two entitlement files:

**`Jelly-Claw.entitlements`** (parent, already exists — extend):

```xml
<key>com.apple.security.app-sandbox</key><false/>
<key>com.apple.security.network.client</key><true/>
<key>com.apple.security.device.audio-input</key><true/>
<key>com.apple.security.device.camera</key><true/>
<!-- NEW: scripting target so we can talk to Chrome when needed -->
<key>com.apple.security.automation.apple-events</key><true/>
<key>com.apple.security.scripting-targets</key>
<dict>
  <key>com.google.Chrome</key>
  <array><string>com.google.Chrome.BrowserShell</string></array>
</dict>
```

**`Engine.entitlements`** (for the embedded binary):

```xml
<key>com.apple.security.cs.allow-jit</key><true/>
<key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
<key>com.apple.security.cs.disable-library-validation</key><true/>
```

## 4. Process lifecycle

### 4.1 Spawn

Swift spawns the engine at app launch, **after** `applicationDidFinishLaunching` has wired up `GenieManager` and **before** it calls `startStatusPolling()`.

```swift
// JellyGenieKit/Sources/JellyGenieKit/EngineSupervisor.swift   (new file)
import Foundation

public final class EngineSupervisor {
    public private(set) var port: Int = 0
    public private(set) var authToken: String = ""
    public private(set) var process: Process?

    private let portFile = FileManager.default
        .urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("JellyClaw/engine.port")

    public func start(binaryURL: URL, skillsURL: URL) throws {
        let token = KeychainHelper.ensureEngineAuthToken()   // 32 random bytes, base64
        self.authToken = token

        let proc = Process()
        proc.executableURL = binaryURL
        proc.arguments = [
            "serve",
            "--bind", "127.0.0.1",
            "--port", "0",                       // OS picks
            "--auth-token-env", "JELLYCLAW_AUTH_TOKEN",
            "--event-format", "sse",
            "--skills-dir", skillsURL.path,
            "--state-dir", stateDir().path,      // ~/Library/Application Support/JellyClaw/engine-state
            "--log-format", "jsonl",
            "--announce-port-file", portFile.path,
            "--parent-pid", String(ProcessInfo.processInfo.processIdentifier),
        ]
        proc.environment = ProcessInfo.processInfo.environment.merging([
            "JELLYCLAW_AUTH_TOKEN": token,
            "OPENROUTER_API_KEY":   KeychainHelper.openrouterKey() ?? "",
            "ANTHROPIC_API_KEY":    KeychainHelper.anthropicKey() ?? "",
        ]) { _, new in new }

        let stdout = Pipe()
        proc.standardOutput = stdout
        proc.standardError = stdout
        proc.terminationHandler = { [weak self] p in
            self?.handleExit(code: p.terminationStatus)
        }
        try proc.run()
        self.process = proc

        // Handshake: read the port file (written atomically by the engine).
        self.port = try waitForPort(timeout: 5.0)
    }

    public func stop(graceSeconds: TimeInterval = 2.0) {
        guard let p = process, p.isRunning else { return }
        p.terminate() // SIGTERM
        let deadline = Date().addingTimeInterval(graceSeconds)
        while p.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.05) }
        if p.isRunning { kill(p.processIdentifier, SIGKILL) }
    }

    private func waitForPort(timeout: TimeInterval) throws -> Int {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if let s = try? String(contentsOf: portFile, encoding: .utf8),
               let n = Int(s.trimmingCharacters(in: .whitespacesAndNewlines)),
               n > 0 {
                return n
            }
            Thread.sleep(forTimeInterval: 0.025)
        }
        throw EngineError.portHandshakeTimeout
    }
}
```

### 4.2 Announce-port contract (engine side)

```ts
// src/cli/serve.ts (engine)
const server = Bun.serve({
  hostname: cfg.bind,
  port: cfg.port, // 0 = OS picks
  fetch: router.fetch,
});
const chosen = server.port;
await Bun.write(cfg.announcePortFile, String(chosen) + "\n");
// Also emit a stdout line so anyone tailing logs sees it:
console.log(JSON.stringify({ type: "listen", host: cfg.bind, port: chosen }));
```

### 4.3 Shutdown

Three paths must terminate the child cleanly:

1. `applicationShouldTerminate` in `AppDelegate` → `EngineSupervisor.stop()`.
2. Engine crash → `terminationHandler` fires, `GenieServerMonitor` detects `/healthz` 5xx/timeout, triggers restart (existing monitor already does this; we just swap the binary).
3. Parent pid death (user force-quits from Activity Monitor) → engine's `--parent-pid` watcher polls `kill(ppid, 0)` every 2s and self-exits when it returns `ESRCH`. Prevents orphans.

PID file at `~/Library/Application Support/JellyClaw/jellyclaw.pid` written by the engine on boot, removed on clean exit. Swift supervisor reads it on *next* launch and `SIGTERM`s any leftover pid before spawning a new one.

## 5. Security

### 5.1 Auth token

- 32 random bytes, base64-encoded (44 chars). Generated **once per install** and stored in the **Keychain** via `KeychainHelper` (which already exists — see `Jelly-Claw/KeychainHelper.swift`). Service name: `com.jelly-claw.engine.auth`. Never in `UserDefaults`, never in the port file.
- Passed to the child only via `env` (never argv — argv is world-readable in `ps(1)`).
- Every request from Swift carries `Authorization: Bearer <token>`. Engine rejects missing/mismatched with 401. SSE endpoint checks the header on initial upgrade only (EventSource can't set headers, but we control both ends — we use `URLSession.bytes(for:)` not EventSource).

### 5.2 Transport

- `127.0.0.1` bind. Not `0.0.0.0`. Not `::`. Guard in the engine: reject any non-loopback listen address unless `JELLYCLAW_ALLOW_REMOTE=1` is explicitly set (dev only).
- **CORS:** disabled. We're not a browser API. `Access-Control-Allow-Origin: null` on all responses.

### 5.3 Keychain + env

| Secret | Where it lives | How engine receives it |
| --- | --- | --- |
| Auth token | Keychain (`com.jelly-claw.engine.auth`) | env var `JELLYCLAW_AUTH_TOKEN` |
| OpenRouter key | Keychain (`com.jelly-claw.openrouter.key`) | env var `OPENROUTER_API_KEY` |
| Anthropic key | Keychain (`com.jelly-claw.anthropic.key`) | env var `ANTHROPIC_API_KEY` |
| Jelly auth token | Keychain (`com.jelly-claw.jelly.token`) | env var `JELLY_AUTH_TOKEN` |

Swift `KeychainHelper` gains these accessors; they already follow the existing pattern.

## 6. SSE consumption on Swift side

**Reuse, don't rewrite.** `JellyGenieKit/SSEParser.swift` and `GenieManager.runEventStream()` already do production-quality SSE with exponential backoff, sticky `id:`, byte-by-byte iteration (specifically to avoid `AsyncBytes.lines` swallowing blank lines — see the inline comment explaining that gotcha).

The only changes needed:

1. `webhookBase` (currently hardcoded `http://127.0.0.1:7778`) becomes a property sourced from `EngineSupervisor.port`:

```swift
// Before
private let webhookBase = "http://127.0.0.1:7778"

// After
private var webhookBase: String {
    "http://127.0.0.1:\(EngineSupervisor.shared.port)"
}
```

2. Every `URLRequest` gets the bearer header:

```swift
extension URLRequest {
    mutating func addEngineAuth() {
        setValue("Bearer \(EngineSupervisor.shared.authToken)",
                 forHTTPHeaderField: "Authorization")
    }
}
```

3. New event types (engine emits OpenCode-native `message.part.updated`, `tool.call.start`, `tool.call.end` per `engine/INTEGRATION.md §2c`) get cases added in `GenieEvent.classify(from:)`. Old Claurst shapes remain classified for log-replay compatibility.

## 7. Starting a wish (the `/v1/runs` request)

```swift
public func runWish(prompt: String,
                    context: CallContext?,
                    tierHint: String? = nil) async throws -> WishHandle {
    var req = URLRequest(url: URL(string: "\(webhookBase)/v1/runs")!)
    req.httpMethod = "POST"
    req.addEngineAuth()
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")

    let body: [String: Any] = [
        "prompt": prompt,
        "context": [
            "callId":       context?.callId as Any,
            "participants": context?.participants as Any,
            "transcript":   context?.transcriptExcerpt as Any,
        ].compactMapValues { $0 },
        "tierHint": tierHint as Any,
    ].compactMapValues { $0 }

    req.httpBody = try JSONSerialization.data(withJSONObject: body)
    let (data, resp) = try await URLSession.shared.data(for: req)
    guard (resp as? HTTPURLResponse)?.statusCode == 200 else {
        throw EngineError.wishRejected(data)
    }
    let decoded = try JSONDecoder().decode(WishHandle.self, from: data)
    return decoded
}
```

From the engine side, `/v1/runs` maps 1:1 to the existing `dispatchToClaude()` dispatcher logic described in `engine/INTEGRATION.md §2b`. The difference vs. Claurst: the wish comes in over HTTP from the app, not via the JellyJelly poller. The poller stays wired for the existing flow.

## 8. Voice trigger detection (SpeechManager resurrection)

`SpeechManager.swift` already wraps `SFSpeechRecognizer`. The dormancy note in `JellyClawApp.swift` is just a comment — the class is functional. The bridge design wrt triggering:

1. During a call, `CallManager` hands the WKWebView the mic exclusively (existing handshake: `AudioRecorder.suspendForSpeech()` → `CameraManager.stop()` → WebView `getUserMedia`).
2. **New:** the WebView's JS in `call-host.js` duplicates the incoming mic stream into an `AudioWorkletNode` that posts 16 kHz Int16 PCM frames back to Swift via `WKScriptMessageHandler`.
3. Swift receives the frames and feeds them into `SFSpeechAudioBufferRecognitionRequest.append(_:)` — the `SpeechManager.beginRecognition()` method gets a new sibling `beginRecognition(from webViewHandler:)` that skips `inputNode.installTap` and consumes buffers from a `PassthroughSubject<AVAudioPCMBuffer, Never>` instead.
4. A 2 KB rolling window of `transcribedText` is scanned each update for the fuzzy keyword set (`genie|jeanie|jinnie|djinni` — the same regex as `firehose.mjs:141` in the existing server).
5. On match: the trailing utterance is trimmed via simple sentence segmentation (`/[.!?]\s/` split), fed into `/v1/runs` with `context = { callId, participants, transcriptExcerpt }`.

Alternative path (no JS changes): have Swift open a second `AVAudioEngine` tapping the **system output** via `CATapDescription` (macOS 14.2+ screen-capture-audio) and run recognition against the mixed call audio. This catches both speakers and needs no JS coordination. Tradeoff: requires `NSSpeechRecognitionUsageDescription` re-prompt and a ScreenCaptureKit audio capture permission dialog. Recommend Path 1 for v1, Path 2 as a follow-up if recognition on self-only voice is not enough.

## 9. Failure modes

| Mode | Detection | Recovery |
| --- | --- | --- |
| Engine binary missing / corrupt | `Process.run()` throws `NSPOSIXErrorDomain code=2` | App shows banner "Genie unavailable — reinstall", falls back to legacy `genie-server/` bundle if still present |
| Port handshake timeout (5s) | `EngineSupervisor.waitForPort` throws | `SIGKILL` any child, retry once with a different port file path, then surface to user |
| Port bind race (someone else grabbed :N) | Engine `Bun.serve` throws | Re-request OS-assigned port, up to 3 retries |
| Engine crash mid-wish | `terminationHandler` fires with nonzero status; `GenieServerMonitor` sees `/healthz` down | Monitor restarts engine; SSE loop reconnects with backfill (`backfillActiveClips`); the dead wish shows `errored` |
| Auth token leak (dev mistake) | n/a | Rotate via "Reset Genie" in settings → new 32 random bytes → Keychain → next launch restarts engine |
| Chrome CDP not running | `checkChromeCDP()` returns false | `manager.startChrome()`, 5s cold-start sleep, re-probe |
| Chrome not installed | `startChrome()` fails with path missing | Banner "Install Google Chrome to enable browser wishes" with link |
| Keychain read denied | `KeychainHelper.ensureEngineAuthToken` throws | Fresh token generated + written; user prompted to approve new keychain item on next access |
| Disk full (state dir) | engine returns 5xx on `/v1/runs` with `state_dir_full` | Surfaced to user; monitor continues running, wishes parked |
| Mic permission revoked mid-call | `SFSpeechRecognizer` delivers `kAFAssistantErrorDomain` | `SpeechManager` logs, mutes trigger detection for the call, banner informs user |

## 10. Observability

- **Engine stdout/stderr** piped through the Process handle → appended to `~/Library/Logs/JellyClaw/engine.jsonl` with rotation at 10 MB. `GenieLogLine` already models one line.
- **Dispatcher trace** (the per-wish JSONL mentioned in `engine/INTEGRATION.md §Behavior 17`) lands in `~/.genie/traces/<wishId>.jsonl`. Unchanged path.
- **Prometheus-style counters** exposed by the engine at `/metrics` (plaintext) for future dashboarding — wish_total, wish_errors_total, tool_call_total{tool=}, session_active. Not wired in v1.

## 11. End-to-end checklist

Before Phase-17-Week-2 demo:

- [ ] `scripts/build-engine.sh` produces a universal signed binary <100 MB.
- [ ] Xcode Build Phase copies it into `Contents/Resources/jellyclaw-engine/`.
- [ ] `EngineSupervisor.start()` reaches "listening" within 2s on an M-series Mac.
- [ ] `curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:$PORT/healthz` returns 200.
- [ ] SwiftUI Genie panel shows `running` status pulled via `/status`.
- [ ] `POST /v1/runs` with a trivial prompt produces a wish whose SSE events arrive in `GenieManager.wishEvents`.
- [ ] App quit terminates the child; relaunch finds no orphan via `pid` file.
- [ ] Force-quit parent: child self-exits within 4s via `--parent-pid` watcher.

That's the bridge.
