# Phase 17 — Integration into jelly-claw Video-Calling App — Prompt 01: Reconcile the two engines

**When to run:** After Phase 16 (desktop polish) is ✅ in `COMPLETION-LOG.md`. Phase 17's first bite. No other Phase 17 prompt is unblocked until this one lands.
**Estimated duration:** 3–5 hours (mostly surgery + re-testing existing Genie flows, not new code)
**New session?** Yes
**Model:** Claude Opus 4.6 (1M context)

---

## Session startup

Paste the full contents of `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/STARTUP-TEMPLATE.md`, substituting `<NN>` with `17`. In addition to those files, also read **before writing any code**:

1. `/Users/gtrush/Downloads/jellyclaw-engine/integration/AUDIT.md` — the audit already catalogued the collision (§3, §9.1). Do not re-derive; cite.
2. `/Users/gtrush/Downloads/jellyclaw-engine/integration/JELLY-CLAW-APP-INTEGRATION.md` §6 — the reconciliation decision (standalone repo is canonical; in-tree becomes artifacts-only).
3. `/Users/gtrush/Downloads/jellyclaw-engine/integration/BRIDGE-DESIGN.md` §3.2 — the target bundle path (`Contents/Resources/jellyclaw-engine/jellyclaw`).
4. `/Users/gtrush/Downloads/jelly-claw/engine/INTEGRATION.md` and `/Users/gtrush/Downloads/jelly-claw/engine/SPEC.md` — the **legacy in-tree spec** that we are about to retire. Before deleting, confirm every guarantee it names is either covered by `/Users/gtrush/Downloads/jellyclaw-engine/engine/SPEC.md §21` or filed as a follow-up task in `STATUS.md`.
5. `/Users/gtrush/Downloads/jelly-claw/JellyGenieKit/Sources/JellyGenieKit/GenieManager.swift` — specifically the `bundledServerURL` wiring at ~line 55 of `JellyClawApp.swift` and the hard-coded `webhookBase = "http://127.0.0.1:7778"` inside `GenieManager`. These two lines are where the swap happens.
6. `/Users/gtrush/Downloads/jelly-claw/Jelly-Claw.xcodeproj/project.pbxproj` — skim, identify the Copy-Files Build Phase that currently ships `genie-server/` into `Contents/Resources/`. That's the phase we are editing.

## Research task

Before any diff:

- Run `ls -la /Users/gtrush/Downloads/jelly-claw/engine/` and capture the file list. Note the presence of `opencode/` and `opencode-anomaly/` submodule directories — those are the **legacy source trees** and they must not ship inside the jelly-claw app.
- Run `grep -rn "127.0.0.1:7778" /Users/gtrush/Downloads/jelly-claw/JellyGenieKit/ /Users/gtrush/Downloads/jelly-claw/Jelly-Claw/` to enumerate every hardcoded-port reference. Expect: `GenieManager.webhookBase`, possibly `GenieServerMonitor` health probe, possibly dev docs.
- Run `grep -rn "genie-server" /Users/gtrush/Downloads/jelly-claw/` to enumerate every reference to the bundled Node dir. Audit the hits: `GenieManager.bundledServerURL`, the Xcode Copy-Files phase, any README.
- Verify the canonical engine can be built: `cd /Users/gtrush/Downloads/jellyclaw-engine && bun install && bun run build`. Expect `dist/cli.js` (and/or a compiled binary if Phase 10 has landed). Capture the binary path.

## Implementation task

**Goal.** After this prompt, the jelly-claw Xcode project no longer contains a source tree for the engine. It contains only a tiny `engine-artifacts/` directory holding the most recent compiled jellyclaw binary (copied from the canonical repo by a build script), plus a `README.md` that points at `/Users/gtrush/Downloads/jellyclaw-engine/`. The app still launches and still runs the legacy SSE-over-7778 flow, because the compiled jellyclaw binary still answers `/status`, `/dispatches`, `/events` on whatever port it announces — the actual port-discovery and auth-token changes land in Prompt 02. **This prompt is a pure refactor.**

### Files to create

- `/Users/gtrush/Downloads/jelly-claw/engine-artifacts/README.md` — one-screen doc: "This directory holds built artifacts only. Source lives at `/Users/gtrush/Downloads/jellyclaw-engine/`. Rebuild with `../scripts/build-engine.sh`. Do not edit files here by hand."
- `/Users/gtrush/Downloads/jelly-claw/scripts/build-engine.sh` — shell script that (a) `cd`s into the canonical repo, (b) runs the engine build, (c) copies the compiled binary into `engine-artifacts/`, (d) writes a `VERSION` file with `git rev-parse --short HEAD` of the canonical repo. See below for the exact script.

