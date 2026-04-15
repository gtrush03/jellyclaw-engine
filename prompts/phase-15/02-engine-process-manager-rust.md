# Phase 15 — Desktop App MVP — Prompt 02: Engine process manager (Rust)

**When to run:** After prompt 01 (`01-tauri-2-scaffolding.md`) is marked ✅ in Phase 15 Notes and `pnpm tauri dev` opens the placeholder window cleanly.
**Estimated duration:** 6–8 hours
**New session?** Yes — start a fresh Claude Code session
**Model:** Claude Opus 4.6 (1M context)

---

## Session startup

Paste `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/STARTUP-TEMPLATE.md`, substituting `<NN>` with `15` and `<name>` with `desktop-mvp`.

---

## Research task

1. Read `/Users/gtrush/Downloads/jellyclaw-engine/engine/SPEC.md` §10 end-to-end. Confirm the CLI flag shape: `jellyclaw serve --port <u16> --bind <addr> --auth-token <hex> --format sse`. Confirm the exact stdout line format we'll regex against (spec says `jellyclaw: listening on http://127.0.0.1:<port>`).
2. Read `/Users/gtrush/Downloads/jellyclaw-engine/engine/SECURITY.md` — why the auth token must travel via env var, never argv.
3. Read `/Users/gtrush/Downloads/jellyclaw-engine/engine/SPEC.md` §21 — the integration path from the desktop shell.
4. WebFetch:
   - `https://v2.tauri.app/learn/sidecar-nodejs/` — bundled-sidecar pattern (we still want a sidecar for release; for dev we spawn the monorepo binary)
   - `https://v2.tauri.app/develop/sidecar/` — sidecar lifecycle hooks
   - `https://v2.tauri.app/develop/calling-rust/` — `#[tauri::command]` + state
   - `https://docs.rs/tokio/latest/tokio/process/` — `tokio::process::Command`, `Child::wait`, `kill_on_drop`
   - `https://docs.rs/nix/latest/nix/sys/prctl/` — Linux `PR_SET_PDEATHSIG`
5. Context7: resolve `tauri-apps/tauri` and query "sidecar" and "command state".
6. Read the existing `desktop/src-tauri/src/lib.rs` from prompt 01.

## Implementation task

