# Phase 17 — Integration into jelly-claw Video-Calling App — Prompt 02: Swift bridge, universal binary, Keychain, entitlements

**When to run:** After Prompt 01 (`17.01-reconcile-two-engines.md`) is committed and the jelly-claw app still builds and the legacy Genie flow is unchanged. Do not start until the build is green.
**Estimated duration:** 8–10 hours (most of that is Xcode plumbing + wiring XCTest, not writing code)
**New session?** Yes
**Model:** Claude Opus 4.6 (1M context)

---

## Session startup

Paste `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/STARTUP-TEMPLATE.md`, substituting `<NN>` with `17`. Also read **before writing any code**:

1. `/Users/gtrush/Downloads/jellyclaw-engine/integration/BRIDGE-DESIGN.md` end-to-end (entire file, not just §2). This is the contract. Disagreements become doc edits first, code second.
2. `/Users/gtrush/Downloads/jellyclaw-engine/integration/AUDIT.md` §6, §8 — existing entitlements and the Swift endpoints that must still work.
3. `/Users/gtrush/Downloads/jellyclaw-engine/engine/SPEC.md` §21 — the `serve` subcommand contract, `--bind/--port/--announce-port-file/--auth-token-env/--parent-pid` flags.
4. `/Users/gtrush/Downloads/jelly-claw/JellyGenieKit/Sources/JellyGenieKit/SSEParser.swift` and `/Users/gtrush/Downloads/jelly-claw/JellyGenieKit/Sources/JellyGenieKit/GenieManager.swift` — production-grade SSE parser + manager. Reuse, do not rewrite.
5. `/Users/gtrush/Downloads/jelly-claw/Jelly-Claw/KeychainHelper.swift` — existing wrapper. Extend, don't replace.
6. Apple docs (use WebFetch):
   - Process class: https://developer.apple.com/documentation/foundation/process
   - Keychain services: https://developer.apple.com/documentation/security/keychain_services
   - Hardened Runtime: https://developer.apple.com/documentation/security/hardened_runtime
   - Embedding executables: https://developer.apple.com/documentation/xcode/embedding-nonstandard-executables-in-a-macos-app
7. Bun compile docs: https://bun.sh/docs/bundler/executables — specifically `--compile --target=bun-darwin-arm64/x64`.

## Research task

- `grep -n "webhookBase" /Users/gtrush/Downloads/jelly-claw/JellyGenieKit/Sources/JellyGenieKit/GenieManager.swift` — enumerate every request site that currently targets `127.0.0.1:7778`. Each becomes `127.0.0.1:<EngineSupervisor.shared.port>` after this prompt.
- Confirm the canonical engine implements `--announce-port-file`. If missing, open `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/cli/serve.ts` and add it before wiring Swift — the Swift handshake depends on it (BRIDGE-DESIGN §4.2).
- Confirm `GET /healthz` exists on the canonical engine and responds with `{ ok, version, pid, port, startedAt }` without requiring a bearer token. The monitor probes this endpoint on a loop and must not churn on Keychain.

## Implementation task

**Goal.** After this prompt, the jelly-claw app spawns the canonical compiled `jellyclaw` binary at launch, reads its announced port, authenticates every HTTP request with a Keychain-stored bearer token, consumes the engine's SSE stream through the existing `SSEParser`, and decodes every event into a strongly-typed `AgentEvent` enum. The legacy `genie-server/` Copy-Files phase is gated behind a `USE_LEGACY_GENIE_SERVER=1` build flag and is **not shipped** in Release builds. XCTest covers bridge startup, port handshake, a round-trip dispatch, and clean shutdown.

### Files to create

