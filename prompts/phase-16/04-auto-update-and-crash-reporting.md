# Phase 16 — Desktop App Polish — Prompt 04: Auto-update + crash reporting

**When to run:** After 16.03 is marked done.
**Estimated duration:** 6–8 hours
**New session?** Yes
**Model:** Claude Opus 4.6 (1M context)

---

## Session startup

Paste `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/STARTUP-TEMPLATE.md`, substituting `<NN>` with 16. Verify 16.03 is ticked.

---

## Research task

Read:

1. `/Users/gtrush/Downloads/jellyclaw-engine/phases/PHASE-16-desktop-polish.md` — steps 4 (Auto-update) and 5 (Sentry).
2. `/Users/gtrush/Downloads/jellyclaw-engine/desktop/SPEC.md` — release channel expectations.
3. `/Users/gtrush/Downloads/jellyclaw-engine/engine/SECURITY.md` — the scrubber list (paths under `~/.ssh`, env with `KEY|TOKEN|SECRET`, request headers in stream). Reuse on the client.
4. `/Users/gtrush/Downloads/jellyclaw-engine/prompts/phase-15/05-macos-dmg-build-and-sign.md` — existing Tauri build, signing identity env vars. The updater needs a **separate** signing key (Tauri's ed25519 updater key, not the Apple Developer ID cert).

Fetch:

- `https://v2.tauri.app/plugin/updater/` — endpoint format, ed25519 signature header, installMode values.
- `https://v2.tauri.app/distribute/` — where bundle outputs go per target.
- `https://docs.sentry.io/platforms/rust/guides/tauri/` — `sentry-rust` + `@sentry/tauri` integration; panic handler wiring.
- `https://docs.sentry.io/platforms/javascript/guides/react/` — error boundary, `@sentry/vite-plugin` for sourcemap upload.
- `https://developers.cloudflare.com/r2/` — R2 buckets, public access patterns, R2 Workers for custom headers.
- `https://developers.cloudflare.com/r2/api/workers/workers-api-usage/` — binding an R2 bucket to a Worker.
- `https://github.com/tauri-apps/tauri-action` — how the official release action wires `TAURI_SIGNING_PRIVATE_KEY` for updater signatures.

## Implementation task

Ship two independent-but-related systems:

1. **Auto-update** via Tauri updater plugin v2 + an R2-hosted manifest served by a tiny R2 Worker.
2. **Crash reporting** via Sentry on both the Rust (Tauri process) and JS (React) sides, opt-in, with PII scrubbing.

### Files to create/modify

```
desktop/src-tauri/tauri.conf.json                # plugins.updater block
desktop/src-tauri/Cargo.toml                     # tauri-plugin-updater, sentry, sentry-tauri
desktop/src-tauri/src/main.rs                    # sentry::init + panic handler
desktop/src-tauri/src/updater.rs                 # check + install commands
desktop/src/lib/update.ts                        # frontend update flow
desktop/src/components/UpdateBanner.tsx
desktop/src/components/ReleaseNotesModal.tsx
desktop/src/lib/sentry.ts                        # init + scrubber
desktop/src/app/ErrorBoundary.tsx                # Sentry-wrapped
desktop/vite.config.ts                           # @sentry/vite-plugin
.github/workflows/release-manifest.yml           # R2 manifest updater
cloudflare/workers/releases/                     # R2 Worker source
cloudflare/workers/releases/wrangler.toml
cloudflare/workers/releases/src/index.ts
engine/src/logger.ts                             # export scrubber pattern list
```

### Prerequisites check

```bash
# Verify Phase 15 .dmg can still be built
cd /Users/gtrush/Downloads/jellyclaw-engine/desktop
pnpm tauri build --debug 2>&1 | tail -20

# Generate the Tauri updater key pair if not already present
pnpm tauri signer generate -w ~/.tauri/jellyclaw-updater.key
# This prints the public key — save to an env var reference doc
cat ~/.tauri/jellyclaw-updater.key.pub
```

The private key stays on disk + in CI secrets. The public key is embedded in `tauri.conf.json`. Losing the private key = cannot ship updates to existing installs (they'll reject unsigned manifests). Back it up now.

### Step-by-step — Auto-update

**1. Install plugin.**

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine/desktop
pnpm add @tauri-apps/plugin-updater @tauri-apps/plugin-process
cd src-tauri && cargo add tauri-plugin-updater tauri-plugin-process
```

Register in `lib.rs`:

```rust
.plugin(tauri_plugin_updater::Builder::new().build())
.plugin(tauri_plugin_process::init())
```

**2. `tauri.conf.json` → `plugins.updater`:**

```json
{
  "plugins": {
    "updater": {
      "active": true,
      "pubkey": "<BASE64 ED25519 PUBKEY FROM jellyclaw-updater.key.pub>",
      "endpoints": [
        "https://releases.jellyclaw.dev/{{target}}/{{arch}}/{{current_version}}"
      ],
      "windows": { "installMode": "passive" }
    }
  }
}
```

`{{target}}` expands to `darwin`, `windows`, `linux`; `{{arch}}` to `aarch64`, `x86_64`. `installMode: passive` shows a silent MSI/EXE install progress bar on Windows without UAC re-prompts (cert must be trusted; see prompt 05).

**3. Manifest format** returned by R2 Worker:

```json
{
  "version": "1.0.1",
  "notes": "## Fixes\n- approval modal focus trap\n- Linux notification fallback\n",
  "pub_date": "2026-04-20T18:00:00Z",
  "platforms": {
    "darwin-aarch64": {
      "signature": "<ed25519 sig over the binary>",
      "url": "https://releases.jellyclaw.dev/bin/darwin/aarch64/Jellyclaw_1.0.1_aarch64.app.tar.gz"
    },
    "darwin-x86_64":  { "signature": "...", "url": "..." },
    "windows-x86_64": { "signature": "...", "url": "https://.../Jellyclaw_1.0.1_x64-setup.exe" },
    "linux-x86_64":   { "signature": "...", "url": "https://.../jellyclaw_1.0.1_amd64.AppImage" }
  }
}
```

Status codes: Tauri expects **204 No Content** when no update is available, **200 + JSON** when one is.

**4. R2 Worker** (`cloudflare/workers/releases/src/index.ts`):

```ts
interface Env {
  MANIFESTS: R2Bucket;     // binding to "jellyclaw-releases-manifests"
  BINARIES:  R2Bucket;     // binding to "jellyclaw-releases-binaries"
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean);

    if (parts[0] === "bin") {
      const key = parts.slice(1).join("/");
      const obj = await env.BINARIES.get(key);
      if (!obj) return new Response("not found", { status: 404 });
      return new Response(obj.body, {
        headers: { "content-type": obj.httpMetadata?.contentType ?? "application/octet-stream",
                   "cache-control": "public, max-age=31536000, immutable" },
      });
    }

    // /:target/:arch/:current_version
    if (parts.length !== 3) return new Response("bad request", { status: 400 });
    const [target, arch, current] = parts;
    const manifest = await env.MANIFESTS.get("latest.json");
    if (!manifest) return new Response("no releases", { status: 503 });
    const latest = JSON.parse(await manifest.text());

    if (semverLte(latest.version, current)) return new Response(null, { status: 204 });

    const platformKey = `${target}-${arch}`;
    const platform = latest.platforms[platformKey];
    if (!platform) return new Response(null, { status: 204 });

    return new Response(JSON.stringify({
      version: latest.version,
      notes: latest.notes,
      pub_date: latest.pub_date,
      url: platform.url,
      signature: platform.signature,
    }), { headers: { "content-type": "application/json" }});
  }
};
```

`wrangler.toml` binds `MANIFESTS` and `BINARIES` to two R2 buckets. Deploy with `pnpm wrangler deploy`. Custom domain `releases.jellyclaw.dev` via R2 public bucket + Cloudflare DNS.

**5. Frontend flow** (`desktop/src/lib/update.ts`):

```ts
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import semver from "semver";