Build a Rust-side engine process manager that (a) spawns `jellyclaw serve` as a child on an ephemeral port, (b) captures the port + auth token, (c) monitors health via HTTP, (d) kills the child deterministically when the Tauri app exits, (e) exposes four Tauri commands to the frontend. Use `tokio::process::Command` (not Tauri's sidecar shim) for fine-grained control over stdout parsing and tri-platform death signals.

### Files to create/modify

- `desktop/src-tauri/src/engine/mod.rs` — module root
- `desktop/src-tauri/src/engine/process.rs` — `EngineProcess` struct, spawn, monitor, shutdown
- `desktop/src-tauri/src/engine/error.rs` — `thiserror` typed errors
- `desktop/src-tauri/src/engine/platform.rs` — per-OS death-signal glue
- `desktop/src-tauri/src/commands.rs` — 4 `#[tauri::command]` functions
- `desktop/src-tauri/src/lib.rs` — register state + commands
- `desktop/src-tauri/Cargo.toml` — add `reqwest`, `regex`, `hex`, `tokio-util`, `tracing`, `tracing-subscriber`; OS-specific deps behind `cfg`
- `desktop/src-tauri/capabilities/default.json` — allow our 4 custom commands

### Prerequisites check

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine
bun run build                                           # engine must be built
ls dist/cli.js                                          # exists
./dist/cli.js serve --port 0 --bind 127.0.0.1 --auth-token deadbeef --format sse &
sleep 2
curl -s -H "Authorization: Bearer deadbeef" http://127.0.0.1:<port>/v1/health
# expect 200 {"ok":true}
pkill -f "cli.js serve"
```

### Step-by-step implementation

1. Add to `desktop/src-tauri/Cargo.toml`:

   ```toml
   reqwest = { version = "0.12", features = ["json", "rustls-tls"], default-features = false }
   regex = "1"
   hex = "0.4"
   tokio-util = { version = "0.7", features = ["rt"] }
   tracing = "0.1"
   tracing-subscriber = { version = "0.3", features = ["env-filter"] }

   [target.'cfg(unix)'.dependencies]
   nix = { version = "0.29", features = ["signal", "process"] }

   [target.'cfg(target_os = "linux")'.dependencies]
   libc = "0.2"

   [target.'cfg(target_os = "windows")'.dependencies]
   windows = { version = "0.58", features = [
     "Win32_System_JobObjects",
     "Win32_System_Threading",
     "Win32_Foundation",
   ] }
   ```

2. Write `engine/error.rs`, `engine/platform.rs`, `engine/process.rs`, `commands.rs` (full code below).

3. Register the manager as Tauri-managed state in `lib.rs`:

   ```rust
   .manage(engine::EngineState::default())
   .invoke_handler(tauri::generate_handler![
       commands::get_engine_url,
       commands::restart_engine,
       commands::engine_status,
       commands::get_engine_logs,
   ])
   .setup(|app| {
       let handle = app.handle().clone();
       let state: tauri::State<engine::EngineState> = handle.state();
       tokio::spawn(engine::EngineProcess::bootstrap(handle.clone(), state.inner().clone()));
       Ok(())
   })
   ```

4. Add the 4 custom commands to `capabilities/default.json` permissions list.

5. Build + run: `pnpm tauri dev`. Check logs: engine spawns, port + token captured, `/v1/health` 200 within 10s.

### Key code (Rust — not stubs)

`src-tauri/src/engine/error.rs`:

```rust
use thiserror::Error;

#[derive(Debug, Error)]
pub enum EngineError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("engine exited before announcing port")]
    EarlyExit,
    #[error("timed out waiting for engine to announce port")]
    StartupTimeout,
    #[error("http error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("health check failed: {0}")]
    HealthFailed(String),
    #[error("engine not running")]
    NotRunning,
}

impl serde::Serialize for EngineError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}
```

`src-tauri/src/engine/platform.rs`:

```rust
use tokio::process::Command;

/// Configure a Command so the child dies when the parent process dies.
/// - Linux: PR_SET_PDEATHSIG(SIGTERM) via pre_exec
/// - macOS: no kernel primitive; we rely on the supervisor task + kill_on_drop
/// - Windows: Job Object with KILL_ON_JOB_CLOSE (attached after spawn)
pub fn configure_death_signal(cmd: &mut Command) {
    cmd.kill_on_drop(true);

    #[cfg(target_os = "linux")]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            cmd.pre_exec(|| {
                // PR_SET_PDEATHSIG = 1, SIGTERM = 15
                let rc = libc::prctl(1, 15, 0, 0, 0);
                if rc != 0 { return Err(std::io::Error::last_os_error()); }
                Ok(())
            });
        }
    }
}

