# Phase 15 — Desktop App MVP — Prompt 01: Tauri 2 scaffolding

**When to run:** After Phase 14 (Observability) is marked ✅ in `COMPLETION-LOG.md` and Phase 10 (`jellyclaw serve`) is verifiably running (`bun run dev` exposes `/events/:id` + `/v1/health`).
**Estimated duration:** 4–6 hours
**New session?** Yes — start a fresh Claude Code session
**Model:** Claude Opus 4.6 (1M context)

---

## Session startup

Paste the contents of `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/STARTUP-TEMPLATE.md`, substituting `<NN>` with `15` and `<name>` with `desktop-mvp`.

---

## Research task

Before touching anything, deeply understand:

1. Read `/Users/gtrush/Downloads/jellyclaw-engine/phases/PHASE-15-desktop-mvp.md` end to end. Note the 6 MVP screens (Wish bar, Timeline, Tool inspector, Cost meter, Session history, Settings) — this prompt scaffolds the *shell only*, no screens yet.
2. Read `/Users/gtrush/Downloads/jellyclaw-engine/desktop/SPEC.md` — confirm stack (Tauri 2 + React 19 + Zustand + XState v5 + Tailwind v4 + Obsidian & Gold theme).
3. Read `/Users/gtrush/Downloads/jellyclaw-engine/MASTER-PLAN.md` §3 and §4 row 15.
4. Read `/Users/gtrush/Downloads/jellyclaw-engine/engine/SPEC.md` §10 (CLI + HTTP server) and §21 (integration path) — the engine exposes a CLI (`jellyclaw serve`), an HTTP server, and a library entry point; we will consume the HTTP server in prompt 02.
5. WebFetch Tauri 2 docs with `WebFetch`:
   - `https://v2.tauri.app/start/` — getting started (understand Tauri's `src-tauri/` + frontend split)
   - `https://v2.tauri.app/security/` — capability-based permissions (replaces v1's `allowlist`)
6. Resolve library IDs via `mcp__plugin_compound-engineering_context7__resolve-library-id` for `tauri-apps/tauri` and `vitejs/vite` and query the v2 init flow and Vite 6 + React 19 config.
7. Skim `/Users/gtrush/Downloads/jellyclaw-engine/prompts/phase-04/01-bash-read-write.md` for prompt-style conventions (headers, verification, common pitfalls).

## Implementation task

Initialize `desktop/` as a Tauri 2 workspace under the existing pnpm monorepo: React 19 + Vite 6 + Tailwind v4 + Biome + shared types from `@jellyclaw/shared`. Produce a working `pnpm tauri dev` that opens a 1280×800 window titled "Jellyclaw" showing a placeholder React shell. **No engine integration yet** (prompt 02). **No real UI yet** (prompt 04).

### Files to create/modify

- `/Users/gtrush/Downloads/jellyclaw-engine/desktop/package.json` — name `@jellyclaw/desktop`, private, scripts: `dev`, `build`, `tauri`, `lint`, `typecheck`
- `/Users/gtrush/Downloads/jellyclaw-engine/desktop/vite.config.ts` — React 19 plugin, Tailwind v4 vite plugin, port 1420 strictPort
- `/Users/gtrush/Downloads/jellyclaw-engine/desktop/tsconfig.json` — extends repo root, `target: ES2022`, `jsx: react-jsx`, path alias `@jellyclaw/shared`
- `/Users/gtrush/Downloads/jellyclaw-engine/desktop/index.html`
- `/Users/gtrush/Downloads/jellyclaw-engine/desktop/src/main.tsx` — React 19 `createRoot` + StrictMode
- `/Users/gtrush/Downloads/jellyclaw-engine/desktop/src/App.tsx` — placeholder "Jellyclaw — Phase 15.01" centered card
- `/Users/gtrush/Downloads/jellyclaw-engine/desktop/src/styles.css` — `@import "tailwindcss";` + `@theme` placeholder tokens
- `/Users/gtrush/Downloads/jellyclaw-engine/desktop/src-tauri/Cargo.toml` — tauri 2.x, tauri-build 2.x, serde, serde_json, tokio (full), log, thiserror, rand, anyhow
- `/Users/gtrush/Downloads/jellyclaw-engine/desktop/src-tauri/tauri.conf.json` — productName `Jellyclaw`, identifier `dev.jellyclaw.desktop`, window 1280×800 (min 960×600), devUrl `http://127.0.0.1:1420`, frontendDist `../dist`
- `/Users/gtrush/Downloads/jellyclaw-engine/desktop/src-tauri/src/main.rs` + `lib.rs` + `build.rs`
- `/Users/gtrush/Downloads/jellyclaw-engine/desktop/src-tauri/capabilities/default.json` — Tauri 2 capability for `main` window
- `/Users/gtrush/Downloads/jellyclaw-engine/desktop/biome.json` — extends repo root
- `/Users/gtrush/Downloads/jellyclaw-engine/desktop/.gitignore` — `dist/`, `src-tauri/target/`, `src-tauri/gen/`
- `/Users/gtrush/Downloads/jellyclaw-engine/pnpm-workspace.yaml` — append `desktop` if absent
- `/Users/gtrush/Downloads/jellyclaw-engine/package.json` root — add `"desktop:dev"` + `"desktop:build"` scripts
- `/Users/gtrush/Downloads/jellyclaw-engine/shared/src/events.ts` — if missing, copy the 15-event discriminated union from `engine/src/events/types.ts`

### Prerequisites check

```bash
# Rust toolchain
rustup show active-toolchain                          # expect "stable-*"
rustup component list --installed | grep -E 'rustfmt|clippy'
cargo --version                                       # expect 1.80+

# Tauri CLI 2.x
cargo install tauri-cli --version "^2.0" --locked
cargo tauri --version                                  # expect "tauri-cli 2.x"

# Node + pnpm
node --version                                         # expect v20+
corepack enable && corepack prepare pnpm@9 --activate
pnpm --version                                         # expect 9.x

# macOS-only: Xcode CLT for codesign
xcode-select -p || xcode-select --install
```

If any of the above fails, STOP and report to the user. Do not soldier on.

### Step-by-step implementation

1. **Create the workspace folder and scaffold Tauri 2.**

   ```bash
   cd /Users/gtrush/Downloads/jellyclaw-engine
   pnpm create tauri-app@latest desktop --template react-ts --identifier dev.jellyclaw.desktop --manager pnpm --yes
   ```

   The CLI scaffolds `desktop/src-tauri/` + `desktop/src/`. Verify `desktop/src-tauri/tauri.conf.json` exists.

2. **Register the workspace.**

   Append to `/Users/gtrush/Downloads/jellyclaw-engine/pnpm-workspace.yaml`:

   ```yaml
   packages:
     - engine
     - shared
     - desktop
   ```

   Root `package.json` add:

   ```json
   "scripts": {
     "desktop:dev":   "pnpm --filter @jellyclaw/desktop tauri dev",
     "desktop:build": "pnpm --filter @jellyclaw/desktop tauri build"
   }
   ```

3. **Install frontend deps (React 19 is now GA).**

   ```bash
   cd desktop
   pnpm add react@^19 react-dom@^19
   pnpm add zustand@^5 xstate@^5 @xstate/react@^5 @tanstack/react-query@^5
   pnpm add @microsoft/fetch-event-source@^2 react-virtuoso@^4 sonner@^1 shiki@^1
   pnpm add -D @types/react@^19 @types/react-dom@^19 @vitejs/plugin-react@^5 vite@^6
   pnpm add -D tailwindcss@^4 @tailwindcss/vite@^4 typescript@^5.6 @biomejs/biome@^1
   ```

4. **Write `desktop/vite.config.ts`:**

   ```ts
   import { defineConfig } from "vite";
   import react from "@vitejs/plugin-react";
   import tailwind from "@tailwindcss/vite";
   import path from "node:path";

   // https://v2.tauri.app/start/frontend/vite/
   export default defineConfig(async () => ({
     plugins: [react(), tailwind()],
     clearScreen: false,
     server: {
       port: 1420,
       strictPort: true,
       host: "127.0.0.1",
       hmr: { host: "127.0.0.1", port: 1421 },
       watch: { ignored: ["**/src-tauri/**"] },
     },
     resolve: {
       alias: {
         "@": path.resolve(__dirname, "src"),
         "@jellyclaw/shared": path.resolve(__dirname, "../shared/src"),
       },
     },
     envPrefix: ["VITE_", "TAURI_ENV_*"],
     build: { target: "es2022", sourcemap: true, outDir: "dist" },
   }));
   ```

5. **Write `desktop/src-tauri/tauri.conf.json` (Tauri 2 schema):**

   ```json
   {
     "$schema": "https://schema.tauri.app/config/2",
     "productName": "Jellyclaw",
     "version": "0.1.0",
     "identifier": "dev.jellyclaw.desktop",
     "build": {
       "beforeDevCommand": "pnpm dev",
       "beforeBuildCommand": "pnpm build",
       "devUrl": "http://127.0.0.1:1420",
       "frontendDist": "../dist"
     },
     "app": {
       "windows": [{
         "title": "Jellyclaw",
         "width": 1280, "height": 800,
         "minWidth": 960, "minHeight": 600,
         "resizable": true, "fullscreen": false,
         "theme": "Dark"
       }],
       "security": { "csp": "default-src 'self'; img-src 'self' data: asset: https://asset.localhost; style-src 'self' 'unsafe-inline'; connect-src 'self' http://127.0.0.1:* ipc: http://ipc.localhost" }
     },
     "bundle": {
       "active": true,
       "targets": ["dmg", "app", "deb", "rpm", "appimage", "msi"],
       "icon": ["icons/32x32.png","icons/128x128.png","icons/128x128@2x.png","icons/icon.icns","icons/icon.ico"],
       "category": "DeveloperTool",
       "shortDescription": "Local Claude-Code replacement",
       "macOS": { "minimumSystemVersion": "12.0" }
     }
   }
   ```

6. **Write `desktop/src-tauri/capabilities/default.json`:**

   ```json
   {
     "$schema": "../gen/schemas/desktop-schema.json",
     "identifier": "default",
     "description": "Capabilities for the main window",
     "windows": ["main"],
     "permissions": [
       "core:default",
       "core:window:default",
       "core:app:default",
       "core:event:default",
       "core:path:default"
     ]
   }
   ```

   (The `http`, `shell`, and custom-command permissions arrive in prompt 02.)

7. **`src-tauri/Cargo.toml` dependencies:**

   ```toml
   [package]
   name = "jellyclaw-desktop"
   version = "0.1.0"
   edition = "2021"
   rust-version = "1.77"

   [build-dependencies]
   tauri-build = { version = "2", features = [] }

   [dependencies]
   tauri = { version = "2", features = [] }
   serde = { version = "1", features = ["derive"] }
   serde_json = "1"
   tokio = { version = "1", features = ["full"] }
   log = "0.4"
   env_logger = "0.11"
   thiserror = "1"
   anyhow = "1"
   rand = "0.8"
   ```

8. **`src-tauri/src/lib.rs` + `main.rs`** — minimal bootstrap. See snippets below.

9. **`desktop/src/main.tsx` + `App.tsx`** — React 19 placeholder.

10. **Run it.**

    ```bash
    cd /Users/gtrush/Downloads/jellyclaw-engine/desktop
    pnpm tauri dev
    ```

    A 1280×800 window titled "Jellyclaw" should open with the placeholder card.

### Key code

`desktop/src-tauri/src/lib.rs`:

```rust
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init_from_env(env_logger::Env::default().default_filter_or("info"));
    log::info!("jellyclaw-desktop booting (phase 15.01)");

    tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::new().build())
        .setup(|_app| Ok(()))
        .run(tauri::generate_context!())
        .expect("error while running jellyclaw-desktop");
}
```

`desktop/src-tauri/src/main.rs`:

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
fn main() { jellyclaw_desktop_lib::run(); }
```

`desktop/src/main.tsx`:

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode><App /></StrictMode>,
);
```

`desktop/src/App.tsx`:

```tsx
export default function App() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-[#050505] text-[#e8e6e1] font-sans">
      <div className="rounded-xl border border-[rgba(146,132,102,0.2)] bg-[rgba(15,15,15,0.6)] backdrop-blur-2xl px-10 py-8">
        <h1 className="text-2xl font-light tracking-wide text-[#928466]">Jellyclaw</h1>
        <p className="mt-2 text-sm text-[#6b6760]">Phase 15.01 — Tauri 2 shell boot OK</p>
      </div>
    </div>
  );
}
```

`desktop/src/styles.css`:

```css
@import "tailwindcss";
@theme {
  --color-bg: #050505;
  --color-gold: #928466;
  --color-text: #e8e6e1;
  --color-text-muted: #6b6760;
}
html, body, #root { height: 100%; background: var(--color-bg); }
```

### Tests to add

- `desktop/src-tauri/src/lib.rs` — add a `#[test] fn smoke_build() { /* compile-time only */ }`
- CI smoke: `pnpm tauri info` exits 0 — add as a `desktop:check` script

### Verification

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine/desktop

pnpm tauri info
# Expect:  [✔] Environment  Rust / Node / Tauri CLI 2.x

pnpm typecheck      # tsc --noEmit → 0 errors
pnpm lint           # biome check → 0 errors
pnpm tauri dev &
sleep 15
pgrep -f "jellyclaw-desktop" && echo "window OK"
# Kill it: pkill -f jellyclaw-desktop
```

Manual: a native 1280×800 window titled "Jellyclaw" opens; placeholder card renders; DevTools (Cmd+Opt+I in dev) show no CSP errors.

### Common pitfalls

- **Tauri v1 vs v2 config drift.** If you see `"allowlist"` in `tauri.conf.json`, you grabbed a v1 template — that key was replaced by capabilities. Regenerate with `--template react-ts` against CLI `2.x`.
- **Port 1420 collision.** If another Vite process owns 1420, Tauri will hang. `lsof -i :1420` then kill.
- **pnpm workspace hoisting with Tauri CLI.** `cargo tauri` doesn't see pnpm's `node_modules` unless `desktop/` has its own `package.json`. Always scope frontend commands via `pnpm --filter @jellyclaw/desktop`.
- **React 19 StrictMode double-renders** will double-invoke effects in dev. Fine here but plan for it in prompt 03 (SSE subscription must be idempotent).
- **Tailwind v4 has no `tailwind.config.js` by default** — tokens live in `@theme` inside `styles.css`. Don't create a config file or you'll fight the vite plugin.

### Why this matters

This is the foundation every other prompt in phase 15 builds on: without a working Tauri 2 shell, there is nowhere to host the engine process (prompt 02), the SSE consumer (prompt 03), the UI (prompt 04), or the signed DMG (prompt 05). Getting the Tauri 2 capability model right *now* saves painful rewrites later when we add `shell:allow-execute` and custom command permissions.

---

## Session closeout

Paste the contents of `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/COMPLETION-UPDATE-TEMPLATE.md`, substituting `<NN>` with `15` and the sub-prompt name with `01-tauri-2-scaffolding`.

Only the FINAL prompt of Phase 15 (`05-macos-dmg-build-and-sign.md`) marks the phase ✅. This prompt updates the Notes field with `01-tauri-2-scaffolding ✅`.