export async function checkForUpdate(current: string) {
  const update = await check();
  if (!update?.available) return null;
  return {
    version: update.version,
    notes: update.body ?? "",
    isPatch: semver.diff(current, update.version) === "patch",
    install: async () => {
      await update.downloadAndInstall((event) => {
        // emit progress to React via Tauri event
      });
      await relaunch();
    },
  };
}
```

On app start, schedule a check 10s after mount (never blocks startup). For patch versions (1.0.x → 1.0.y), auto-download silently and prompt only to relaunch. For minor/major, show `<UpdateBanner>` with "Install" button that opens `<ReleaseNotesModal>` first.

**6. Release notes modal.** Markdown-render the `notes` field via `marked`; show `pub_date` relative ("3 days ago"); show file size + SHA256 (fetched from a `HEAD` request to the binary URL, header `x-amz-meta-sha256`).

**7. Rollback.** Tauri's updater backs up the previous bundle before install. If the new app fails to launch, user can reopen from `/Applications/Jellyclaw.app.backup` (macOS) or `%LOCALAPPDATA%\jellyclaw\previous\` (Windows). Document this; no UI needed for MVP.

### Step-by-step — Sentry

**1. Rust side.** `main.rs`:

```rust
fn main() {
    let _guard = sentry::init(sentry::ClientOptions {
        dsn: std::env::var("SENTRY_DSN").ok().and_then(|s| s.parse().ok()),
        release: sentry::release_name!(),
        environment: Some(if cfg!(debug_assertions) { "dev".into() } else { "prod".into() }),
        sample_rate: 1.0,
        traces_sample_rate: 0.0,
        attach_stacktrace: true,
        send_default_pii: false,
        before_send: Some(std::sync::Arc::new(|mut ev| {
            scrub_event(&mut ev);
            Some(ev)
        })),
        ..Default::default()
    });

    std::panic::set_hook(Box::new(|info| {
        sentry::integrations::panic::panic_handler(info);
    }));

    jellyclaw_desktop_lib::run();
}
```

Cargo: `sentry = { version = "0.34", features = ["panic", "tracing"] }`.

`scrub_event` walks `ev.extra`, `ev.tags`, `ev.breadcrumbs[*].data`, `ev.request.headers`, replacing any value matching the shared secret pattern list (exported from `engine/src/logger.ts` as a JSON file generated at build time for the Rust side to embed via `include_str!`).

**2. JS side.**

```bash
pnpm add @sentry/react @sentry/vite-plugin
```

`lib/sentry.ts`:

```ts
import * as Sentry from "@sentry/react";
import { secretPatterns } from "./secrets-scrubber"; // codegen from engine logger