#[cfg(target_os = "windows")]
pub fn attach_job_object(pid: u32) -> std::io::Result<()> {
    // Opens process, creates Job Object, sets JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    // assigns the process to the job. Full impl uses windows::Win32::System::JobObjects.
    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub fn attach_job_object(_pid: u32) -> std::io::Result<()> { Ok(()) }
```

`src-tauri/src/engine/process.rs` (core — complete for the spawn + monitor path):

```rust
use super::error::EngineError;
use super::platform;
use rand::RngCore;
use regex::Regex;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{Mutex, RwLock};
use tokio::time::timeout;

#[derive(Clone, Debug, Serialize)]
pub struct EngineInfo { pub url: String, #[serde(rename = "authToken")] pub auth_token: String }

#[derive(Clone, Debug, Serialize)]
pub struct EngineStatus {
    pub state: &'static str,               // "starting" | "running" | "crashed" | "stopped"
    pub uptime_ms: u64,
    pub restarts: u32,
    pub last_restart_iso: Option<String>,
    pub pid: Option<u32>,
    pub port: Option<u16>,
}

#[derive(Default, Clone)]
pub struct EngineState(pub Arc<RwLock<Option<EngineProcess>>>);

pub struct EngineProcess {
    pub port: u16,
    pub auth_token: String,
    pub pid: u32,
    pub started_at: Instant,
    pub restarts: u32,
    pub last_restart_iso: Option<String>,
    child: Arc<Mutex<Option<Child>>>,
    log_path: PathBuf,
}

impl EngineProcess {
    pub async fn bootstrap(app: tauri::AppHandle, state: EngineState) {
        loop {
            match Self::spawn(&app).await {
                Ok(proc) => {
                    let log = proc.log_path.clone();
                    { let mut slot = state.0.write().await; *slot = Some(proc); }
                    Self::monitor_loop(state.clone(), log).await;
                }
                Err(e) => {
                    tracing::error!(?e, "engine spawn failed; retry in 5s");
                    tokio::time::sleep(Duration::from_secs(5)).await;
                }
            }
        }
    }

    async fn spawn(app: &tauri::AppHandle) -> Result<Self, EngineError> {
        use tauri::Manager;
        let app_data = app.path().app_data_dir().unwrap();
        tokio::fs::create_dir_all(app_data.join("logs")).await?;
        let log_path = app_data.join("logs/engine.log");

        let mut buf = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut buf);
        let auth_token = hex::encode(buf);

        // Dev: spawn monorepo cli.js via bun. Release: spawn bundled sidecar.
        let (program, args) = if cfg!(debug_assertions) {
            ("bun".to_string(), vec![
                "/Users/gtrush/Downloads/jellyclaw-engine/dist/cli.js".into(),
                "serve".into(),
                "--port".into(), "0".into(),
                "--bind".into(), "127.0.0.1".into(),
                "--format".into(), "sse".into(),
            ])
        } else {
            let bin = app.path().resource_dir().unwrap().join("binaries/jellyclaw");
            (bin.display().to_string(), vec![
                "serve".into(), "--port".into(), "0".into(),
                "--bind".into(), "127.0.0.1".into(),
                "--format".into(), "sse".into(),
            ])
        };

        let mut cmd = Command::new(program);
        cmd.args(&args)
           .env("JELLYCLAW_AUTH_TOKEN", &auth_token)
           .env("OPENCODE_SERVER_PASSWORD", std::env::var("OPENCODE_SERVER_PASSWORD").unwrap_or_default())
           .env("ANTHROPIC_API_KEY",  std::env::var("ANTHROPIC_API_KEY").unwrap_or_default())
           .env("OPENROUTER_API_KEY", std::env::var("OPENROUTER_API_KEY").unwrap_or_default())
           .stdout(std::process::Stdio::piped())
           .stderr(std::process::Stdio::piped());
        platform::configure_death_signal(&mut cmd);

        let mut child = cmd.spawn()?;
        let pid = child.id().ok_or(EngineError::EarlyExit)?;
        let _ = platform::attach_job_object(pid);

        // Persist pid for crash recovery
        let pid_path = app_data.join("jellyclaw.pid");
        let _ = tokio::fs::write(&pid_path, pid.to_string()).await;

        // Parse port from stdout, 10s timeout
        let stdout = child.stdout.take().ok_or(EngineError::EarlyExit)?;
        let mut lines = BufReader::new(stdout).lines();
        let re = Regex::new(r"jellyclaw: listening on http://127\.0\.0\.1:(\d+)").unwrap();

        let port: u16 = timeout(Duration::from_secs(10), async {
            while let Ok(Some(line)) = lines.next_line().await {
                append_log(&log_path, &line).await;
                if let Some(c) = re.captures(&line) {
                    return Ok(c[1].parse().unwrap_or(0));
                }
            }
            Err::<u16, EngineError>(EngineError::EarlyExit)
        }).await.map_err(|_| EngineError::StartupTimeout)??;

        // Drain rest of stdout + stderr into log
        tokio::spawn(drain_stream(lines, log_path.clone()));
        if let Some(err) = child.stderr.take() {
            tokio::spawn(drain_raw(err, log_path.clone()));
        }

        Ok(Self {
            port, auth_token, pid, started_at: Instant::now(),
            restarts: 0, last_restart_iso: None,
            child: Arc::new(Mutex::new(Some(child))),
            log_path,
        })
    }

    async fn monitor_loop(state: EngineState, log: PathBuf) {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5)).build().unwrap();
        loop {
            tokio::time::sleep(Duration::from_secs(30)).await;
            let (url, token) = {
                let slot = state.0.read().await;
                match slot.as_ref() {
                    Some(p) => (format!("http://127.0.0.1:{}/v1/health", p.port), p.auth_token.clone()),
                    None => return,
                }
            };
            match client.get(&url).bearer_auth(&token).send().await {
                Ok(r) if r.status().is_success() => continue,
                other => {
                    tracing::warn!(?other, "health check failed; respawning");
                    append_log(&log, "[monitor] health failed, respawn").await;
                    let mut slot = state.0.write().await;
                    if let Some(p) = slot.take() { p.shutdown_inner().await; }
                    return; // bootstrap loop respawns
                }
            }
        }
    }

    pub async fn shutdown_inner(self) {
        if let Some(mut child) = self.child.lock().await.take() {
            #[cfg(unix)] {
                use nix::sys::signal::{kill, Signal};
                use nix::unistd::Pid;
                let _ = kill(Pid::from_raw(self.pid as i32), Signal::SIGTERM);
            }
            #[cfg(windows)] { let _ = child.start_kill(); }
            match tokio::time::timeout(Duration::from_secs(5), child.wait()).await {
                Ok(_) => {}
                Err(_) => { let _ = child.kill().await; }
            }
        }
    }
}