### Files to modify

- `/Users/gtrush/Downloads/jelly-claw/Jelly-Claw/JellyClawApp.swift` — update `GenieManager.bundledServerURL` to point at the new path (`Contents/Resources/jellyclaw-engine/` instead of `Contents/Resources/genie-server/`).
- `/Users/gtrush/Downloads/jelly-claw/JellyGenieKit/Sources/JellyGenieKit/GenieManager.swift` — keep `webhookBase` as a stored property but stop hardcoding `:7778`. Read the port from a small `JellyclawPort.current()` helper that will be implemented in Prompt 02. For now, fall back to 7778 if the helper returns nil, so we stay shippable between prompts.
- `/Users/gtrush/Downloads/jelly-claw/Jelly-Claw.xcodeproj/project.pbxproj` — edit the Copy-Files phase. Remove the `genie-server/` source reference. Add an `engine-artifacts/` → `Contents/Resources/jellyclaw-engine/` copy. Tick "Code Sign On Copy". See Xcode GUI walkthrough below.

### Files to delete

- `/Users/gtrush/Downloads/jelly-claw/engine/opencode/` (submodule dir — legacy source)
- `/Users/gtrush/Downloads/jelly-claw/engine/opencode-anomaly/` (legacy source)
- `/Users/gtrush/Downloads/jelly-claw/engine/INTEGRATION.md` (superseded by `/Users/gtrush/Downloads/jellyclaw-engine/integration/JELLY-CLAW-APP-INTEGRATION.md`)
- `/Users/gtrush/Downloads/jelly-claw/engine/SPEC.md` (superseded by `/Users/gtrush/Downloads/jellyclaw-engine/engine/SPEC.md`)
- `/Users/gtrush/Downloads/jelly-claw/engine/TESTING.md` — fold any unique rows into `/Users/gtrush/Downloads/jellyclaw-engine/test/TESTING.md` first, then delete.

### Do NOT delete (yet)

- `/Users/gtrush/Downloads/jelly-claw/genie-server/` — the legacy Node bundle that `JellyGenieKit` still talks to on port 7778. This directory stays shipping until Prompt 02 swaps the binary. The two copy-files phases can coexist temporarily — Prompt 02 removes the legacy one behind a `USE_LEGACY_GENIE_SERVER=1` build flag.

### Prerequisites check

Before editing:

- [ ] Canonical repo builds: `cd /Users/gtrush/Downloads/jellyclaw-engine && bun run build` exits 0.
- [ ] Canonical binary runs: `./dist/cli.js --version` prints the version string.
- [ ] The legacy bundled server still starts: open `/Users/gtrush/Downloads/jelly-claw/` in Xcode, Product → Run, popover opens, `GenieManager.serverStatus` reads `running` within 5 seconds. If this is red before your changes, STOP and fix separately — you do not want to conflate reconciliation regressions with pre-existing breakage.
- [ ] Clean working trees on both repos: `git -C /Users/gtrush/Downloads/jellyclaw-engine status` and `git -C /Users/gtrush/Downloads/jelly-claw status` both clean.

### Step-by-step implementation

1. **Stand up the artifacts directory.** Create `engine-artifacts/` in the jelly-claw repo root (not inside the Xcode target yet). Add a `.gitkeep`. Author the `README.md` (content above).

2. **Author `scripts/build-engine.sh`.** This is the only thing that writes into `engine-artifacts/`:

```bash
#!/usr/bin/env bash
set -euo pipefail

JELLY_CLAW_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CANONICAL="${JELLYCLAW_ENGINE_ROOT:-/Users/gtrush/Downloads/jellyclaw-engine}"
ARTIFACTS="$JELLY_CLAW_ROOT/engine-artifacts"

if [[ ! -d "$CANONICAL" ]]; then
  echo "ERROR: canonical engine not found at $CANONICAL" >&2
  echo "Set JELLYCLAW_ENGINE_ROOT or symlink the repo." >&2
  exit 1
fi

echo "→ building canonical engine at $CANONICAL"
cd "$CANONICAL"
bun install --frozen-lockfile
bun run build

# Post-Phase-10 there's a single-file compiled binary. Prefer that; fall back
# to the Node CLI for pre-10 states.
if [[ -f "$CANONICAL/dist/jellyclaw" ]]; then
  BIN="$CANONICAL/dist/jellyclaw"
elif [[ -f "$CANONICAL/dist/cli.js" ]]; then
  BIN="$CANONICAL/dist/cli.js"
else
  echo "ERROR: no built artifact found in $CANONICAL/dist/" >&2
  exit 1
fi

mkdir -p "$ARTIFACTS"
cp "$BIN" "$ARTIFACTS/jellyclaw"
chmod +x "$ARTIFACTS/jellyclaw"
( cd "$CANONICAL" && git rev-parse --short HEAD ) > "$ARTIFACTS/VERSION"
date -u +"%Y-%m-%dT%H:%M:%SZ" >> "$ARTIFACTS/VERSION"

echo "→ artifacts refreshed:"
ls -l "$ARTIFACTS/"
```