- `/Users/gtrush/Downloads/jelly-claw/JellyGenieKit/Sources/JellyGenieKit/JellyclawBridge.swift` — the singleton actor that owns the Process and the public API.
- `/Users/gtrush/Downloads/jelly-claw/JellyGenieKit/Sources/JellyGenieKit/AgentEvent.swift` — the Codable event union matching the TS `AgentEvent` type.
- `/Users/gtrush/Downloads/jelly-claw/JellyGenieKit/Sources/JellyGenieKit/EngineSSEClient.swift` — the URLSession delegate that streams SSE bytes through `SSEParser` into `AgentEvent`.
- `/Users/gtrush/Downloads/jelly-claw/Engine.entitlements` — the separate entitlements file for the embedded binary (JIT allowed).
- `/Users/gtrush/Downloads/jelly-claw/scripts/build-engine.sh` — overwrite Prompt 01's placeholder with the full universal-binary pipeline (see below).
- `/Users/gtrush/Downloads/jelly-claw/scripts/sign-embedded-engine.sh` — called from an Xcode Run Script Build Phase to sign the bundled binary **before** the parent `.app` is signed.
- `/Users/gtrush/Downloads/jelly-claw/JellyGenieKit/Tests/JellyGenieKitTests/JellyclawBridgeTests.swift` — XCTest suite.

### Files to modify

- `/Users/gtrush/Downloads/jelly-claw/Jelly-Claw/KeychainHelper.swift` — add `engineAuthToken()`, `openrouterKey()`, `anthropicKey()` accessors. Service name: `com.jelly-claw.engine.auth`, `com.jelly-claw.openrouter.key`, `com.jelly-claw.anthropic.key`.
- `/Users/gtrush/Downloads/jelly-claw/JellyGenieKit/Sources/JellyGenieKit/GenieManager.swift` — replace hardcoded `webhookBase`, add the `Authorization: Bearer <token>` header to every URLRequest.
- `/Users/gtrush/Downloads/jelly-claw/Jelly-Claw/JellyClawApp.swift` — in `applicationDidFinishLaunching`, call `JellyclawBridge.shared.start()` before wiring `GenieManager`. In `applicationWillTerminate`, call `JellyclawBridge.shared.stop()`.
- `/Users/gtrush/Downloads/jelly-claw/Jelly-Claw.xcodeproj/project.pbxproj` — via the Xcode GUI, add the Run Script phase that signs the embedded binary; gate the legacy `genie-server` Copy-Files phase behind `USE_LEGACY_GENIE_SERVER`.

### Prerequisites check

- [ ] Prompt 01's commit is on `HEAD` of `/Users/gtrush/Downloads/jelly-claw`.
- [ ] `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/cli/serve.ts` implements `--announce-port-file`, `--parent-pid`, and `GET /healthz`. If not, patch the engine first.
- [ ] `security find-identity -v -p codesigning` lists a `Developer ID Application` certificate. If not, Prompt 04's notarization will fail anyway — stop and set this up.

### Step-by-step implementation

#### 1. Universal binary build pipeline

Overwrite `/Users/gtrush/Downloads/jelly-claw/scripts/build-engine.sh` with the full pipeline:

```bash
#!/usr/bin/env bash
set -euo pipefail
JELLY_CLAW_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CANONICAL="${JELLYCLAW_ENGINE_ROOT:-/Users/gtrush/Downloads/jellyclaw-engine}"
ARTIFACTS="$JELLY_CLAW_ROOT/engine-artifacts"
BUILD="$CANONICAL/build"

mkdir -p "$BUILD" "$ARTIFACTS"
cd "$CANONICAL"
bun install --frozen-lockfile

echo "→ compile arm64"
bun build --compile --minify --sourcemap \
  --target=bun-darwin-arm64 \
  --outfile "$BUILD/jellyclaw-arm64" \
  engine/src/cli.ts

echo "→ compile x86_64"
bun build --compile --minify --sourcemap \
  --target=bun-darwin-x64 \
  --outfile "$BUILD/jellyclaw-x64" \
  engine/src/cli.ts

echo "→ lipo → universal"
lipo -create \
  "$BUILD/jellyclaw-arm64" \
  "$BUILD/jellyclaw-x64" \
  -output "$ARTIFACTS/jellyclaw"
chmod +x "$ARTIFACTS/jellyclaw"

file "$ARTIFACTS/jellyclaw"
( cd "$CANONICAL" && git rev-parse --short HEAD ) > "$ARTIFACTS/VERSION"
date -u +"%Y-%m-%dT%H:%M:%SZ" >> "$ARTIFACTS/VERSION"
echo "→ done. Artifacts: $ARTIFACTS"
```