export function initSentry(opts: { enabled: boolean; dsn: string; version: string }) {
  if (!opts.enabled) return;
  Sentry.init({
    dsn: opts.dsn,
    release: opts.version,
    environment: import.meta.env.DEV ? "dev" : "prod",
    sampleRate: 1.0,
    tracesSampleRate: 0.0,
    sendDefaultPii: false,
    integrations: [Sentry.reactRouterV7BrowserTracingIntegration({ ... })],
    beforeSend(event) { return scrub(event); },
    beforeBreadcrumb(crumb) { return scrubCrumb(crumb); },
  });
}

function scrub<T>(obj: T): T {
  const s = JSON.stringify(obj);
  const scrubbed = secretPatterns.reduce((acc, re) => acc.replace(re, "[REDACTED]"), s);
  return JSON.parse(scrubbed) as T;
}
```

`ErrorBoundary.tsx` wraps `<App />` with `Sentry.ErrorBoundary` and renders a fallback that offers `Sentry.showReportDialog({ eventId })`.

Vite plugin uploads sourcemaps at build time:

```ts
// vite.config.ts
import { sentryVitePlugin } from "@sentry/vite-plugin";
export default defineConfig({
  plugins: [
    react(),
    sentryVitePlugin({
      org: "jellyclaw",
      project: "desktop",
      authToken: process.env.SENTRY_AUTH_TOKEN, // CI only
      release: { name: process.env.VITE_APP_VERSION },
      sourcemaps: { assets: "./dist/**" },
    }),
  ],
  build: { sourcemap: true },
});
```

**3. Breadcrumbs.** Tap the XState machine: every transition → `Sentry.addBreadcrumb({ category: "run", message: event.type, data: scrub(event) })`. Cap to last 100 — Sentry default is 100 anyway but be explicit.

**4. Opt-in flow.** Settings → Telemetry toggle from prompt 02 controls this. First-run onboarding defaults OFF. If toggled ON, read `SENTRY_DSN` from a public env baked at build time (`VITE_SENTRY_DSN`), start Sentry, show a toast: "Crash reports enabled. No prompt content is sent."

**5. Cost monitoring.** Sentry free tier = 5k errors / 10k performance / 1 GB attachments per month. Plan Team ($26/mo) = 50k errors. Set Sentry alert: >80% quota → email George. Document in `docs/operations/sentry.md`.

### Engine scrubber reuse

Export the pattern list from `engine/src/logger.ts`:

```ts
export const secretPatterns: RegExp[] = [
  /\bsk-ant-api03-[A-Za-z0-9_-]{80,}/g,
  /\bsk-or-v1-[a-f0-9]{64}/g,
  /\bghp_[A-Za-z0-9]{36,}/g,
  /\bxoxb-[A-Za-z0-9-]{10,}/g,
  /\b[Aa]uthorization:\s*Bearer\s+[A-Za-z0-9._-]+/g,
  /\b[Xx]-[Aa]pi-[Kk]ey:\s*[A-Za-z0-9._-]+/g,
];
```

Build-time codegen writes these to:

- `desktop/src-tauri/assets/secret-patterns.json` (loaded by Rust)
- `desktop/src/lib/secrets-scrubber.ts` (imported by JS)

`scripts/gen-scrubber.ts` runs as a `predev` + `prebuild` hook.

### GitHub Actions — manifest refresh

`.github/workflows/release-manifest.yml` (triggered by `release: published`):

```yaml
name: release-manifest
on: { release: { types: [published] } }
jobs:
  update:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Gather assets + signatures from the release
        run: node scripts/build-manifest.js --tag ${{ github.event.release.tag_name }} > latest.json
      - name: Upload manifest to R2
        env:
          R2_ACCESS_KEY: ${{ secrets.R2_ACCESS_KEY }}
          R2_SECRET_KEY: ${{ secrets.R2_SECRET_KEY }}
          R2_ACCOUNT:    ${{ secrets.R2_ACCOUNT }}
        run: |
          npx wrangler r2 object put jellyclaw-releases-manifests/latest.json \
            --file latest.json \
            --content-type application/json \
            --remote
