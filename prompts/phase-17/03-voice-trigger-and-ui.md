# Phase 17 — Integration into jelly-claw Video-Calling App — Prompt 03: Voice trigger + in-call SwiftUI surfaces

**When to run:** After Prompt 02 (`17.02-swift-bridge-and-bundling.md`) is committed, the bridge tests are green, and a "hello world" dispatch round-trips SSE events. Do not start until `JellyclawBridge.shared.start()` is reliable.
**Estimated duration:** 10–12 hours (roughly half speech/audio plumbing, half SwiftUI)
**New session?** Yes
**Model:** Claude Opus 4.6 (1M context)

---

## Session startup

Paste `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/STARTUP-TEMPLATE.md`, substituting `<NN>` with `17`. Also read before coding:

1. `/Users/gtrush/Downloads/jellyclaw-engine/integration/BRIDGE-DESIGN.md` §8 — voice-trigger design.
2. `/Users/gtrush/Downloads/jellyclaw-engine/integration/JELLY-CLAW-APP-INTEGRATION.md` §3.4, §4 — UX surfaces.
3. `/Users/gtrush/Downloads/jellyclaw-engine/integration/AUDIT.md` §9.3–§9.4 — dormant `SpeechManager`, mic-ownership handoff during calls.
4. `/Users/gtrush/Downloads/jelly-claw/Jelly-Claw/SpeechManager.swift` — exactly the class we are reviving.
5. `/Users/gtrush/Downloads/jelly-claw/Jelly-Claw/CallManager.swift`, `CallWindow.swift`, `CallWebView.swift`, `SfuRoomWindow.swift`, `SfuRoomWebView.swift` — the three call modes that need overlays.
6. `/Users/gtrush/Downloads/jelly-claw/web/call/index.html` — WKWebView JS host, where the `AudioWorkletNode` patch lands.
7. `/Users/gtrush/Downloads/jelly-claw/Jelly-Claw/Resources/call-host.html` — if separate from `web/call/index.html`, patch both.
8. `/Users/gtrush/Downloads/genie-2.0/src/core/firehose.mjs` around line 141 — the fuzzy-keyword regex we are porting verbatim so the trigger behavior matches Genie's JellyJelly pipeline.
9. Apple docs (WebFetch):
   - https://developer.apple.com/documentation/speech/sfspeechrecognizer
   - https://developer.apple.com/documentation/speech/sfspeechaudiobufferrecognitionrequest
   - https://developer.apple.com/documentation/webkit/wkscriptmessagehandler
   - https://developer.apple.com/documentation/webkit/wkusercontentcontroller/add(_:name:)
   - https://developer.apple.com/documentation/avfaudio/avaudiopcmbuffer

## Research task