Run it once. Expect `file $ARTIFACTS/jellyclaw` to report `Mach-O universal binary with 2 architectures: [x86_64] [arm64]`.

#### 2. Entitlements

Create `/Users/gtrush/Downloads/jelly-claw/Engine.entitlements`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
  <key>com.apple.security.cs.disable-library-validation</key><true/>
</dict>
</plist>
```

These three are mandatory for Bun `--compile` binaries at runtime under Hardened Runtime. Without them the child crashes at launch with `EXC_BAD_ACCESS (Code Signature Invalid)` (see https://developer.apple.com/documentation/security/hardened_runtime).

#### 3. Embedded-binary signing script

Create `/Users/gtrush/Downloads/jelly-claw/scripts/sign-embedded-engine.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
: "${CODE_SIGN_IDENTITY:?Xcode should export this}"
: "${TARGET_BUILD_DIR:?Xcode should export this}"
: "${FULL_PRODUCT_NAME:?Xcode should export this}"
: "${PROJECT_DIR:?Xcode should export this}"

BIN="$TARGET_BUILD_DIR/$FULL_PRODUCT_NAME/Contents/Resources/jellyclaw-engine/jellyclaw"
ENT="$PROJECT_DIR/Engine.entitlements"

if [[ ! -f "$BIN" ]]; then
  echo "→ no jellyclaw binary at $BIN (legacy-only build?), skipping"
  exit 0
fi

echo "→ signing embedded engine: $BIN"
codesign --force --options=runtime --timestamp \
  --entitlements "$ENT" \
  --sign "$CODE_SIGN_IDENTITY" \
  "$BIN"
codesign --verify --verbose=2 "$BIN"
```

Add this as a **Run Script Build Phase** in Xcode (GUI walkthrough below) — **placed BEFORE the phase that signs the parent app**. Xcode injects `CODE_SIGN_IDENTITY`, `TARGET_BUILD_DIR`, `FULL_PRODUCT_NAME`, and `PROJECT_DIR` automatically.

Signing order matters. Apple's hardened runtime cannot be deep-signed with custom per-binary entitlements — you must sign children first with their own entitlements, then sign the parent. If you do parent-first, the Run Script sign of the child invalidates the parent signature and notarization rejects.

#### 4. Keychain accessors

Extend `KeychainHelper.swift`:

```swift
extension KeychainHelper {
    static let engineAuthKey   = "dev.jellyclaw.engine.auth-token"
    static let openrouterKey   = "com.jelly-claw.openrouter.key"
    static let anthropicKey    = "com.jelly-claw.anthropic.key"

    static func ensureEngineAuthToken() -> String {
        if let existing = load(key: engineAuthKey), !existing.isEmpty { return existing }
        var bytes = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        let token = Data(bytes).base64EncodedString()
        save(key: engineAuthKey, value: token)
        return token
    }

    static func openrouter()     -> String? { load(key: openrouterKey) }
    static func anthropic()      -> String? { load(key: anthropicKey) }
    static func rotateEngineToken() { delete(key: engineAuthKey) }
}
```

#### 5. AgentEvent Codable

Create `AgentEvent.swift` — the polymorphic enum matching the engine's TS `AgentEvent` union. Use Swift's associated-value pattern with a custom `init(from:)` that reads the `type` discriminator:

```swift
import Foundation

public enum AgentEvent: Decodable, Sendable {
    case sessionStarted(SessionStarted)
    case messageStarted(MessageStarted)
    case messagePartUpdated(MessagePartUpdated)
    case messageCompleted(MessageCompleted)
    case toolCallStarted(ToolCall)
    case toolCallCompleted(ToolCallResult)
    case subagentStarted(SubagentStarted)
    case subagentCompleted(SubagentCompleted)
    case hookFired(HookFired)
    case permissionRequested(PermissionRequest)
    case permissionResolved(PermissionResolved)
    case costUpdated(CostUpdate)
    case sessionCompleted(SessionCompleted)
    case error(ErrorEvent)
    case keepalive(Keepalive)

