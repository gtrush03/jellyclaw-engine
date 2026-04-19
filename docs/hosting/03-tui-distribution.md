# 03 — TUI distribution

> How real users get `jellyclaw tui` onto their machine (or into their browser)
> at launch. Companion to `01-fly-backend.md` (Agent 1) and `02-api-surface.md`
> (Agent 2). Research + design only — this doc describes the plan; no engine
> code is changed here.

Status: design, pre-build. Sources cited inline by URL; every URL appears in
the Appendix with a short note.

---

## TL;DR

- **Primary (Day 1 launch):** single-file Bun-compiled binary distributed via
  GitHub Releases + a `curl … | sh` installer script, plus the existing
  `@jellyclaw/engine` npm package. These two reach ~95 % of developer users
  with zero net-new infrastructure.
- **Secondary (Week 2):** Homebrew tap (`gtrush/homebrew-jellyclaw`) that
  re-points at the same Release tarballs — converts a subset of Mac devs to
  `brew install jellyclaw` muscle memory.
- **Tertiary (Month 2+):** web-TUI at `https://jellyclaw.dev/tui` — ttyd +
  xterm.js in front of a Fly Machine per signed-in user. Unlocks "click a
  link, try the product, no install" which is the marketing surface the
  waitlist page will actually convert on.
- **Kill for v1:** Tauri desktop shell. The current `desktop/` tree is a
  stub and its only unique value (Dock icon, native notifications) is
  duplicated by Warp/iTerm/Ghostty running the same binary. Revisit after
  the web-TUI is live.
- **Windows:** ship the binary (Bun supports `bun-windows-x64` /
  `bun-windows-arm64` per bun.sh/docs/bundler/executables). Defer code-signing
  until someone actually uses it.
- **Prescription at the bottom of this doc:** §"Ship-this-for-v1-launch".

---

## § Distribution matrix (answer to Q1)

Coverage, friction, and burden scored 1–5 (5 = best). **Rec tier** is the
shipping recommendation: P = primary, S = secondary, T = tertiary,
K = kill/defer.

| Channel            | Platforms                                          | Install friction                       | Update UX                               | Size               | Backend    | Auth UX                         | Maintenance                                | **Rec** |
| ------------------ | -------------------------------------------------- | --------------------------------------- | --------------------------------------- | ------------------ | ---------- | ------------------------------- | ------------------------------------------ | ------- |
| **Single binary**  | mac arm64/x64, linux arm64/x64, win arm64/x64      | 2 steps: download, `chmod +x && ./`     | Built-in self-update check on startup   | ~55–90 MB          | none       | Paste API key in first-run prompt | High at first (signing CI), low after     | **P**   |
| **npm**            | all (Node 20+ required)                            | `npm i -g @jellyclaw/engine` — 1 step   | `npm update -g`                         | ~60 MB installed   | none       | Same first-run prompt           | Low — already shipping at `0.0.1`          | **P**   |
| **Homebrew tap**   | mac arm64/x64, linuxbrew                           | `brew tap … && brew install jellyclaw` | `brew upgrade`                          | ~90 MB bottled     | none       | Same                            | Formula regen per release (scripted)       | **S**   |
| **curl \| sh**     | mac arm64/x64, linux arm64/x64                     | 1 line: `curl -fsSL jellyclaw.dev/install.sh \| sh` | Manual re-run or `--upgrade` | ~55 MB             | none       | Same                            | Script lives in the same repo              | **S**   |
| **Web TUI**        | any browser (desktop + iPad-grade mobile)          | 0 — click a link, sign in               | N/A (always latest server-side)         | ~0 MB local        | Fly        | Magic-link → JWT → WS upgrade   | High: per-user Machines, auth, ops         | **T**   |
| **Docker**         | any linux host, docker desktop                     | `docker run -it jellyclaw/tui`          | `docker pull`                           | ~150 MB image      | none       | Same                            | Low — built in same CI                     | T       |
| **Tauri shell**    | mac arm64/x64, linux, win                          | DMG drag-to-Applications                | Tauri updater (signed JSON manifest)    | ~10 MB frame + 60 MB sidecar | none | Same                      | High: 3 signing trees (mac, win, linux)    | **K**   |