- `grep -rn "SpeechManager" /Users/gtrush/Downloads/jelly-claw/` — confirm the class is wired nowhere production-active (dormant per audit). List the one usage in `JellyClawApp.swift` that the audit flags as a comment-only reference.
- Open `web/call/index.html` and locate the WebRTC `RTCPeerConnection`. Identify which variable holds the local `MediaStream` (likely `localStream` or similar) and which holds the remote `MediaStream`. The AudioWorklet taps the **local** stream for v1 (trigger on the user's own voice only; group-call multi-speaker is explicitly out-of-scope per `JELLY-CLAW-APP-INTEGRATION.md §9`).
- Confirm `WKUserContentController` wiring in `CallWebView.swift`. The existing `WKScriptMessageHandler` registrations tell you the pattern to follow for `audioFrames`.
- Check `Jelly-Claw/Info.plist` for `NSSpeechRecognitionUsageDescription`. If absent, add it (required by SFSpeechRecognizer since macOS 10.15).

## Implementation task

**Goal.** After this prompt: the user opts into "Enable Genie voice trigger" in Settings, joins a call (any mode), says "genie book me time with Sarah tomorrow", a banner slides in at the top of the call window showing Genie working, the wish dispatches with the call context attached, events stream into a timeline overlay, and the banner morphs into a "Done — tap to see receipt" pill when the session completes. After the call ends, a `PostCallSummaryView` lists all wishes that ran with their outcomes.

### Files to create

- `/Users/gtrush/Downloads/jelly-claw/JellyGenieKit/Sources/JellyGenieKit/GenieKeywordMatcher.swift` — fuzzy keyword matcher (port of `firehose.mjs:141`).
- `/Users/gtrush/Downloads/jelly-claw/Jelly-Claw/CallGenieOverlay.swift` — top-of-window banner + expandable timeline (NSPanel floating above the WKWebView).
- `/Users/gtrush/Downloads/jelly-claw/Jelly-Claw/PostCallSummaryView.swift` — sheet shown when a call ends with one or more wishes.
- `/Users/gtrush/Downloads/jelly-claw/Jelly-Claw/GenieLaunchpadView.swift` — pre-call panel inside the popover's `ContentView`.
- `/Users/gtrush/Downloads/jelly-claw/JellyGenieKit/Sources/JellyGenieKit/Views/GenieTimelineRow.swift` — reusable row for events (shared between overlay + summary).
- `/Users/gtrush/Downloads/jelly-claw/JellyGenieKit/Tests/JellyGenieKitTests/GenieKeywordMatcherTests.swift` — XCTest with mock audio frame samples.

### Files to modify

- `/Users/gtrush/Downloads/jelly-claw/Jelly-Claw/SpeechManager.swift` — add a new overload that consumes PCM buffers from WKWebView instead of `AVAudioEngine.inputNode`.
- `/Users/gtrush/Downloads/jelly-claw/Jelly-Claw/CallWebView.swift` and `SfuRoomWebView.swift` — register the `audioFrames` `WKScriptMessageHandler`, decode incoming Float32 frames, forward to `SpeechManager`.
- `/Users/gtrush/Downloads/jelly-claw/Jelly-Claw/CallWindow.swift`, `SfuRoomWindow.swift` — host the `CallGenieOverlay` above the WebView.
- `/Users/gtrush/Downloads/jelly-claw/web/call/index.html` and `Jelly-Claw/Resources/call-host.html` — inject the AudioWorklet patch (below).
- `/Users/gtrush/Downloads/jelly-claw/Jelly-Claw/SettingsView.swift` — add a "Genie" tab with opt-in toggle for voice trigger.
- `/Users/gtrush/Downloads/jelly-claw/Jelly-Claw/Jelly-Claw.entitlements` — add mic + speech recognition entitlements.
- `/Users/gtrush/Downloads/jelly-claw/Jelly-Claw/Info.plist` — add `NSSpeechRecognitionUsageDescription`.

### Entitlements patch

`Jelly-Claw.entitlements` — add two keys to the existing dict:

```xml
<key>com.apple.security.personal-information.speech-recognition</key><true/>
<!-- mic entitlement already present from the call feature -->
```

`Info.plist` additions:

```xml
<key>NSSpeechRecognitionUsageDescription</key>
<string>Jelly-Claw listens on-device for the word "genie" during calls to trigger AI assistance. Audio is processed locally and never sent to the cloud.</string>
<key>NSMicrophoneUsageDescription</key>
<string>Jelly-Claw uses the microphone for video and voice calls, and — when you enable the Genie voice trigger — to listen for the word "genie" on-device.</string>
```

### call-host.js AudioWorklet patch

Paste into the end of the `<script>` block in both `web/call/index.html` and `Resources/call-host.html`. Adapt variable names to the existing code — the audit says `localStream` is the typical name.

```js
// Genie voice-trigger: tap the local mic stream, post 16 kHz Int16 PCM frames to Swift.
async function genieInstallAudioTap() {
  if (!window.webkit || !window.webkit.messageHandlers || !window.webkit.messageHandlers.audioFrames) return;
  if (!localStream) { console.log("genie tap: no localStream yet"); return; }
  const ctx = new AudioContext({ sampleRate: 16000 });
  await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([`
    class GenieTapProcessor extends AudioWorkletProcessor {
      constructor(){ super(); this._buf = new Float32Array(4096); this._i = 0; }
      process(inputs) {
        const ch = inputs[0][0];
        if (!ch) return true;
        for (let n = 0; n < ch.length; n++) {
          this._buf[this._i++] = ch[n];
          if (this._i >= this._buf.length) {
            this.port.postMessage(this._buf.slice(0));
            this._i = 0;
          }
        }
        return true;
      }
    }
    registerProcessor('genie-tap', GenieTapProcessor);
  `], { type: "text/javascript" })));
  const src = ctx.createMediaStreamSource(localStream);
  const node = new AudioWorkletNode(ctx, 'genie-tap');
  node.port.onmessage = (e) => {
    const f32 = e.data;
    // Convert to Int16 PCM for a tighter wire.
    const i16 = new Int16Array(f32.length);
    for (let n = 0; n < f32.length; n++) {
      const v = Math.max(-1, Math.min(1, f32[n]));
      i16[n] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
    window.webkit.messageHandlers.audioFrames.postMessage(Array.from(i16));
  };
  src.connect(node);
}
// Call after `localStream` is created by getUserMedia. Guard against multiple installs.
if (typeof window._genieTapInstalled === 'undefined') {
  window._genieTapInstalled = true;
  // Defer until localStream exists; the existing code paths set it after getUserMedia resolves.
  const tryInstall = () => {
    if (typeof localStream !== 'undefined' && localStream) { genieInstallAudioTap(); }
    else { setTimeout(tryInstall, 250); }
  };
  tryInstall();
}
```

### CallWebView.swift — register the audioFrames handler

```swift
let controller = WKUserContentController()
controller.add(self, name: "audioFrames")  // existing handlers stay
// ...
extension CallWebView: WKScriptMessageHandler {
    func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "audioFrames",
              let arr = message.body as? [Int] else { return }
        var ints = arr.map { Int16(truncatingIfNeeded: $0) }
        let data = Data(bytes: &ints, count: ints.count * MemoryLayout<Int16>.size)
        SpeechManager.shared.appendPCM(data, sampleRate: 16_000)
    }
}
```

### SpeechManager.swift — add PCM overload

Extend the existing class (do not replace). Keep the old `startListening()` path for any non-call usage:

```swift
extension SpeechManager {
    static let shared = SpeechManager()

    func beginRecognitionFromWebView() {
        guard authorized, !isListening else { return }
        guard let recognizer = recognizer, recognizer.isAvailable else { return }
        recognizer.supportsOnDeviceRecognition = true

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.requiresOnDeviceRecognition = true   // privacy + no network latency
        self.recognitionRequest = request

        self.recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
            guard let self else { return }
            if let result {
                DispatchQueue.main.async {
                    self.transcribedText = result.bestTranscription.formattedString
                    self.scanForTrigger(text: result.bestTranscription.formattedString)
                }
            }
            if let error = error as NSError?, error.domain == "kAFAssistantErrorDomain", error.code == 1110 { return }
        }
        isListening = true
    }

    func appendPCM(_ data: Data, sampleRate: Double) {
        guard let request = recognitionRequest else { return }
        let frames = AVAudioFrameCount(data.count / MemoryLayout<Int16>.size)
        let format = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: sampleRate,
                                   channels: 1, interleaved: true)!
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames) else { return }
        buffer.frameLength = frames
        data.withUnsafeBytes { raw in
            memcpy(buffer.int16ChannelData![0], raw.baseAddress!, data.count)
        }
        request.append(buffer)
    }

    private func scanForTrigger(text: String) {
        guard UserDefaults.standard.bool(forKey: "genieVoiceTriggerEnabled") else { return }
        guard GenieKeywordMatcher.matches(text) else { return }
        // Debounce: don't re-fire within 8s.
        let now = Date()
        if let last = lastTriggerAt, now.timeIntervalSince(last) < 8 { return }
        lastTriggerAt = now

        let utterance = GenieKeywordMatcher.utteranceAfterTrigger(text)
        let last60s = String(text.suffix(2000))
        Task {
            let context: [String: Any] = [
                "callId": CallManager.shared.currentCallId ?? "",
                "participants": CallManager.shared.currentParticipants,
                "transcriptExcerpt": last60s,
            ]
            let session = try await JellyclawBridge.shared.dispatch(wish: utterance, context: context)
            CallGenieOverlay.shared.present(for: session)
        }
    }
}
```

### GenieKeywordMatcher.swift — fuzzy matcher

```swift
import Foundation

public enum GenieKeywordMatcher {
    private static let set: Set<String> = ["genie", "jeanie", "jeannie", "jinnie", "djinni", "jenny"]
    private static let regex = try! NSRegularExpression(
        pattern: #"\b(genie|jeanie|jeannie|jinnie|djinni|jenny)\b[\s,.!?:;]+(.+?)$"#,
        options: [.caseInsensitive]
    )

    public static func matches(_ text: String) -> Bool {
        return regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil
    }

    /// Returns the utterance following the trigger word.
    public static func utteranceAfterTrigger(_ text: String) -> String {
        let range = NSRange(text.startIndex..., in: text)
        guard let m = regex.firstMatch(in: text, range: range),
              let r = Range(m.range(at: 2), in: text) else { return text }
        return String(text[r])
    }
}
```

### CallGenieOverlay.swift — banner + expandable timeline

NSPanel subclass anchored to the call window, same design language (Obsidian & Gold: bg `#050505`, gold `#928466`, glass via `backdrop-blur` — on macOS map to `NSVisualEffectView` with `.hudWindow` material). Collapsible, persistent across the session.

```swift
import SwiftUI
import AppKit

final class CallGenieOverlay {
    static let shared = CallGenieOverlay()
    private var panel: NSPanel?

    @MainActor
    func present(for session: JellyclawBridge.Session) {
        if panel == nil { panel = makePanel() }
        panel?.contentViewController = NSHostingController(rootView:
            CallGenieBannerView(session: session, onCancel: { [weak self] in
                Task { try? await JellyclawBridge.shared.cancel(session: session) }
                self?.dismiss()
            })
        )
        panel?.orderFrontRegardless()
    }

    @MainActor
    func dismiss() { panel?.orderOut(nil); panel = nil }

    private func makePanel() -> NSPanel {
        let p = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 420, height: 80),
                        styleMask: [.nonactivatingPanel, .hudWindow],
                        backing: .buffered, defer: false)
        p.isFloatingPanel = true
        p.level = .floating
        p.backgroundColor = .clear
        p.isOpaque = false
        return p
    }
}

struct CallGenieBannerView: View {
    let session: JellyclawBridge.Session
    var onCancel: () -> Void
    @State private var expanded = false
    @State private var events: [AgentEvent] = []
    @State private var summary = "Genie is working…"
    @State private var cost: Double = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Circle().fill(Color(red: 146/255, green: 132/255, blue: 102/255)).frame(width: 8, height: 8)
                Text(summary).font(.system(size: 13, weight: .medium)).foregroundStyle(.white)
                Spacer()
                Text(String(format: "$%.3f", cost)).font(.caption).foregroundStyle(.white.opacity(0.6))
                Button(action: { withAnimation { expanded.toggle() } }) {
                    Image(systemName: expanded ? "chevron.up" : "chevron.down")
                }.buttonStyle(.plain)
                Button("Cancel", action: onCancel).buttonStyle(.plain).foregroundStyle(.red)
            }
            if expanded {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 4) {
                        ForEach(Array(events.enumerated()), id: \.offset) { _, ev in
                            GenieTimelineRow(event: ev)
                        }
                    }
                }.frame(maxHeight: 260)
            }
        }
        .padding(12)
        .background(Color.black.opacity(0.85))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color(red: 146/255, green: 132/255, blue: 102/255).opacity(0.4)))
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .task {
            for try await ev in JellyclawBridge.shared.events(for: session) {
                await MainActor.run {
                    events.append(ev)
                    if case let .costUpdated(c) = ev { cost = c.usd }
                    if case let .messagePartUpdated(p) = ev { summary = String(p.delta.prefix(60)) }
                    if case .sessionCompleted = ev { summary = "Done — tap to see" }
                }
            }
        }
    }
}
```

`GenieTimelineRow` renders each `AgentEvent` variant as a one-line row (tool name + icon, assistant delta, permission request with accept/deny buttons, etc.).

### PostCallSummaryView.swift

Shown as a sheet from `CallManager.endCall()` when `session.wishes.isEmpty == false`. Lists prompts, statuses, cost, and links (via `jellyclaw://wish/<id>`) back into the main app.

### SettingsView.swift — Genie tab

Add a TabView entry. Controls:

- Toggle: "Enable Genie voice trigger" (bound to `UserDefaults.standard.bool(forKey: "genieVoiceTriggerEnabled")`, default `false`).
- Toggle: "Show in-call banner when Genie runs" (default `true`).
- SecureField: OpenRouter key (writes through KeychainHelper).
- SecureField: Anthropic key.
- Button: "Reset Genie auth" (calls `KeychainHelper.rotateEngineToken()`, then `JellyclawBridge.shared.stop()` + `start()`).
- Link: "Open engine logs" (`~/Library/Logs/JellyClaw/engine.jsonl` in Finder).
- Label: "Audio is processed on-device. Never sent to the cloud." (true because `requiresOnDeviceRecognition = true`).

On first toggle of the voice-trigger switch, show an explicit confirmation dialog: "Jelly-Claw will listen for the word 'genie' whenever you are on a call. Audio stays on your Mac. Enable?"

### Per-call-mode wiring

- **1:1 call** (`CallWindow`): call `SpeechManager.shared.beginRecognitionFromWebView()` in `CallManager.startCall(...)` once the WebView's `audioFrames` handler has posted at least one frame. Stop in `endCall()`.
- **Group call** (`SfuRoomWindow` in `.video` mode): same, but the local stream may be one of many. v1 only listens to the local mic (your voice).
- **Voice room** (`SfuRoomWindow` in `.voice` mode): same pattern. Disable trigger if the user is a listener-only (no mic).

### Tests

`GenieKeywordMatcherTests.swift`:

```swift
final class GenieKeywordMatcherTests: XCTestCase {
    func testMatchesGenie() { XCTAssertTrue(GenieKeywordMatcher.matches("hey genie tell me a joke")) }
    func testMatchesJeanie() { XCTAssertTrue(GenieKeywordMatcher.matches("okay jeanie can you")) }
    func testNoMatchHygiene() { XCTAssertFalse(GenieKeywordMatcher.matches("talk about hygiene today")) }
    func testExtractsUtterance() {
        XCTAssertEqual(GenieKeywordMatcher.utteranceAfterTrigger("ok genie, book my flight"),
                       "book my flight")
    }
}
```

Integration test: feed a captured WAV of "hey genie book my flight" through `SpeechManager.appendPCM` in 4096-sample chunks, assert the trigger fires and a dispatch is made (mock `JellyclawBridge`).

### Verification

- [ ] Enable voice trigger in Settings. Confirm dialog fires.
- [ ] Start a 1:1 call. In Console.app see `SpeechManager: on-device recognition started`.
- [ ] Say "hey genie remind me to follow up tomorrow." Within <2s a banner appears at the top of the call window.
- [ ] Expand the banner. See tool events stream in. Cost counter increments.
- [ ] Session completes → banner morphs to "Done — tap to see"; tap → opens summary.
- [ ] End call → `PostCallSummaryView` sheet shows the wish.
- [ ] Disable voice trigger. Say "genie" again. No dispatch fires.

### Common pitfalls

- **`requiresOnDeviceRecognition` must be set BEFORE the first `recognitionTask` is started.** Setting after has no effect.
- **AudioWorklet module import via Blob URL fails under CSP** — if the call page uses strict CSP, inline the script via `AudioWorkletProcessor` source in a static file served from the same origin. `web/call/index.html` is loaded from `file://` or from `Resources/` so CSP is local — this works; just watch for it if the WebView is ever pointed at a remote HTTPS origin.
- **`SFSpeechRecognizer` first-use authorization dialog** — call `SFSpeechRecognizer.requestAuthorization` on app launch, not mid-call. `SpeechManager.init` already does this.
- **Banner pins above the WebView but intercepts clicks** — set `panel.ignoresMouseEvents = true` by default; flip to `false` only while expanded.
- **Trigger on your own echo** — if system audio is captured back into the mic (speakers loud, no echo cancellation), "genie" fires recursively. WebRTC already runs echo cancellation on `getUserMedia({audio: {echoCancellation: true}})`. Verify the call's constraints include it.
- **Debounce the trigger** — without it, "genie genie genie" fires three runs. The 8s window in `scanForTrigger` handles this.

### Why this matters

This is the user-visible feature. The bridge + binary bundling are plumbing; nobody sees them. What people see is a banner appearing on a live call when they said a word. Everything else in Phase 17 exists to make these ~400 lines of SwiftUI + ~40 lines of JS feel inevitable.

### Git commit

```bash
git -C /Users/gtrush/Downloads/jelly-claw add -A
git -C /Users/gtrush/Downloads/jelly-claw commit -m "feat(genie): in-call voice trigger + banner + post-call summary"
```

---

## Session closeout

Paste `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/COMPLETION-UPDATE-TEMPLATE.md`, substituting `<NN>` with `17`. Mark sub-prompt `17.03` complete. **Do not** mark Phase 17 ✅ — one prompt remains. Next: `prompts/phase-17/04-notarize-and-testflight.md`.