    private enum CodingKeys: String, CodingKey { case type }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let type = try c.decode(String.self, forKey: .type)
        let single = try decoder.singleValueContainer()
        switch type {
        case "session.started":     self = .sessionStarted(try single.decode(SessionStarted.self))
        case "message.started":     self = .messageStarted(try single.decode(MessageStarted.self))
        case "message.part.updated":self = .messagePartUpdated(try single.decode(MessagePartUpdated.self))
        case "message.completed":   self = .messageCompleted(try single.decode(MessageCompleted.self))
        case "tool.call.start":     self = .toolCallStarted(try single.decode(ToolCall.self))
        case "tool.call.end":       self = .toolCallCompleted(try single.decode(ToolCallResult.self))
        case "subagent.started":    self = .subagentStarted(try single.decode(SubagentStarted.self))
        case "subagent.completed":  self = .subagentCompleted(try single.decode(SubagentCompleted.self))
        case "hook.fired":          self = .hookFired(try single.decode(HookFired.self))
        case "permission.requested":self = .permissionRequested(try single.decode(PermissionRequest.self))
        case "permission.resolved": self = .permissionResolved(try single.decode(PermissionResolved.self))
        case "cost.updated":        self = .costUpdated(try single.decode(CostUpdate.self))
        case "session.completed":   self = .sessionCompleted(try single.decode(SessionCompleted.self))
        case "error":               self = .error(try single.decode(ErrorEvent.self))
        case "keepalive":           self = .keepalive(try single.decode(Keepalive.self))
        default:
            throw DecodingError.dataCorruptedError(forKey: .type, in: c,
                debugDescription: "unknown AgentEvent type: \(type)")
        }
    }
}

public struct SessionStarted: Decodable, Sendable { public let type: String; public let sessionId: String; public let startedAt: Date }
public struct MessageStarted: Decodable, Sendable { public let type: String; public let messageId: String; public let role: String }
public struct MessagePartUpdated: Decodable, Sendable { public let type: String; public let messageId: String; public let partIndex: Int; public let delta: String }
public struct MessageCompleted: Decodable, Sendable { public let type: String; public let messageId: String }
public struct ToolCall: Decodable, Sendable { public let type: String; public let callId: String; public let tool: String; public let input: [String: JSONValue]? }
public struct ToolCallResult: Decodable, Sendable { public let type: String; public let callId: String; public let output: JSONValue?; public let error: String? }
public struct SubagentStarted: Decodable, Sendable { public let type: String; public let subagentId: String; public let name: String }
public struct SubagentCompleted: Decodable, Sendable { public let type: String; public let subagentId: String }
public struct HookFired: Decodable, Sendable { public let type: String; public let hook: String; public let tool: String? }
public struct PermissionRequest: Decodable, Sendable { public let type: String; public let requestId: String; public let tool: String; public let reason: String? }
public struct PermissionResolved: Decodable, Sendable { public let type: String; public let requestId: String; public let decision: String }
public struct CostUpdate: Decodable, Sendable { public let type: String; public let usd: Double; public let inputTokens: Int; public let outputTokens: Int }
public struct SessionCompleted: Decodable, Sendable { public let type: String; public let sessionId: String; public let usdTotal: Double }
public struct ErrorEvent: Decodable, Sendable { public let type: String; public let message: String; public let code: String? }
public struct Keepalive: Decodable, Sendable { public let type: String; public let ts: Double }