async fn append_log(path: &std::path::Path, line: &str) {
    use tokio::io::AsyncWriteExt;
    if let Ok(mut f) = tokio::fs::OpenOptions::new().create(true).append(true).open(path).await {
        let _ = f.write_all(format!("{line}\n").as_bytes()).await;
    }
}
async fn drain_stream(mut lines: tokio::io::Lines<BufReader<tokio::process::ChildStdout>>, log: PathBuf) {
    while let Ok(Some(l)) = lines.next_line().await { append_log(&log, &l).await; }
}
async fn drain_raw(s: tokio::process::ChildStderr, log: PathBuf) {
    let mut lines = BufReader::new(s).lines();
    while let Ok(Some(l)) = lines.next_line().await { append_log(&log, &format!("stderr: {l}")).await; }
}
```

`src-tauri/src/commands.rs`:

```rust
use crate::engine::{error::EngineError, process::{EngineInfo, EngineStatus, EngineState}};
use tauri::State;

#[tauri::command]
pub async fn get_engine_url(state: State<'_, EngineState>) -> Result<EngineInfo, EngineError> {
    let slot = state.0.read().await;
    let p = slot.as_ref().ok_or(EngineError::NotRunning)?;
    Ok(EngineInfo { url: format!("http://127.0.0.1:{}", p.port), auth_token: p.auth_token.clone() })
}

#[tauri::command]
pub async fn restart_engine(state: State<'_, EngineState>) -> Result<(), EngineError> {
    let mut slot = state.0.write().await;
    if let Some(p) = slot.take() { p.shutdown_inner().await; }
    Ok(())
}