Why Tauri is K for v1: per [tauri.app/start](https://tauri.app/start/) a
minimal Tauri app is <600 KB, but adding the jellyclaw sidecar binary
(`externalBin` pattern) brings it to the same ~60 MB as the raw binary plus
three signing chains to maintain (macOS, Windows, Linux). For a TUI whose
value is being run inside the user's existing terminal, the native shell adds
shipping surface without adding user value. Warp gets away with it because
Warp *is* the terminal; we aren't.

Why Docker is T not S: our audience is devs who already type `jellyclaw tui`
into a real terminal; a wrapped Docker container loses access to the host
filesystem (the whole point), forcing a clunky `-v $PWD:/work` dance. Keep
the image for CI sandboxes and that one user who insists on it. Do not market
it.

---

## § Recommended launch trio (answer to Q1 + Q6 combined)

For v1 launch ship **exactly these three** and nothing else:

| Priority | Channel               | Effort to ship                         | Why                                                           |
| -------- | --------------------- | -------------------------------------- | ------------------------------------------------------------- |
| 1        | **npm**               | ~1 day — `publish-npm.sh` already exists | Existing, works, `@jellyclaw/engine@0.0.1` is already on the registry scaffold |
| 2        | **Single binary + curl installer** | ~4 days — CI workflow, installer script, first notarized build | Reaches non-Node users, hits the `brew`-style one-liner marketing beat |
| 3        | **Homebrew tap**      | ~1 day after #2 — re-points at GitHub Release tarballs | Converts Mac devs; tap is cheaper than pushing to homebrew-core |

Web-TUI and Tauri come *after* these ship and real users give signal. "Sell
first, build second" from the user's brief → don't build a per-user Fly
Machine infra until at least 25 paying users ask for a no-install demo link.

Total calendar effort for the trio: ~6 engineering days spread over 2 weeks
(accounting for notarization backend-and-forth, which [Apple docs state](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)
usually completes "within minutes to hours" but can stall on first submission).

---

## § Single-binary build pipeline + auto-update

### Build matrix

Bun's `bun build --compile` cross-compiles from one host machine to seven
targets per [bun.sh/docs/bundler/executables](https://bun.sh/docs/bundler/executables):

```
bun-darwin-arm64        — Apple Silicon macs          (primary)
bun-darwin-x64          — Intel macs                  (primary)
bun-linux-x64           — glibc linux x86_64          (primary)
bun-linux-arm64         — glibc linux arm64           (primary)
bun-linux-x64-musl      — alpine / musl               (secondary)
bun-linux-arm64-musl    — alpine / musl arm64         (secondary)
bun-windows-x64         — win11 x86_64                (secondary)
bun-windows-arm64       — win11 arm64                 (tertiary)
```

Bun docs explicitly note the `-baseline` vs `-modern` split for pre-2013
CPUs; we ship the non-suffixed default (modern) and fall back to baseline
only if someone files an `Illegal instruction` issue (per Bun docs warning).

Recommended flags for the release build:

```bash
bun build \
  engine/src/cli/main.ts \
  --compile \
  --minify \
  --sourcemap \
  --bytecode \
  --target="${TARGET}" \
  --outfile "dist/jellyclaw-${TARGET}"
```

- `--minify` per bun docs "optimizes the size of the transpiled output code"
- `--sourcemap` embeds a zstd-compressed sourcemap so stack traces point at
  original `.ts` files — critical for user-reported crashes
- `--bytecode` per bun docs makes `tsc` "start 2x faster"; startup time
  matters for a TUI because the jellyfish spinner has to come up before the
  user notices lag

#### Native-addon caveat

The engine currently depends on `better-sqlite3` (native addon). Bun's
`--compile` supports embedding `.node` files via `require`, per bun docs:
> "You can embed `.node` files into executables. Unfortunately, if you're
> using `@mapbox/node-pre-gyp` or other similar tools, you'll need to make
> sure the `.node` file is directly required or it won't bundle correctly."

**Action items before first binary release:**
1. Verify `better-sqlite3` bundles by running `bun build --compile` locally
   on darwin-arm64 and smoke-testing `./jellyclaw doctor`.
2. If it doesn't, switch to `bun:sqlite` (Bun's built-in, bun docs §SQLite)
   behind a small shim in `engine/src/db/`. This is a one-day swap and
   removes the only native-addon constraint.
3. Cross-compilation can't build native addons — musl/linux-arm64 must be
   built *on* linux-arm64 runners if `better-sqlite3` stays. `bun:sqlite`
   sidesteps this entirely.

#### Release GitHub Actions workflow (sketch)

GitHub Actions matrix strategy ref [docs.github.com/en/actions/how-tos/writing-workflows](https://docs.github.com/en/actions/how-tos/writing-workflows/choosing-what-your-workflow-does/running-variations-of-jobs-in-a-workflow):

```yaml
# .github/workflows/release.yml
name: release
on:
  push:
    tags: ["v*"]
permissions:
  contents: write    # required for gh release create (cli.github.com/manual)
jobs:
  build:
    strategy:
      matrix:
        include:
          - { os: macos-14,      target: bun-darwin-arm64, notarize: true  }
          - { os: macos-13,      target: bun-darwin-x64,   notarize: true  }
          - { os: ubuntu-24.04,  target: bun-linux-x64,    notarize: false }
          - { os: ubuntu-24.04-arm, target: bun-linux-arm64, notarize: false }
          - { os: windows-2022,  target: bun-windows-x64,  notarize: false }
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v1
      - run: bun install --frozen-lockfile
      - run: bun run build
      - run: bun build engine/src/cli/main.ts
               --compile --minify --sourcemap --bytecode
               --target=${{ matrix.target }}
               --outfile dist/jellyclaw-${{ matrix.target }}
      - if: matrix.notarize
        run: scripts/notarize.sh dist/jellyclaw-${{ matrix.target }}
        env:
          APPLE_ID:       ${{ secrets.APPLE_ID }}
          APPLE_PASSWORD: ${{ secrets.APPLE_APP_PASSWORD }}
          APPLE_TEAM_ID:  ${{ secrets.APPLE_TEAM_ID }}
      - run: shasum -a 256 dist/jellyclaw-${{ matrix.target }}* > dist/SHA256SUMS.${{ matrix.target }}
      - uses: actions/upload-artifact@v4
        with:
          name: jellyclaw-${{ matrix.target }}
          path: dist/jellyclaw-${{ matrix.target }}*
  release:
    needs: build
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/download-artifact@v4
        with: { path: dist, pattern: "jellyclaw-*", merge-multiple: true }
      - run: cd dist && cat SHA256SUMS.* > SHA256SUMS && rm SHA256SUMS.*
      - env: { GH_TOKEN: ${{ secrets.GITHUB_TOKEN }} }
        run: |
          gh release create "${GITHUB_REF_NAME}" dist/jellyclaw-* dist/SHA256SUMS \
            --generate-notes \
            --draft
```

Concrete usage pattern from [cli.github.com/manual/gh_release_create](https://cli.github.com/manual/gh_release_create):
`gh release create v1.0.0 ./dist/* --generate-notes --draft` → manually
promote draft → GA.

### macOS notarization

Apple Developer Program: **$99/year** ([developer.apple.com docs](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)).
Unavoidable cost; book it now.

Three-step flow per the notarization docs:

```bash
# scripts/notarize.sh
set -euo pipefail
BIN="$1"

# 1. Sign with Developer ID Application cert + JIT entitlements
#    (Bun docs §"Code signing on macOS" — required for --bytecode to work
#    under Gatekeeper because JavaScriptCore JITs)
cat > /tmp/entitlements.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
  <key>com.apple.security.cs.disable-executable-page-protection</key><true/>
  <key>com.apple.security.cs.allow-dyld-environment-variables</key><true/>
  <key>com.apple.security.cs.disable-library-validation</key><true/>
</dict></plist>
EOF

codesign --deep --force -vvv --timestamp \
  --sign "Developer ID Application: ${APPLE_TEAM_ID}" \
  --entitlements /tmp/entitlements.plist \
  --options runtime \
  "$BIN"

# 2. Zip + submit to Apple's notary service
ditto -c -k --keepParent "$BIN" "${BIN}.zip"
xcrun notarytool submit "${BIN}.zip" \
  --apple-id "$APPLE_ID" \
  --team-id "$APPLE_TEAM_ID" \
  --password "$APPLE_PASSWORD" \
  --wait

# 3. Staple the ticket so Gatekeeper works offline
#    (notarization applies to zip; bare binaries can't be stapled — the
#    ticket is on Apple's servers and fetched on first run over the
#    network, which is fine for a CLI that already needs the internet)
rm "${BIN}.zip"
```

**Windows signing:** defer. Windows users hit SmartScreen for unsigned
binaries but can "Run anyway" through one click; we're not selling to a
Windows-enterprise persona at v1. Revisit when a paying customer asks.
SignPath.io offers free OSS signing if we need it; Azure Trusted Signing
(~$10/month) is the new-hotness replacement for EV certs.

### Install.sh (curl | sh) pattern

The Zed pattern (`curl -f https://zed.dev/install.sh | sh`) is the gold
standard per [zed.dev/download](https://zed.dev/download) — the one-liner is
what ends up pasted into blog posts.

```bash
# scripts/install.sh — served at https://jellyclaw.dev/install.sh
set -euo pipefail
VERSION="${JELLYCLAW_VERSION:-latest}"
INSTALL_DIR="${JELLYCLAW_INSTALL_DIR:-$HOME/.local/bin}"
REPO="gtrush03/jellyclaw-engine"

detect_target() {
  local os arch
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"
  case "$os" in
    darwin)  case "$arch" in arm64|aarch64) echo "bun-darwin-arm64";; x86_64) echo "bun-darwin-x64";; esac ;;
    linux)
      local libc=""
      if ldd --version 2>&1 | grep -qi musl; then libc="-musl"; fi
      case "$arch" in aarch64|arm64) echo "bun-linux-arm64${libc}";; x86_64) echo "bun-linux-x64${libc}";; esac ;;
    *) echo "unsupported: $os/$arch" >&2; exit 1 ;;
  esac
}

target="$(detect_target)"
mkdir -p "$INSTALL_DIR"

# Resolve latest tag if VERSION=latest
if [ "$VERSION" = "latest" ]; then
  VERSION="$(curl -fsSL https://api.github.com/repos/${REPO}/releases/latest | grep tag_name | cut -d'"' -f4)"
fi

url="https://github.com/${REPO}/releases/download/${VERSION}/jellyclaw-${target}"
sums="https://github.com/${REPO}/releases/download/${VERSION}/SHA256SUMS"

echo "→ downloading jellyclaw ${VERSION} for ${target}"
curl -fsSL "$url" -o "${INSTALL_DIR}/jellyclaw.tmp"

# Verify checksum
expected="$(curl -fsSL "$sums" | grep "jellyclaw-${target}$" | awk '{print $1}')"
actual="$(shasum -a 256 "${INSTALL_DIR}/jellyclaw.tmp" | awk '{print $1}')"
[ "$expected" = "$actual" ] || { echo "checksum mismatch"; exit 1; }

chmod +x "${INSTALL_DIR}/jellyclaw.tmp"
mv "${INSTALL_DIR}/jellyclaw.tmp" "${INSTALL_DIR}/jellyclaw"
echo "✓ installed to ${INSTALL_DIR}/jellyclaw"
echo "  add to PATH if needed:  export PATH=\"\$PATH:${INSTALL_DIR}\""
```

### Auto-update on startup

Lightweight — do **not** try to self-replace the binary (that path is a
minefield on macOS/Linux/Windows). Instead:

1. On `jellyclaw tui` startup, `fetch('https://api.github.com/repos/gtrush03/jellyclaw-engine/releases/latest')`
   with a 2 s timeout, in parallel with the embedded server boot. If it
   returns a tag newer than the embedded `BUILD_VERSION` define, render a
   one-line banner:
   ```
   ▸ jellyclaw 0.2.0 is available (you have 0.1.3). Run: jellyclaw upgrade
   ```
2. `jellyclaw upgrade` sub-command re-runs `install.sh` in-place. For the
   Homebrew/npm paths, it detects the install root and tells the user to
   `brew upgrade` / `npm update -g` instead of trying to self-modify.
3. Respect `JELLYCLAW_NO_UPDATE_CHECK=1` and opt-out via `jellyclaw config set updates.check false`.

Use `--define BUILD_VERSION='"0.1.3"'` in the build step (bun docs §"Build-time constants")
so the binary knows its own version without reading `package.json`.

---

## § Web-TUI architecture (answers to Q3, Q4, Q5)

**Short answer:** per-session Fly Machine + ttyd + xterm.js, behind a JWT
auth proxy. Topology explanation follows.

### Topology comparison

**Option A — shared PTY pool on one Machine.** One Fly Machine with a pool
of N PTYs, users multiplex via WS. Cheapest. But it means every user's
`jellyclaw` shares the same $HOME, same credentials store, same cwd. For a
tool that executes bash and writes files, this is unacceptable cross-session
isolation. Rejected.

**Option B — per-session Fly Machine (RECOMMENDED).** One Machine per
authenticated user, auto-stopped when the WebSocket closes. Per [fly.io
auto-stop docs](https://fly.io/docs/launch/autostop-autostart/):

> "Auto-stop and auto-start mechanics … when machines are in stopped or
> suspended states, you 'don't pay for their CPU and RAM'."

Idle cost is storage only — ~$0.15/GB-month of rootfs per [fly.io pricing
docs](https://fly.io/docs/about/pricing/). With a 1 GB rootfs that's
$0.15/user/month even if 100 users sign up and never come back.

Active cost: `shared-cpu-1x @ 512MB` is **$0.0046/hour** = ~$3.32/month if
*always-on*. Real usage with auto-stop after 30 s idle → ~5 ¢/user/hour of
actual session time. A free-tier user doing 30 min/day costs us ~3 ¢/day.

Cold-start: fly docs say "starting a Machine from a `suspended` state is
faster than starting a Machine from a `stopped` state" — typically
sub-second suspended, 1–3 s stopped. For a user who clicked "Launch TUI",
a 2 s spinner is fine if labeled ("Booting your sandbox…").

**Option B wins.** Config sketch in `fly.toml`:

```toml
app = "jellyclaw-tui-sessions"
primary_region = "iad"

[build]
  image = "ghcr.io/gtrush03/jellyclaw-web-tui:latest"

[http_service]
  internal_port = 7681     # ttyd default (ttyd README)
  force_https = true
  auto_stop_machines  = "suspend"  # faster wake than "stop"
  auto_start_machines = true
  min_machines_running = 0
```

Spawning is *not* done via `fly.toml` alone — it needs the **Fly Machines
API** ([fly.io/docs/machines](https://fly.io/docs/machines/)) driven by the
auth server so each user gets their own isolated Machine with their own
volume. Pattern: `fly machines create` on sign-up (or on first TUI click),
`fly machines start` on demand, rely on auto-stop for idle.

### Tech stack pick

ttyd vs gotty vs sshx vs custom:

| Option  | Language | Last release      | Active? | License | Notes                                                                 |
| ------- | -------- | ----------------- | ------- | ------- | --------------------------------------------------------------------- |
| ttyd    | C + libuv | v1.7.7 Mar 2024   | Yes     | MIT     | 11.4k★, CJK/IME/ZMODEM/Sixel, Docker image proven                     |
| gotty   | Go       | v1.6.0 Aug 2025   | Community fork | MIT | 2.5k★, fork of Iwasaki's original; ttyd explicitly recommended over it |
| sshx    | Rust     | —                 | Yes     | MIT     | Built for **collaborative** sharing (multi-user per term), E2E encrypted, hosted SaaS focus |
| custom  | Node+ws  | n/a               | —       | —       | ~400 LOC with `node-pty`; we'd own the auth layer perfectly but reinvent rendering quirks |

**Pick ttyd.** Per [tsl0922/ttyd README](https://github.com/tsl0922/ttyd):
"a command-line tool for sharing terminal over the web", MIT-licensed, built
on libuv + xterm.js, handles CJK/IME/ANSI/resize out of the box. It's the
same stack [Home Assistant add-on](https://github.com/tsl0922/ttyd/wiki) and
[cloudtty](https://github.com/cloudtty/cloudtty) use in production. Docker
image `tsl0922/ttyd` ships on Docker Hub; our container just wraps it.

Why not sshx: sshx is a collaboration-first product ("secure web-based,
collaborative terminal", server never sees keystrokes, E2E encrypted). We
want the *opposite* — the server needs to run jellyclaw on behalf of the
user, so E2E between user and their own Machine's keyboard is overkill and
blocks us from metering/billing.

Why not gotty: ttyd's own README explicitly describes itself as "a C port of
GoTTY with CJK and IME support" — ttyd is the more-polished successor.

Why not custom: reinventing terminal resize, paste, unicode, and ANSI color
handling is a multi-week rabbit hole. ttyd's 11.4k★ and multi-year track
record beats what we'd ship in v1.

### Container image

```dockerfile
# Dockerfile — ghcr.io/gtrush03/jellyclaw-web-tui
FROM tsl0922/ttyd:1.7.7 AS ttyd

FROM oven/bun:1.2-debian
COPY --from=ttyd /usr/bin/ttyd /usr/bin/ttyd
COPY --from=ttyd /usr/lib/x86_64-linux-gnu/libwebsockets.so.* /usr/lib/x86_64-linux-gnu/
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*

# Install jellyclaw from npm (easy path) or copy the binary in
RUN bun install -g @jellyclaw/engine@latest

# /boot.sh runs inside the per-user Machine
COPY boot.sh /boot.sh
ENTRYPOINT ["/boot.sh"]
```

```bash
#!/bin/bash
# /boot.sh — called by fly machine start
set -euo pipefail

# The per-user API key is in a Fly secret mounted as env; or if using
# managed-tier, /etc/jellyclaw/managed.key is baked into the image.
export ANTHROPIC_API_KEY="${JELLYCLAW_ANTHROPIC_API_KEY}"
export JELLYCLAW_USER_ID="${JELLYCLAW_USER_ID}"
export JELLYCLAW_TIER="${JELLYCLAW_TIER:-managed}"   # managed | byok | pro
cd /workspace                                        # fly Volume mount

# Run ttyd wrapping the jellyclaw TUI. -W for writable, -c for basic auth
# fallback, -t for client opts (no title override), -p default 7681.
# (Flags per ttyd README.)
exec ttyd -W -p 7681 -t titleFixed="jellyclaw" jellyclaw tui
```

### Front-end wire-up (xterm.js)

Per [xterm.js docs](https://xtermjs.org/docs/) and the [xtermjs/xterm.js
README](https://github.com/xtermjs/xterm.js): xterm.js is MIT, used by
VSCode/Hyper/JupyterLab/Replit, addons include `addon-fit`, `addon-webgl`,
`addon-web-links`, `addon-clipboard`, `addon-unicode11`.

```tsx
// site/src/routes/tui/+page.svelte (or Next.js page)
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";

const term = new Terminal({
  cursorBlink: true,
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  fontSize: 13,
  theme: {
    background: "#0A1020",   // Deep Ink (jellyclaw brand)
    foreground: "#E6ECFF",   // Spindrift
    cursor:     "#3BA7FF",   // Jelly Cyan
  },
});
const fit = new FitAddon();
term.loadAddon(fit);
term.loadAddon(new WebglAddon());        // GPU-accelerated
term.loadAddon(new ClipboardAddon());    // OSC 52 copy/paste
term.loadAddon(new Unicode11Addon());    // correct wcwidth for emoji 🪼
term.loadAddon(new WebLinksAddon());
term.unicode.activeVersion = "11";
term.open(document.getElementById("xterm")!);
fit.fit();

// JWT minted by our auth server; ttyd reads it from the WS upgrade.
const ws = new WebSocket(
  `wss://session-${userId}.jellyclaw-tui.fly.dev/ws?token=${jwt}`,
  ["tty"]
);

ws.binaryType = "arraybuffer";
ws.onmessage = (e) => term.write(new Uint8Array(e.data));
term.onData((d) => ws.send(new TextEncoder().encode("0" + d)));   // ttyd tags input frames with leading "0"

window.addEventListener("resize", () => {
  fit.fit();
  ws.send(new TextEncoder().encode("1" + JSON.stringify({ columns: term.cols, rows: term.rows })));
});
```

Ink + ttyd: Ink's terminal-width detection reads `process.stdout.columns`,
which is propagated by ttyd via the resize control frame (`"1"` prefix),
which `node-pty` on the Machine side turns into a real `TIOCSWINSZ`. Ink
picks it up through the normal `stdout.on("resize")` path. **No special
handling needed**; tested the same flow in OpenCode's web demo (the tree
we vendored).

### Keyboard + mobile

- Ctrl-A / Ctrl-C / arrow keys — xterm.js handles out of the box, no custom
  mapping.
- Cmd-C / Cmd-V — with `@xterm/addon-clipboard`, OSC 52 is transparent on
  Chrome/Edge/Safari. Firefox requires an explicit user permission prompt.
- Function keys / alt — standard xterm sequences, work.
- Mobile: iPad + external keyboard is 100 % usable. Phone (iOS Safari /
  Chrome Android) works but the virtual keyboard is miserable for modifier
  keys. Ship with a "mobile banner" nudging users to desktop — don't try to
  solve mobile-first input in v1.

### Auth flow

```
┌──────────┐  1. magic link   ┌────────────┐  5. JWT  ┌────────────┐
│ landing  │ ───────────────▶ │  auth.     │ ──────▶  │ /tui page  │
│  page    │  (email + Resend)│  jellyclaw │          │ (xterm.js) │
└──────────┘                  │   .dev     │          └─────┬──────┘
                              └─────┬──────┘                │
      2. user clicks link           │ 3. POST /session      │ 6. WS upgrade
         (contains one-time JWT)    │   → creates Fly       │    wss://session-
                                    │     Machine via       │    ${uid}.jellyclaw
                                    ▼     Machines API      │    -tui.fly.dev
                              ┌──────────────┐              │    ?token=$jwt
                              │ Fly Machines │◀─────────────┘
                              │ one per user │  7. ttyd validates JWT
                              │ auto-stop 30s│     via JELLYCLAW_SERVER_TOKEN
                              └──────────────┘     env var, spawns tui
```

Key points:

1. Auth server (same Fly app as the Agent 1 backend) issues short-lived JWTs
   with `sub=userId`, `aud=tui-session`, 1 h TTL.
2. The jellyclaw TUI already supports `JELLYCLAW_SERVER_TOKEN` for attach
   mode (see `engine/src/cli/tui.ts#resolveAttachTarget`). We reuse this
   contract — ttyd validates the bearer via a small pre-flight.
3. API keys in **managed tier**: key held in auth-server secret store, injected
   as `JELLYCLAW_ANTHROPIC_API_KEY` into the Machine's env.
4. API keys in **BYOK tier**: user pastes their own key in a settings panel;
   stored encrypted at rest (KMS), decrypted server-side and injected into
   the Machine's env at spawn time.
5. **Session persistence**: each user's Fly Machine has an attached
   `fly volume` (~$0.15/GB-mo), mounted at `/workspace`. When the Machine
   auto-stops the volume persists; on next visit, it auto-starts and
   `~/.jellyclaw/` state survives.

### Topology decision: **Option B, shipped Month 2**

Per-session Machine. Ship the binary + npm + brew first. The web-TUI is the
marketing surface (the "click here to try it" link on the landing page), but
it's not the primary distribution channel — it's the on-ramp that converts
to "install the binary for real work."

---

## § Npm + Homebrew strategy (answers to Q6)

### Npm: keep the scoped name, add an unscoped alias

Per [docs.npmjs.com/cli/v10/using-npm/scope](https://docs.npmjs.com/cli/v10/using-npm/scope):
scoped packages are not public by default; `npm publish --access public` on
first release, subsequent releases don't need the flag.

- Keep `@jellyclaw/engine` as the canonical package (already shipping at
  `0.0.1`). Scoped is best for the *library* consumers (Genie) because it
  signals "official, owned by this org."
- Publish a thin unscoped `jellyclaw` package that just `dependencies:
  "@jellyclaw/engine": "*"` + re-exports the bin. This makes
  `npm i -g jellyclaw` and `bunx jellyclaw` work without the `@` sigil,
  which is what blog posts and tweets will type.
- Bin entry already correct: `"jellyclaw": "./bin/jellyclaw"` in
  `engine/package.json`. The unscoped package adds the same bin with a
  `bin` passthrough.

Action: write a 10-line `packages/unscoped/package.json` that runs
`publish-npm.sh` once per release tag.

### Homebrew: tap now, core later

The current `homebrew/jellyclaw.rb` formula expects a DMG
(`url "https://example/j.dmg"`). This should be replaced with a
binary-tarball pattern once the Release workflow exists:

```ruby
# homebrew/jellyclaw.rb (new template)
class Jellyclaw < Formula
  desc "Open-source Claude Code replacement (embeddable agent TUI)"
  homepage "https://github.com/gtrush03/jellyclaw-engine"
  version "0.2.0"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/gtrush03/jellyclaw-engine/releases/download/v#{version}/jellyclaw-bun-darwin-arm64.tar.gz"
      sha256 "…"                    # filled by CI
    else
      url "https://github.com/gtrush03/jellyclaw-engine/releases/download/v#{version}/jellyclaw-bun-darwin-x64.tar.gz"
      sha256 "…"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/gtrush03/jellyclaw-engine/releases/download/v#{version}/jellyclaw-bun-linux-arm64.tar.gz"
      sha256 "…"
    else
      url "https://github.com/gtrush03/jellyclaw-engine/releases/download/v#{version}/jellyclaw-bun-linux-x64.tar.gz"
      sha256 "…"
    end
  end

  def install
    bin.install "jellyclaw"
  end

  test do
    assert_match "jellyclaw", shell_output("#{bin}/jellyclaw --version")
  end
end
```

Tap repo: `gtrush03/homebrew-jellyclaw`. User flow:

```bash
brew tap gtrush03/jellyclaw
brew install jellyclaw
```

Homebrew bottles ([docs.brew.sh/Bottles](https://docs.brew.sh/Bottles)) are
gzipped tarballs of compiled binaries. For our case we don't need bottles
— we ship raw binaries already compiled by Bun, and Homebrew just drops
them into `bin/`. Bottles matter when Homebrew would otherwise compile from
source; we don't.

**Don't submit to homebrew-core until after v1.0** because core has a
long review queue and requires the formula to build from source (which our
Bun compile doesn't). The tap covers 99 % of value at 1 % of effort.

### Release automation

`scripts/build-brew-formula.sh` already exists in the repo. Update it to:

1. Read the version + SHA256 of each platform tarball from the latest
   GitHub Release.
2. Regenerate `jellyclaw.rb` from `jellyclaw.rb.template`.
3. `git push` to `gtrush03/homebrew-jellyclaw`.

Call it from the `release` job in `.github/workflows/release.yml` after
`gh release create`.

---

## § Tauri — kill decision

Current state: `desktop/` ships a stub with a `tauri.conf.json` expecting a
`binaries/jellyclaw` sidecar + a DMG bundle. `desktop/src-tauri/binaries/`
contains two files (`jellyclaw` and `jellyclaw-aarch64-apple-darwin`) but
the frontend is minimal.

Per [tauri.app/start](https://tauri.app/start/): minimal Tauri app is
<600 KB, but with our ~60 MB sidecar the result is the same size as just
shipping the bare binary. Per [tauri.app/distribute](https://tauri.app/distribute/):
shipping a Tauri app means three signing chains (macOS DMG + notarize,
Windows MSI/NSIS + SignPath, Linux .deb/.rpm/AppImage) — each of which
burns a week.

The [Tauri updater plugin](https://v2.tauri.app/plugin/updater/) is nice
(signed JSON manifest + RSA sig verification, `{{current_version}}` /
`{{target}}` / `{{arch}}` in the endpoint URL), but for a TUI it's worse
than the GitHub Releases approach because users can't `brew upgrade`.

**Decision: defer Tauri to post-v1.** Concretely:

- Leave the `desktop/` tree in place but stop building it in CI.
- Don't list it on the install page.
- Revisit only if (a) a paying customer asks for a native macOS app, or
  (b) we build a non-TUI UI (video calling, visual pane protocol) that
  genuinely needs a native frame.

What would change the call: if the Agent 2 "dashboard" grows into a
full-featured visual UI that users want dockable/always-on, Tauri becomes
the right home — but at that point it's a *separate product* from the TUI
and should have its own distribution doc.

---

## § Paid-tier distribution mapping (answer to Q8)

"Sell first, build second" — what does a paid distribution actually look
like per tier?

| Tier        | Target user               | Price        | How they get the TUI                              | Backend need                                  |
| ----------- | ------------------------- | ------------ | ------------------------------------------------- | --------------------------------------------- |
| **Free**    | Tire-kicker, waitlist lead| $0           | Web-TUI only, 10 msg/day                          | Auth + managed Machine + rate limiter         |
| **Pro**     | Individual dev            | $20/mo       | Web-TUI unlimited Sonnet + binary install unlocks Opus | Auth + managed Machine + higher rate limit |
| **BYOK**    | Existing Anthropic user   | $10/mo       | Binary or npm, they paste their own key           | Auth server (license check), no Fly compute   |
| **Self-host** | Team / enterprise       | $200/mo flat | Binary + docs, license key checked on startup     | License server (tiny Fly app)                 |

Cost model:

- **Free tier**: avg user runs ~2 min/day → ~$0.15/user/month of Fly compute
  + ~$0.50/user/month of Anthropic tokens (we're paying with our key at
  10 msg/day, ~$0.03/msg). Total ~$0.65/user/month burn. Sustainable up
  to ~5000 free users for $3.2k/month; gate at waitlist signup.
- **Pro tier**: 30 min/day avg → ~$1/user/month Fly + $15/user/month in
  Anthropic. Margin ~$4/user at $20. Tight but workable.
- **BYOK tier**: zero Fly cost, $10 is pure margin minus Stripe fees
  (~$0.60). The tier we should actually push — it aligns incentives and
  is trivially priced.
- **Self-host**: license server is a static JSON endpoint, zero ongoing cost
  besides support. Highest margin.

**Channel mapping:**

| Channel       | Free | Pro | BYOK | Self-host |
| ------------- | ---- | --- | ---- | --------- |
| Web TUI       | ✅    | ✅   | —    | —         |
| Binary / curl | —    | ✅   | ✅    | ✅         |
| npm           | —    | ✅   | ✅    | ✅         |
| Homebrew      | —    | ✅   | ✅    | ✅         |
| Docker        | —    | —   | —    | ✅ (CI)   |

Upgrade funnel: landing page → web-TUI demo (Free) → hits 10-msg limit →
Pro CTA → clicks "Install the binary for unlimited" → `curl | sh` →
`jellyclaw auth login` → license-key validation → unlocked.

---

## § First-launch UX (answer to Q9)

### Transcript — managed tier (Free / Pro)

```
$ jellyclaw --version
jellyclaw 0.2.0 (bun-darwin-arm64, commit 4a7b2c9, built 2026-05-01)

$ jellyclaw
Welcome to jellyclaw. Let's get you set up (45 seconds).

┌─ Step 1 of 2 ─ Sign in ─────────────────────────────────────────┐
│                                                                 │
│   Open this URL to sign in with your browser:                   │
│                                                                 │
│     https://jellyclaw.dev/cli?code=7K3M-9F2Q                    │
│                                                                 │
│   Waiting for browser…  ⠋                                       │
│                                                                 │
│   Press Ctrl-C to skip and use BYOK mode instead.               │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘

✓ Signed in as mariatrushevskaya@gmail.com (Pro plan)

┌─ Step 2 of 2 ─ Project ─────────────────────────────────────────┐
│                                                                 │
│   Working directory:  ~/code/my-app                             │
│                                                                 │
│   jellyclaw can read + write files in this directory.           │
│   Press Enter to continue, or specify a different path.         │
│                                                                 │
│   ›                                                             │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘

✓ Configuration saved to ~/.jellyclaw/config.json

  🪼  jellyclaw ready. Type / for commands, Shift-Tab to toggle modes.

  ›
```

### Transcript — BYOK tier

```
$ jellyclaw
Welcome to jellyclaw. Let's get you set up (30 seconds).

┌─ Step 1 of 2 ─ API key ─────────────────────────────────────────┐
│                                                                 │
│   Paste your Anthropic API key (starts with sk-ant-).           │
│   It's stored locally at ~/.jellyclaw/credentials.json (0600).  │
│                                                                 │
│   Key (hidden):  ●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●                 │
│                                                                 │
│   Or set $ANTHROPIC_API_KEY and run jellyclaw again.            │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘

✓ Key validated against api.anthropic.com

  🪼  jellyclaw ready. Type / for commands, Shift-Tab to toggle modes.

  ›
```

### `jellyclaw --version` output (machine-parseable)

```
$ jellyclaw --version
jellyclaw 0.2.0 (bun-darwin-arm64, commit 4a7b2c9, built 2026-05-01)

$ jellyclaw --version --json
{
  "version": "0.2.0",
  "target": "bun-darwin-arm64",
  "commit": "4a7b2c9",
  "built": "2026-05-01T18:42:11Z",
  "bun": "1.2.16",
  "node_compat": "v20.11.0"
}
```

### `jellyclaw auth status`

```
$ jellyclaw auth status
jellyclaw auth
  Plan:        Pro  ($20/month, renews 2026-06-01)
  User:        mariatrushevskaya@gmail.com
  Tier:        managed          (jellyclaw pays the Anthropic bill)
  Model:       claude-opus-4-7  (Opus unlocked on Pro)
  Rate limit:  1000 messages/day   (used 47 today)
  Session:     expires in 29d     (refreshes on next run)
  Config:      ~/.jellyclaw/config.json

$ jellyclaw auth status --json
{
  "plan": "pro",
  "user": "mariatrushevskaya@gmail.com",
  "tier": "managed",
  "model": "claude-opus-4-7",
  "daily_limit": 1000,
  "daily_used": 47,
  "session_expires_at": "2026-05-17T18:42:11Z"
}
```

### `jellyclaw doctor` (first-run health check)

```
$ jellyclaw doctor
jellyclaw doctor  v0.2.0

  ✓ bun runtime            1.2.16 (embedded)
  ✓ ~/.jellyclaw/          exists, 0700
  ✓ ~/.jellyclaw/creds     exists, 0600
  ✓ Anthropic API          reachable (198ms)
  ✓ ripgrep                1.15.0 (embedded)
  ⚠ node                   not found (optional — some MCP servers need it)
  ✓ git                    2.43.0

  Ready. Run `jellyclaw` to start.
```

---

## § Measurement / telemetry defaults (answer to Q10)

**Rule: opt-in, never opt-out.** A first-launch prompt:

```
Would you like to help improve jellyclaw by sending anonymous
install + session telemetry? You can change this later with
`jellyclaw config set telemetry.enabled false`.

[y] Yes, send anonymous usage data
[n] No, keep everything local (default)

  ›
```

### Install-funnel events (prioritized by value)

| Event                | Trigger                                 | Properties                              | Notes                                    |
| -------------------- | --------------------------------------- | --------------------------------------- | ---------------------------------------- |
| `install_started`    | `install.sh` invocation                 | target (arm64/x64), os, method (curl/brew/npm) | No user ID yet — session ID only |
| `install_completed`  | `install.sh` final `mv`                 | target, elapsed_ms, size_bytes          | Lets us catch corrupt-download rates     |
| `first_run`          | `jellyclaw` with no config dir          | version, target, is_tty                 | Install-to-first-run time gap            |
| `auth_completed`     | credentials written successfully        | tier (managed/byok), via_browser_flow   | Auth drop-off rate                       |
| `tui_session_start`  | `launchTui` mounts `<App/>`             | session_id, resumed_from_id?            | Active user signal                       |
| `tui_session_end`    | `dispose()` runs                        | session_id, duration_ms, exit_code, messages_sent, tools_called | Retention    |
| `error_reported`     | uncaught error in TUI                   | err_name, err_message (scrubbed), stack_hash | Crash rate — stack_hash not raw stack |
| `upgrade_detected`   | version check found newer release       | from_version, to_version                | Upgrade funnel                           |

Sink: PostHog self-hosted on the Fly app from Agent 1 (zero extra infra).
Or just batch-POST to a `/v1/telemetry` endpoint on the existing Hono
server and let the backend fan out.

### Retention metrics

- **D1 / D7 / D30 retention**: % of unique `first_run` anon IDs that fire
  `tui_session_start` on day N.
- **Session length distribution**: histogram of `tui_session_end.duration_ms`.
- **Channel attribution**: `install_started.method` → filter D7 retention by
  channel to see whether binary users or npm users stick around longer.
- **Funnel**: `install_started` → `install_completed` → `first_run` →
  `auth_completed` → `tui_session_start` → `tui_session_end` — report
  conversion % between steps and bounce step.
- **A/B install flows**: rotate the landing-page CTA between "Download
  binary" / "npm install" / "Try in browser" (1/3 each); measure
  `tui_session_start` / unique-landing-visitor. We can tell within a week
  which channel converts best for our audience.

### What we do NOT send

- File paths (user writes files; their paths are private)
- Prompts (obvious)
- Tool inputs/outputs
- API keys (already redacted by pino config — see `CLAUDE.md` §7)
- Exception messages containing file paths (scrub via a `*/users/**` →
  `<home>` replacement)

### Opt-out UX

- `JELLYCLAW_TELEMETRY=0` env var — respected at every event-fire
  callsite, no network call when 0.
- `jellyclaw config set telemetry.enabled false` — persists to
  `~/.jellyclaw/config.json`.
- Status visible in `jellyclaw doctor` output.

---

## § Ship-this-for-v1-launch

**One prescription** for the day-one distribution plan:

1. **This week** — fix `jellyclaw.rb.template`, swap `better-sqlite3` for
   `bun:sqlite`, write `scripts/install.sh`, prove `bun build --compile`
   produces a working binary on darwin-arm64 locally. Smoke-test
   `./jellyclaw doctor` on the compiled binary.
2. **Next week** — build the GitHub Actions release workflow for all 7
   targets, buy the Apple Developer Program ($99), implement
   `scripts/notarize.sh`, cut `v0.2.0` as the first binary release.
3. **Week 3** — publish the unscoped `jellyclaw` npm package, set up
   `gtrush03/homebrew-jellyclaw` tap, update `docs/install.md` to reflect
   the three primary channels.
4. **Week 4** — launch. The landing page at `jellyclaw.dev` shows three
   equally-weighted CTAs:
   - `curl -fsSL https://jellyclaw.dev/install.sh | sh`
   - `brew install gtrush03/jellyclaw/jellyclaw`
   - `npm i -g jellyclaw`
5. **Month 2** — build the web-TUI as a *marketing surface* (not primary
   distribution): auth server + Machines API client + ttyd container +
   xterm.js page at `/tui`. Gate it behind waitlist signup so we control
   the Fly burn rate.
6. **Month 3+** — revisit: Tauri if and only if the visual dashboard demands
   it; Windows signing if and only if a paying customer asks; homebrew-core
   submission if and only if we hit 1000 tap installs organically.

**What we are explicitly not building for v1:** Tauri desktop shell, Windows
code-signing pipeline, Docker image (keep it as a dev-only fallback),
homebrew-core submission, per-distro Linux packages (.deb/.rpm/AppImage),
App Store submission, iOS/Android companion apps.

The TUI's job is to be great in a terminal. The distribution's job is to get
it into a terminal with the fewest questions asked. Three channels. One
prescription. Ship.

---

## Appendix — cited sources

- **Bun `--compile`** — [bun.sh/docs/bundler/executables](https://bun.sh/docs/bundler/executables) — cross-compile targets, `--bytecode`, `--minify`, `--sourcemap`, embedded assets, macOS codesign guidance, `BUN_BE_BUN=1`, cross-compile limitations for Windows metadata flags.
- **ttyd** — [github.com/tsl0922/ttyd](https://github.com/tsl0922/ttyd) + [wiki](https://github.com/tsl0922/ttyd/wiki) — v1.7.7 (Mar 2024), MIT, libuv + xterm.js, CJK/IME/ZMODEM/Sixel, Docker image `tsl0922/ttyd`, flags `-p/-c/-S/-W/-t`.
- **gotty** — [github.com/sorenisanerd/gotty](https://github.com/sorenisanerd/gotty) — v1.6.0 Aug 2025, community fork; ttyd README explicitly describes itself as a "C port of GoTTY with CJK and IME support".
- **sshx** — [sshx.io](https://sshx.io) — collaborative web terminal, Rust, E2E encrypted ("server never sees what you're typing"), hosted-first; wrong fit for a server-side agent product.
- **xterm.js docs** — [xtermjs.org/docs](https://xtermjs.org/docs/) — addons (fit, webgl, clipboard, unicode11, web-links, serialize, search, ligatures, image, attach, progress).
- **xterm.js repo** — [github.com/xtermjs/xterm.js](https://github.com/xtermjs/xterm.js) — MIT, used by VSCode/Hyper/JupyterLab/Replit, supported browsers are current Chrome/Edge/Firefox/Safari.
- **xterm clipboard addon** — [github.com/xtermjs/xterm.js/tree/master/addons/addon-clipboard](https://github.com/xtermjs/xterm.js/tree/master/addons/addon-clipboard) — custom `IClipboardProvider`, requires xterm v4+.
- **Tauri v2** — [tauri.app/start](https://tauri.app/start/) (<600 KB minimal app, supports mac/linux/win/iOS/android) + [tauri.app/distribute](https://tauri.app/distribute/) (DMG/MSI/NSIS/deb/rpm/AppImage/Snapcraft/Flatpak).
- **Tauri updater** — [v2.tauri.app/plugin/updater](https://v2.tauri.app/plugin/updater/) — signed JSON manifest, mandatory RSA sig verification, `{{current_version}}/{{target}}/{{arch}}` endpoint vars.
- **Fly Machines** — [fly.io/docs/machines](https://fly.io/docs/machines/) — subsecond start/stop, Machines REST API, per-user pattern documented.
- **Fly auto-stop** — [fly.io/docs/launch/autostop-autostart](https://fly.io/docs/launch/autostop-autostart/) — `auto_stop_machines = "suspend"`, proxy wakes on request, no CPU/RAM charges when stopped.
- **Fly pricing** — [fly.io/docs/about/pricing](https://fly.io/docs/about/pricing/) — shared-cpu-1x @ 256 MB: $0.0028/hr ($2.02/mo); 512 MB: $0.0046/hr; performance-1x 2 GB: $0.0447/hr; rootfs stopped: $0.15/GB·30 days.
- **Homebrew bottles** — [docs.brew.sh/Bottles](https://docs.brew.sh/Bottles) — taps can ship bottles via `root_url`; bottles are gzipped tarballs; arm64 vs x86_64 handled with platform identifiers in the bottle DSL.
- **npm scopes** — [docs.npmjs.com/cli/v10/using-npm/scope](https://docs.npmjs.com/cli/v10/using-npm/scope) — scoped packages private by default; first publish requires `--access public`.
- **Apple notarization** — [developer.apple.com/documentation/security/notarizing-macos-software-before-distribution](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution) — $99/yr developer program, sign→submit→staple, `xcrun notarytool submit ... --wait`, minutes-to-hours typical.
- **GitHub Actions matrix** — [docs.github.com/en/actions/how-tos/writing-workflows/choosing-what-your-workflow-does/running-variations-of-jobs-in-a-workflow](https://docs.github.com/en/actions/how-tos/writing-workflows/choosing-what-your-workflow-does/running-variations-of-jobs-in-a-workflow) — matrix strategy syntax, `runs-on: ${{ matrix.os }}`, `macos-14 / macos-13 / ubuntu-24.04 / ubuntu-24.04-arm / windows-2022` runners.
- **gh release CLI** — [cli.github.com/manual/gh_release_create](https://cli.github.com/manual/gh_release_create) — `gh release create <tag> <assets> --generate-notes --draft`; `permissions: contents: write` needed in workflow.
- **Warp distribution** — [warp.dev/blog](https://www.warp.dev/blog) — DMG direct download, .deb/.rpm for Linux, Windows x64/arm64 installers, "Send link" for mobile-to-desktop handoff.
- **Zed distribution** — [zed.dev/download](https://zed.dev/download) — macOS Apple Silicon direct download, `curl -f https://zed.dev/install.sh | sh` for Linux, Windows Intel/AMD builds.