public enum JSONValue: Decodable, Sendable {
    case null; case bool(Bool); case number(Double); case string(String)
    case array([JSONValue]); case object([String: JSONValue])
    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null; return }
        if let v = try? c.decode(Bool.self)   { self = .bool(v); return }
        if let v = try? c.decode(Double.self) { self = .number(v); return }
        if let v = try? c.decode(String.self) { self = .string(v); return }
        if let v = try? c.decode([JSONValue].self) { self = .array(v); return }
        if let v = try? c.decode([String: JSONValue].self) { self = .object(v); return }
        throw DecodingError.dataCorruptedError(in: c, debugDescription: "JSON value")
    }
}
```

#### 6. JellyclawBridge singleton

Create `JellyclawBridge.swift`. Thread-safe via a serial `DispatchQueue`; public API is `async throws`:

```swift
import Foundation

public actor JellyclawBridge {
    public static let shared = JellyclawBridge()

    public enum State: Sendable { case idle, starting, running, crashed, stopped }
    public struct Session: Sendable { public let wishId: String; public let sessionId: String; public let pid: Int }

    public private(set) var state: State = .idle
    public private(set) var port: Int = 0
    public private(set) var authToken: String = ""
    private var process: Process?
    private var stdoutPipe: Pipe?

    private let stateDir: URL = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let dir = base.appendingPathComponent("JellyClaw")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }()
    private var portFile: URL { stateDir.appendingPathComponent("engine.port") }
    private var pidFile:  URL { stateDir.appendingPathComponent("engine.pid") }

    public func start(binary: URL) async throws {
        guard state == .idle || state == .stopped || state == .crashed else { return }
        state = .starting
        try? FileManager.default.removeItem(at: portFile)

        let token = KeychainHelper.ensureEngineAuthToken()
        self.authToken = token

        let p = Process()
        p.executableURL = binary
        p.arguments = [
            "serve",
            "--bind", "127.0.0.1",
            "--port", "0",
            "--auth-token-env", "JELLYCLAW_AUTH_TOKEN",
            "--event-format", "sse",
            "--announce-port-file", portFile.path,
            "--parent-pid", String(ProcessInfo.processInfo.processIdentifier),
            "--log-format", "jsonl",
            "--state-dir", stateDir.path,
        ]
        var env = ProcessInfo.processInfo.environment
        env["JELLYCLAW_AUTH_TOKEN"] = token
        if let k = KeychainHelper.openrouter() { env["OPENROUTER_API_KEY"] = k }
        if let k = KeychainHelper.anthropic() { env["ANTHROPIC_API_KEY"] = k }
        p.environment = env

        let out = Pipe()
        p.standardOutput = out
        p.standardError  = out
        self.stdoutPipe = out
        out.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let line = String(data: data, encoding: .utf8) else { return }
            Task { await self?.ingestStdout(line: line) }
        }

        p.terminationHandler = { [weak self] proc in
            Task { await self?.handleExit(code: proc.terminationStatus) }
        }

        try p.run()
        self.process = p
        try? String(p.processIdentifier).write(to: pidFile, atomically: true, encoding: .utf8)

        self.port = try await waitForPort(timeout: 10.0)
        state = .running
    }

    public func stop(graceSeconds: TimeInterval = 5.0) async {
        guard let p = process, p.isRunning else { state = .stopped; return }
        p.terminate()
        let deadline = Date().addingTimeInterval(graceSeconds)
        while p.isRunning && Date() < deadline { try? await Task.sleep(nanoseconds: 50_000_000) }
        if p.isRunning { kill(p.processIdentifier, SIGKILL) }
        state = .stopped
        try? FileManager.default.removeItem(at: pidFile)
    }

    public func dispatch(wish: String, context: [String: Any] = [:]) async throws -> Session {
        var req = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/v1/runs")!)
        req.httpMethod = "POST"
        req.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: [String: Any] = ["prompt": wish, "context": context]
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            throw BridgeError.dispatchFailed(String(data: data, encoding: .utf8) ?? "")
        }
        return try JSONDecoder().decode(Session.self, from: data)
    }

    public func cancel(session: Session) async throws {
        var req = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/v1/runs/\(session.wishId)/cancel")!)
        req.httpMethod = "POST"
        req.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
        _ = try await URLSession.shared.data(for: req)
    }

    public nonisolated func events(for session: JellyclawBridge.Session) -> AsyncThrowingStream<AgentEvent, Error> {
        return EngineSSEClient.stream(
            url: URL(string: "http://127.0.0.1:\(portSync)/events?session=\(session.sessionId)")!,
            token: authTokenSync
        )
    }

    private nonisolated var portSync: Int { get { 0 } } // fill in via actor-hop wrapper in production
    private nonisolated var authTokenSync: String { get { "" } }

    // Internal helpers
    private func ingestStdout(line: String) { /* append to ~/Library/Logs/JellyClaw/engine.jsonl */ }
    private func handleExit(code: Int32) { if state == .running { state = .crashed } }

    private func waitForPort(timeout: TimeInterval) async throws -> Int {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if let s = try? String(contentsOf: portFile, encoding: .utf8),
               let n = Int(s.trimmingCharacters(in: .whitespacesAndNewlines)), n > 0 {
                return n
            }
            try? await Task.sleep(nanoseconds: 25_000_000)
        }
        throw BridgeError.portHandshakeTimeout
    }
}