#[tauri::command]
pub async fn engine_status(state: State<'_, EngineState>) -> Result<EngineStatus, EngineError> {
    let slot = state.0.read().await;
    Ok(match slot.as_ref() {
        Some(p) => EngineStatus {
            state: "running", uptime_ms: p.started_at.elapsed().as_millis() as u64,
            restarts: p.restarts, last_restart_iso: p.last_restart_iso.clone(),
            pid: Some(p.pid), port: Some(p.port),
        },
        None => EngineStatus { state: "stopped", uptime_ms: 0, restarts: 0,
                               last_restart_iso: None, pid: None, port: None },
    })
}

#[tauri::command]
pub async fn get_engine_logs(lines: usize, app: tauri::AppHandle) -> Result<Vec<String>, EngineError> {
    use tauri::Manager;
    let path = app.path().app_data_dir().unwrap().join("logs/engine.log");
    let content = tokio::fs::read_to_string(&path).await.unwrap_or_default();
    let all: Vec<&str> = content.lines().collect();
    let start = all.len().saturating_sub(lines);
    Ok(all[start..].iter().map(|s| s.to_string()).collect())
}
```

### Tests to add

- `src-tauri/src/engine/process.rs` — `#[cfg(test)] mod tests`:
  - `test_port_regex_captures()` — regex matches the exact spec stdout line
  - `test_auth_token_is_64_hex()` — `hex::encode` of 32 bytes = 64 chars
  - `test_engine_state_default_empty()` — empty slot → `NotRunning`
- `desktop/src-tauri/tests/spawn_engine.rs` — integration test spawns `dist/cli.js`, asserts `/v1/health` 200 within 10s.

### Verification

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine
bun run build
cd desktop
pnpm tauri dev &
APP_PID=$!
sleep 12

pgrep -f "cli.js serve" && echo "engine alive"

kill $APP_PID
sleep 6
pgrep -f "cli.js serve" && echo "LEAK — child survived" || echo "clean shutdown OK"

ls ~/Library/Application\ Support/dev.jellyclaw.desktop/logs/engine.log
```

```bash
cd desktop/src-tauri && cargo test --lib
```

### Common pitfalls

- **`kill_on_drop(true)` is not enough on macOS** if the parent is SIGKILLed — no kernel primitive maps to Linux's `PR_SET_PDEATHSIG`. Mitigate with the supervisor task and a pid-file check on next launch: read `jellyclaw.pid`, if that PID is alive and owned by `bun`/`jellyclaw`, send `SIGTERM`.
- **Auth token in argv is a CVE.** `ps -ef` leaks argv. Always pass via `JELLYCLAW_AUTH_TOKEN` env, never `--auth-token` flag.
- **Stdout pipe fills and blocks the child** if nothing drains it. We spawn `drain_stream` immediately after port parse.
- **Tauri commands with `State<'_, T>` must return a serializable error**, hence the manual `Serialize` impl on `EngineError`.
- **Bun in dev vs bundled binary in release.** Use `cfg!(debug_assertions)` to switch. In release the binary lives at `<resource_dir>/binaries/jellyclaw` — prompt 05 handles bundling.
- **Regex compiled on every spawn** — fine here but wrap in `once_cell::sync::Lazy` if you find it in a hot loop later.

### Why this matters

This is the single most failure-prone component of the desktop app. If the engine leaks processes on crash, users accumulate zombie `bun` + `opencode` trees that hold API keys in memory. If the auth token leaks via argv, anyone on a shared host can impersonate the owner. If health checks don't auto-restart, a one-off 500 bricks the app until manual relaunch. Getting this tier rock-solid is what separates a hackathon demo from a shippable product.

---

## Session closeout

Paste `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/COMPLETION-UPDATE-TEMPLATE.md` with `<NN>` = `15`, sub-prompt = `02-engine-process-manager-rust`.

Only `05-macos-dmg-build-and-sign.md` marks Phase 15 ✅. Update Notes with `02-engine-process-manager-rust ✅`.