Make it executable: `chmod +x /Users/gtrush/Downloads/jelly-claw/scripts/build-engine.sh`.

3. **Run the script once.** Confirm `engine-artifacts/jellyclaw` and `engine-artifacts/VERSION` exist. The binary is either the single-file compiled Mach-O (preferred) or the Node CLI bundle (fallback).

4. **Xcode GUI walkthrough — add the new Copy-Files phase.**
   - Open `/Users/gtrush/Downloads/jelly-claw/Jelly-Claw.xcodeproj` in Xcode.
   - In the Project Navigator (left sidebar), click the project root, then select the `Jelly-Claw` target.
   - Open the **Build Phases** tab.
   - Click the `+` in the top-left of the Build Phases editor → **New Copy Files Phase**.
   - Rename it to `Copy jellyclaw engine artifacts`.
   - Set **Destination** to `Resources`.
   - Set **Subpath** to `jellyclaw-engine`.
   - Tick **Copy only when installing: OFF** (we want every build to get it).
   - Drag `engine-artifacts/jellyclaw` (and `VERSION`) from Finder into the phase's file list.
   - For the `jellyclaw` entry, tick **Code Sign On Copy** — this is load-bearing for Prompt 04's notarization story.
   - Apple's reference: https://developer.apple.com/documentation/xcode/embedding-nonstandard-executables-in-a-macos-app — specifically the "Embedding an executable" and "Signing embedded executables" sections.

5. **Xcode GUI walkthrough — leave the legacy Copy-Files phase in place.** Find the existing `Copy genie-server` Copy-Files phase. Do not touch it in this prompt. Prompt 02 gates it behind a build flag and then deletes it.

6. **Edit `JellyClawApp.swift`.** Replace the `genie-server` lookup at the top of `applicationDidFinishLaunching` with a two-tier lookup that prefers the new artifacts and falls back to the legacy bundle:

```swift
if let newURL = Bundle.main.url(forResource: "jellyclaw-engine", withExtension: nil) {
    GenieManager.bundledEngineURL = newURL
} else if let legacyURL = Bundle.main.url(forResource: "genie-server", withExtension: nil) {
    GenieManager.bundledServerURL = legacyURL   // back-compat; Prompt 02 removes
}
```

Add a corresponding `public static var bundledEngineURL: URL?` to `GenieManager.swift` next to the existing `bundledServerURL`. The manager itself does not need to change semantics — the actual binary spawn moves to `EngineSupervisor` in Prompt 02.

7. **Edit `GenieManager.swift` — port discovery stub.** Locate `private let webhookBase = "http://127.0.0.1:7778"`. Replace with:

```swift
private var webhookBase: String {
    // Post-Prompt-02, `JellyclawPort.current()` returns the OS-picked port
    // announced by the new engine via its --announce-port-file. Until that
    // lands we keep the legacy constant so the bundled Node server keeps working.
    if let port = JellyclawPort.current(), port > 0 {
        return "http://127.0.0.1:\(port)"
    }
    return "http://127.0.0.1:7778"
}
```

Add a stub `JellyclawPort.swift` in `JellyGenieKit/Sources/JellyGenieKit/`:

```swift
import Foundation

public enum JellyclawPort {
    /// Reads the port announced by the engine via its port-file.
    /// Returns nil until Prompt 02 wires the announce-file writer.
    public static func current() -> Int? {
        let portFile = FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("JellyClaw/engine.port")
        guard let s = try? String(contentsOf: portFile, encoding: .utf8),
              let n = Int(s.trimmingCharacters(in: .whitespacesAndNewlines)),
              n > 0 else { return nil }
        return n
    }
}
```

8. **Delete the legacy in-tree engine source trees.**

```bash
cd /Users/gtrush/Downloads/jelly-claw
# Save any uniquely valuable content from engine/{INTEGRATION,SPEC,TESTING}.md
# into STATUS.md of the canonical repo first — diff each against its canonical
# sibling and cherry-pick lines that aren't yet covered.
git rm -r engine/opencode engine/opencode-anomaly
git rm engine/INTEGRATION.md engine/SPEC.md engine/TESTING.md
rmdir engine || true   # leave the directory deleted; the new home is engine-artifacts/
```