public enum BridgeError: Error { case portHandshakeTimeout, dispatchFailed(String) }
```

Note: the `nonisolated` port/token getters above are a sketch — the production version caches them in a synchronized storage (e.g. `os_unfair_lock`-protected struct) so the `events(for:)` AsyncThrowingStream can read them without re-entering the actor. Document this in the file header.

#### 7. Swift SSE client

Create `EngineSSEClient.swift`. Use `URLSession.bytes(for:)` (macOS 12+), feed each line through `SSEParser`, JSON-decode `data:` into `AgentEvent`:

```swift
import Foundation

enum EngineSSEClient {
    static func stream(url: URL, token: String) -> AsyncThrowingStream<AgentEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                var req = URLRequest(url: url)
                req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
                req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                let (bytes, _) = try await URLSession.shared.bytes(for: req)
                let parser = SSEParser()
                for try await line in bytes.lines {
                    if let record = parser.feed(line) {
                        if let data = record.data.data(using: .utf8),
                           let event = try? JSONDecoder().decode(AgentEvent.self, from: data) {
                            continuation.yield(event)
                        }
                    }
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}
```

Reuse the production-grade `SSEParser` from `JellyGenieKit`. Do not reinvent. The header comment in that file already explains its CRLF-tolerant, sticky-id, blank-line-flush semantics.

#### 8. App lifecycle wiring

In `JellyClawApp.swift`'s `applicationDidFinishLaunching`, after the `bundledEngineURL` lookup:

```swift
if let engineDir = GenieManager.bundledEngineURL {
    let binary = engineDir.appendingPathComponent("jellyclaw")
    Task {
        do { try await JellyclawBridge.shared.start(binary: binary) }
        catch { soulLog("engine start failed: \(error)") }
    }
}
```

Add `applicationWillTerminate`:

```swift
func applicationWillTerminate(_ notification: Notification) {
    let semaphore = DispatchSemaphore(value: 0)
    Task { await JellyclawBridge.shared.stop(); semaphore.signal() }
    _ = semaphore.wait(timeout: .now() + 6)
}
```

#### 9. Xcode GUI walkthrough

- **Engine.entitlements registration:** Do NOT assign `Engine.entitlements` to the app target. It is read only by the Run Script that signs the embedded binary. Drop the file into the project (Finder drag) so it is in `$PROJECT_DIR`, but do not add it to any target's Build Settings.
- **Run Script phase for signing:**
  - Project → Jelly-Claw target → Build Phases → `+` → New Run Script Phase.
  - Name it `Sign embedded jellyclaw engine`.
  - Drag this phase so it appears AFTER `Copy jellyclaw engine artifacts` and BEFORE any `[CP] Embed...` phases Xcode generates, and before the implicit parent-signing step (which is always last).
  - Script body: `"${PROJECT_DIR}/scripts/sign-embedded-engine.sh"`
  - Uncheck `Based on dependency analysis` so it always runs.
- **Legacy phase gating:** select `Copy genie-server` phase → in the build-phase editor there is no "build settings condition" field; instead move the phase's files into a per-configuration xcfilelist and reference it with `$(inherited) $(SRCROOT)/genie-server.xcfilelist` only when `USE_LEGACY_GENIE_SERVER=1`. Simpler: delete the phase entirely in a follow-up commit once Prompt 03 has shipped a release build that the team has dogfooded.

#### 10. Auth on every request

In `GenieManager.swift`, wrap `URLRequest` creation with:

```swift
private func authed(_ url: URL) -> URLRequest {
    var r = URLRequest(url: url)
    r.setValue("Bearer \(JellyclawBridge.shared.authTokenSync)", forHTTPHeaderField: "Authorization")
    return r
}
```

Replace every `URLRequest(url: ...)` with `authed(...)`. This applies to `/status`, `/dispatches`, `/events`, and the new `/v1/runs` paths.

### Tests to add

`JellyclawBridgeTests.swift`:

```swift
import XCTest
@testable import JellyGenieKit

final class JellyclawBridgeTests: XCTestCase {
    func testSpawnAndHealthz() async throws {
        let bin = productURL(named: "jellyclaw")
        try await JellyclawBridge.shared.start(binary: bin)
        let port = await JellyclawBridge.shared.port
        XCTAssertGreaterThan(port, 0)
        let (data, _) = try await URLSession.shared.data(from: URL(string: "http://127.0.0.1:\(port)/healthz")!)
        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        XCTAssertEqual(json?["ok"] as? Bool, true)
        await JellyclawBridge.shared.stop()
    }
    func testDispatchHelloWorld() async throws { /* ... */ }
    func testPortFileCleanupOnStop() async throws { /* ... */ }
}
```

### Verification

Launch the app from Xcode; tail Console.app filtered on `Jelly-Claw`:

- [ ] Line `jellyclaw: listening on http://127.0.0.1:<N>` appears within 2s.
- [ ] `curl -H "Authorization: Bearer <tok>" http://127.0.0.1:<N>/healthz` → 200 + JSON.
- [ ] Dispatching a trivial wish from a debug button streams events into `GenieManager.wishEvents`.
- [ ] Quit the app → child PID gone from `ps`.

### Common pitfalls

- **Signing order:** child first with `Engine.entitlements`, parent last. Reversed order fails notarization with "nested code has modified main executable."
- **Don't put JIT entitlements on the parent app** — the parent doesn't need them and Apple reviews them harder than necessary.
- **Don't ship `Engine.entitlements` inside the `.app`.** It lives at the project root; codesign reads it at build time.
- **`readabilityHandler` is called off-thread** — Swift will crash if you touch actor-isolated state from it synchronously. Wrap in a `Task`.
- **Port-0 with announce-file is fundamentally a TOCTOU:** the file is written after `Bun.serve` binds. Don't read the file before a 25ms poll; don't poll past 10s — if it's not there, the engine crashed and you should surface the error.

### Why this matters

The bridge is the whole product. Every SwiftUI surface in Prompt 03 talks through it; every notarized release in Prompt 04 ships it. Get the signing order wrong and Gatekeeper rejects every subsequent build. Get the port handshake wrong and the monitor churns. Get the auth wrong and any local process on the machine can drive the engine. This prompt is where the Phase 17 story either works end-to-end or quietly rots.

### Git commit

```bash
git -C /Users/gtrush/Downloads/jelly-claw add -A
git -C /Users/gtrush/Downloads/jelly-claw commit -m "feat(engine): swift bridge + universal-binary bundling + keychain auth"
```

---

## Session closeout

Paste `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/COMPLETION-UPDATE-TEMPLATE.md`, substituting `<NN>` with `17`. Mark sub-prompt `17.02` complete. **Do not** mark Phase 17 ✅ — two prompts remain. Next: `prompts/phase-17/03-voice-trigger-and-ui.md`.