```

`scripts/build-manifest.js` walks `gh release view <tag> --json assets`, picks per-platform artifacts, reads `.sig` files (produced by `tauri-action`), and emits the manifest.

### Tests to add

- Rust unit: `scrub_event` replaces a Sentry event with a `sk-ant-api03-...` string in `extra`.
- Vitest: `scrub` replaces in deeply nested JSON.
- Integration: POST a fake event to a local Sentry relay; assert no secret pattern appears in the received payload.
- Worker: `wrangler dev` + unit-test the 204/200 branches; `semverLte` edge cases (equal, pre-release).
- Manual: bump version in `latest.json` in a staging R2 bucket; app detects within 10s.

### Verification

```bash
# Generate keys (one-time)
pnpm tauri signer generate -w ~/.tauri/jellyclaw-updater.key

# Build + sign a .app.tar.gz
cd desktop
pnpm tauri build --target aarch64-apple-darwin
pnpm tauri signer sign -k ~/.tauri/jellyclaw-updater.key \
  src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Jellyclaw.app.tar.gz

# Upload to R2 staging + write manifest
wrangler r2 object put jellyclaw-releases-binaries-staging/darwin/aarch64/Jellyclaw_1.0.1_aarch64.app.tar.gz \
  --file Jellyclaw.app.tar.gz

# Install the OLD version, launch, wait 10s → UpdateBanner appears → Install → app relaunches at 1.0.1

# Force a crash
RUST_BACKTRACE=1 SENTRY_DSN=https://... pnpm tauri dev
# In the app, trigger a panic-inducing route
# Sentry dashboard: event arrives within ~5s, stacktrace present, no sk- strings anywhere
```

### Common pitfalls

- **The updater key is NOT the Apple Developer ID cert.** Two separate signatures: Apple cert signs the `.app` for Gatekeeper; Tauri ed25519 key signs the `.app.tar.gz` for the updater. Losing the ed25519 key = cannot ship updates to the fleet.
- **`installMode: passive` on Windows** requires the MSI to be signed by a cert trusted in the certificate store. Self-signed = UAC prompt every time. See prompt 05 for cert options.
- **Tauri updater expects `.app.tar.gz`, not `.dmg`, on macOS.** The bundler produces both; configure the manifest to point at the `.tar.gz`.
- **Sourcemap privacy.** Uploading sourcemaps to Sentry reveals your source layout to anyone with Sentry access. Either use a private Sentry org or set `hideSourceMaps: true` in the vite plugin.
- **PII in the HTTP request object.** Sentry's default `request` context includes the URL; our engine paths can include project names. Scrub `event.request.url` too.
- **Linux AppImage + updater.** Tauri AppImage updater works by swapping the entire AppImage file. Requires the user launched via an absolute path; some desktops launch via a `.desktop` file that may break the swap. Test on Ubuntu GNOME + KDE.
- **Semver pre-release tags.** `1.0.1-beta.2` should NOT be served to `1.0.0` stable users. Worker must filter by channel (add `?channel=stable|beta` to the URL, default stable).
- **R2 egress is free only within Cloudflare.** Binaries served from R2 to users are free egress; don't proxy through a non-R2 CDN or you'll pay twice.
- **Sentry rate-limit on crash loops.** If the app crashes on startup, it can emit 100 events in 30s. Add a local ring-buffer dedupe: don't send the same event fingerprint twice within 60s.
- **`panic::set_hook`** must run before any other panic-prone init. Call it before Tauri builder.
- **Auto-download on metered networks.** macOS/Windows have no standard API to detect metered. Default to "ask before downloading" on first install; add a "download on any network" toggle.

### Why this matters

Auto-update converts "ship once, hope it works" into a platform. Without it, every bug becomes a support email asking users to download a new DMG. Sentry converts silent user crashes into triaged issues with stacktraces — the difference between "the app crashes sometimes" and "fix line 247 of runMachine.ts". Ship neither and the desktop app has no path from v1.0.0 to v1.1.

---

## Session closeout

Paste `COMPLETION-UPDATE-TEMPLATE.md` with `<NN>=16`. Mark 16.04 complete. Phase 16 status 🔄. Commit `docs: phase 16.04 auto-update + sentry`. Next: `prompts/phase-16/05-cross-platform-builds.md`.