9. **Build + smoke test.**
   - `cd /Users/gtrush/Downloads/jelly-claw && xcodebuild -scheme Jelly-Claw -configuration Debug build` — must exit 0.
   - Inspect the built `.app`: `ls "$(xcodebuild -showBuildSettings -scheme Jelly-Claw | awk -F'= ' '/ TARGET_BUILD_DIR /{print $2}')/Jelly-Claw.app/Contents/Resources/"` — expect both `genie-server/` (legacy, temporary) and `jellyclaw-engine/` (new). The new dir must contain the signed `jellyclaw` binary and a `VERSION` file.
   - Launch from Xcode. The legacy Node server still runs on 7778 (nothing has changed there). `GenieManager.serverStatus` should still read `running`.
   - Check `Console.app` filtered on process `Jelly-Claw` — no new warnings.

### Xcode GUI walkthrough — where the GUI is the only path

- **Copy-Files phase creation:** no command-line path exists for editing `project.pbxproj` sanely. Always use the Xcode GUI as described in step 4. Do not hand-edit the pbxproj.
- **Code Sign On Copy:** the checkbox in the Copy-Files phase's file-list row. If missed, `spctl -a -t exec` fails on the child binary in Prompt 04.
- **Scheme → Run → Arguments → Environment Variables:** add `JELLYCLAW_ENGINE_ROOT=/Users/gtrush/Downloads/jellyclaw-engine` so developer machines can rebuild artifacts without exporting to their shell.

### Tests to add

- `/Users/gtrush/Downloads/jelly-claw/Jelly-ClawTests/EngineArtifactsTests.swift` — a single XCTest that asserts the compiled `.app` bundle contains `Contents/Resources/jellyclaw-engine/jellyclaw` and that the binary has executable bit set. Guard with `#if canImport(XCTest)`.
- Add a row to `/Users/gtrush/Downloads/jelly-claw/TESTING.md`: "After `scripts/build-engine.sh`, `engine-artifacts/VERSION` matches `git -C $JELLYCLAW_ENGINE_ROOT rev-parse --short HEAD`."

### Verification

- [ ] `cd /Users/gtrush/Downloads/jelly-claw && xcodebuild -scheme Jelly-Claw build` succeeds.
- [ ] `<App>.app/Contents/Resources/jellyclaw-engine/jellyclaw` exists and is executable.
- [ ] `<App>.app/Contents/Resources/jellyclaw-engine/VERSION` exists.
- [ ] Launching the app still shows Genie as `running` (legacy path unchanged).
- [ ] `git -C /Users/gtrush/Downloads/jelly-claw status` shows the deletions under `engine/` and the new artifacts/scripts.

### Common pitfalls

- **Don't delete `genie-server/` in this prompt.** That's Prompt 02's job, gated behind a flag. Delete here and you lose your fallback.
- **Don't edit `project.pbxproj` in a text editor.** Xcode owns that file. Hand-edits produce merge-unfriendly blame and silent corruption.
- **Artifacts directory must not be checked in as a large binary.** Add `engine-artifacts/jellyclaw` to `.gitignore`; keep only `README.md`, `VERSION`, and `.gitkeep` in the index. CI and developer machines regenerate the binary on build.

### Why this matters

The audit (`AUDIT.md §3`) found two engines that are literally the same lineage — OpenCode-derived — fighting over the name "jelly-claw." Every minute spent living with both is a minute where a fix on one drifts from the other. This prompt collapses the two into one canonical source + one artifact pipeline, which is the precondition for everything else in Phase 17. The integration doc's §6 commits to "standalone is canonical"; this prompt makes that commit real on disk.

### Git commit

```bash
git -C /Users/gtrush/Downloads/jelly-claw add -A
git -C /Users/gtrush/Downloads/jelly-claw commit -m "chore: reconcile jellyclaw engines — in-tree is now artifacts-only, canonical at ../jellyclaw-engine"
```

### Rollback

If the Xcode build breaks and the cause isn't obvious within 30 minutes: `git -C /Users/gtrush/Downloads/jelly-claw revert HEAD`. The legacy `genie-server/` path is preserved precisely so rollback is a single revert away. File an issue in `STATUS.md` of the canonical repo describing the breakage before re-attempting.

---

## Session closeout

Paste `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/COMPLETION-UPDATE-TEMPLATE.md`, substituting `<NN>` with `17`. Mark sub-prompt `17.01` complete. **Do not** mark Phase 17 ✅ — three prompts remain. Next prompt to run in a new session: `prompts/phase-17/02-swift-bridge-and-bundling.md`.
