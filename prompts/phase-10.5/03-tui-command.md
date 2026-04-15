# Phase 10.5 — Interactive TUI — Prompt 03: `jellyclaw tui` subcommand (wire TUI → engine server)

**When to run:** After Phase 10.5 prompts 01 (vendored TUI) AND 02 (jellyfish theme) are both ✅ in `COMPLETION-LOG.md`.
**Estimated duration:** 90 minutes
**New session?** Yes — always start a fresh Claude Code session per prompt
**Model:** Claude Opus 4.6 (1M context)

<!-- BEGIN: paste from /Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/STARTUP-TEMPLATE.md -->
<!-- STOP if 10.5.01 or 10.5.02 are not fully ✅ in COMPLETION-LOG.md. The TUI source and the jellyfish theme tokens MUST both be landed before this prompt runs — this prompt only wires them into a subcommand. -->
<!-- END paste -->

## Research task

Read **in full** before writing any code:

1. `/Users/gtrush/Downloads/jellyclaw-engine/prompts/phase-10/03-library-api.md` — shape template for this prompt (section order, verification layout, pitfalls section density).
2. `/Users/gtrush/Downloads/jellyclaw-engine/prompts/phase-10/01-cli-entry-point.md` — how existing CLI subcommands are wired: Commander, lazy-loaded action modules, thin handlers that delegate to engine code, `process.exit` only in `main.ts`.
3. `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/cli/main.ts` — the Commander router. You will add exactly one subcommand registration here, following the pattern already used by `serve`, `run`, `resume`, `continue`.
4. `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/cli/serve.ts` — **reference implementation**. Study `createServeAction`, `productionDeps`, the signal handling, the auth-token resolution, and how it spawns the HTTP server. Your `tui` subcommand spawns the SAME server via the SAME helpers — do NOT duplicate this code. Extract a shared helper if necessary.
5. `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/server/app.ts` — `createApp` / `createServer` shapes; these are what you spawn in-process for the TUI to talk to.
6. `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/tui/app.tsx` — landed by 10.5.01. Exports `renderTui({ baseUrl, password, initialSession?, cwd, theme?, ascii?, noColor? })`. If the signature differs, use the one that's actually landed (don't invent flags).
7. `/Users/gtrush/Downloads/jellyclaw-engine/docs/cli.md` — doc format you will extend. Match the shape of the `run` and `serve` sections byte-for-byte.
8. `/Users/gtrush/Downloads/jellyclaw-engine/docs/library.md` — add a one-line note that the TUI is the 4th consumer of `createEngine()`.
9. `/Users/gtrush/Downloads/jellyclaw-engine/engine/CLAUDE.md` — coding conventions. Re-read items 3 (`process.exit` only in `main.ts`), 7 (secrets redaction), 9 (one public export per module).

## Implementation task

Ship the `jellyclaw tui` subcommand. After 10.5.01 (vendored TUI) and 10.5.02 (jellyfish theme), a user typing `jellyclaw tui` gets a Claude-Code-like interactive terminal backed by the engine's HTTP server running in-process.

### Flow (authoritative)

1. User runs `jellyclaw tui [--cwd .] [--model …] [--resume <id>] [--continue] [--config-dir …]`.
2. The subcommand spawns the engine HTTP server on `127.0.0.1:<random-free-port>` with a freshly-minted bearer password. **Reuse Phase 10.02's server startup path — do NOT duplicate.** If `serve.ts` does not already export a reusable `startServer()`-style helper, extract it into a new module `engine/src/cli/shared/spawn-server.ts` and have both `serve.ts` and `tui.ts` consume it.
3. Wait for the server's `/healthz` endpoint to return 200 (with a 10 s timeout; fail fast with a typed error if the server never comes up).
4. Boot the vendored TUI by calling `renderTui({ baseUrl, password, initialSession?, cwd, theme: "jellyfish", ascii, noColor })` from `engine/src/tui/app.tsx`.
5. On TUI exit — user types `/exit`, presses Ctrl-D, or the process receives SIGINT/SIGTERM — stop the server gracefully: drain in-flight runs for up to 5 s, then SIGTERM any OpenCode child, then close SQLite with a WAL checkpoint.
6. Exit with the correct code: `0` on clean exit, `1` on crash/uncaught exception, `130` on SIGINT (128 + 2), `143` on SIGTERM (128 + 15).

### Files to create/modify (exhaustive)

**Create:**

- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/cli/tui.ts` — the subcommand action handler. Thin, lazy-loaded per existing convention. Exports `tuiAction(options: TuiCliOptions): Promise<number>` and `createTuiAction(deps: TuiActionDeps)` for DI-friendly testing, mirroring `serve.ts`'s `createServeAction` / `serveAction` split.
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/cli/shared/spawn-server.ts` — **only if `serve.ts` doesn't already expose the needed helpers**. Exports `spawnEmbeddedServer({ host?, port?, authToken?, verbose, logger?, sessionPaths? }): Promise<{ baseUrl: string; password: string; stop(grace?: number): Promise<void> }>`. `serve.ts` refactors to consume this (behavior preserved; snapshot tests still pass).
- `/Users/gtrush/Downloads/jellyclaw-engine/test/cli/tui-spawn.test.ts` — smoke: spawn `jellyclaw tui` via `child_process.spawn`, wait for bootstrap banner, send `/exit\n` to stdin, assert exit 0 and no leftover listener on the random port.
- `/Users/gtrush/Downloads/jellyclaw-engine/test/cli/tui-ctrl-c.test.ts` — SIGINT path: spawn, wait for bootstrap, send SIGINT, assert exit code 130 and `lsof`-equivalent shows no lingering listener.
- `/Users/gtrush/Downloads/jellyclaw-engine/test/cli/tui-crash.test.ts` — TUI crash path: monkey-patch `renderTui` to throw mid-session (via a test-only env flag), assert the server is still stopped within 10 s, SQLite WAL is checkpointed, exit code is 1.
- `/Users/gtrush/Downloads/jellyclaw-engine/test/cli/tui-flags.test.ts` — pure flag-parsing test: assert `--cwd`, `--model`, `--provider`, `--config-dir`, `--resume`, `--continue`, `--no-color`, `--ascii`, `--verbose` all normalise correctly; assert `--resume` and `--continue` are mutually exclusive (same rule as `run`).

**Modify:**

- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/cli/main.ts` — add ONE `.command("tui")` registration. Follow the `serve` block's shape: `.option(...)` chain, `.action(async (options) => { const { tuiAction } = await import("./tui.js"); const code = await tuiAction(options); if (code !== 0) throw new ExitError(code); })`. Lazy-loaded.
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/cli/serve.ts` — if `shared/spawn-server.ts` is extracted, refactor `serveAction` to consume it. No behavior change. Keep the non-loopback banner and auth-token precedence logic unchanged.
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/bin/jellyclaw` — no change expected (the shim dispatches to `dist/cli/main.js`), but verify `./engine/bin/jellyclaw tui --help` works post-build. If the shim has hard-coded subcommand allowlist logic (it shouldn't), update it.
- `/Users/gtrush/Downloads/jellyclaw-engine/docs/cli.md` — append a `tui` section that matches the shape of the `run` section: one-line summary, full flag table, ASCII demo of the opening frame (copy from 10.5.01's acceptance screenshot), a "what does it spawn internally" paragraph, and a troubleshooting block for Windows and non-TTY stdin.
- `/Users/gtrush/Downloads/jellyclaw-engine/docs/library.md` — add a single line under "Consumers" noting the TUI is the 4th consumer of `createEngine()` (alongside CLI `run`, HTTP `serve`, and external library users). No new section — just the line.
- `/Users/gtrush/Downloads/jellyclaw-engine/COMPLETION-LOG.md` — mark 10.5.03 ✅. **Do NOT flip Phase 10.5 to ✅ yet — that is prompt 10.5.04's job (docs sweep + final verification).**
- `/Users/gtrush/Downloads/jellyclaw-engine/STATUS.md` — note 10.5.03 complete; next is prompt 10.5.04.

### Flag set for `jellyclaw tui`

```
jellyclaw tui
  --cwd <path>                  # run-as-if cwd (default: process.cwd())
  --model <id>                  # provider-agnostic model id; passed to engine
  --provider <primary|secondary>
  --config-dir <path>           # override config dir (default: ~/.jellyclaw)
  --resume <id>                 # rehydrate a session by id (conflicts with --continue)
  --continue                    # resume newest session for this project
  --no-color                    # disable ANSI colors (propagates to theme + spinner)
  --ascii                       # ASCII-only spinner/glyphs (unicode → ASCII fallback)
  --verbose                     # verbose logging to stderr (never stdout — stdout is the TTY canvas)
```

All flags are optional. `tui` with no args opens a blank session in the current cwd using the configured default model.

Flags propagate to the TUI via:
- Initial `TuiConfig` (passed directly to `renderTui`): `cwd`, `noColor`, `ascii`, `theme: "jellyfish"`.
- Query params on the first `POST /runs` call: `model`, `provider`, `resume`, `continue`.
- The spawned server inherits `--verbose` → its logger level becomes `debug`.

### `TuiCliOptions` (after Commander camelCase normalisation)

```ts
export interface TuiCliOptions {
  readonly cwd?: string;
  readonly model?: string;
  readonly provider?: "primary" | "secondary";
  readonly configDir?: string;
  readonly resume?: string;
  readonly continue?: boolean;
  readonly color?: boolean;   // `--no-color` → `color: false`; `undefined` → auto-detect
  readonly ascii?: boolean;
  readonly verbose?: boolean;
}
```

### `createTuiAction` contract (DI-friendly; mirror `createServeAction`)

```ts
export interface TuiActionDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly stdin: NodeJS.ReadableStream & { isTTY?: boolean };
  readonly spawnServer: typeof spawnEmbeddedServer;        // from shared/spawn-server.ts
  readonly renderTui: typeof renderTui;                     // from tui/app.tsx
  readonly waitForHealth: (baseUrl: string, token: string, timeoutMs: number) => Promise<void>;
  readonly onSignal: (signal: "SIGINT" | "SIGTERM", handler: () => void) => () => void;
  readonly createLogger: typeof createLogger;
  readonly version: string;
}

export function createTuiAction(
  deps: TuiActionDeps,
): (options: TuiCliOptions) => Promise<number>;
```

### Teardown protocol

Use a single `AbortController` as the shutdown bus. All exit paths (clean, signal, crash) converge on the same `finally` block.

```ts
const shutdown = new AbortController();
let receivedSignal: "SIGINT" | "SIGTERM" | null = null;
let crashErr: unknown = null;

// Ctrl-C / SIGTERM → abort the bus
const offSigint  = deps.onSignal("SIGINT",  () => { receivedSignal = "SIGINT";  shutdown.abort(); });
const offSigterm = deps.onSignal("SIGTERM", () => { receivedSignal = "SIGTERM"; shutdown.abort(); });

// Raw mode BEFORE the TUI mounts (so the first keypress is captured correctly).
enterRawMode(deps.stdin);
hideCursor(deps.stderr);
enableBracketedPaste(deps.stderr);

// Paint the bootstrap spinner immediately so the user sees motion within 50 ms.
const spinner = startSpinner({ stream: deps.stderr, ascii, noColor, text: "starting jellyclaw…" });

let serverHandle: { baseUrl: string; password: string; stop(grace?: number): Promise<void> } | null = null;
try {
  serverHandle = await deps.spawnServer({
    host: "127.0.0.1",
    port: 0,                 // OS-assigned free port
    verbose,
    logger,
    sessionPaths,
  });
  await deps.waitForHealth(serverHandle.baseUrl, serverHandle.password, 10_000);
  spinner.stop();

  // TUI unmount (user types /exit or Ctrl-D) → abort the bus via onExit.
  const tuiExited = deps.renderTui({
    baseUrl: serverHandle.baseUrl,
    password: serverHandle.password,
    initialSession: resumeSessionId,
    cwd,
    theme: "jellyfish",
    ascii,
    noColor,
    signal: shutdown.signal,
    onExit: () => shutdown.abort(),
  });

  await tuiExited;
} catch (err) {
  crashErr = err;
} finally {
  spinner.stop();
  offSigint();
  offSigterm();
  // Drain in-flight runs (5 s grace), SIGTERM OpenCode child, WAL-checkpoint SQLite.
  if (serverHandle) {
    try { await serverHandle.stop(5_000); } catch (stopErr) {
      logger.error({ err: stopErr }, "server.stop threw during teardown");
    }
  }
  restoreTty(deps.stdin, deps.stderr);
}

// Exit-code selection
if (crashErr) {
  const msg = crashErr instanceof Error ? crashErr.message : String(crashErr);
  deps.stderr.write(`jellyclaw tui: ${msg}\n`);
  return 1;
}
if (receivedSignal === "SIGINT") return 130;
if (receivedSignal === "SIGTERM") return 143;
return 0;
```

### `spawnEmbeddedServer` contract

```ts
export interface EmbeddedServerHandle {
  readonly baseUrl: string;   // e.g. "http://127.0.0.1:54321"
  readonly password: string;  // bearer token; in-memory only
  readonly stop: (graceMs?: number) => Promise<void>;  // idempotent
}

export async function spawnEmbeddedServer(opts: {
  readonly host?: string;             // default "127.0.0.1"
  readonly port?: number;              // 0 → OS-assigned
  readonly authToken?: string;         // default: freshly generated
  readonly verbose?: boolean;
  readonly logger?: Logger;
  readonly sessionPaths?: SessionPaths;
}): Promise<EmbeddedServerHandle>;
```

`stop(graceMs)` behavior:

1. Flag the RunManager as draining. New `POST /runs` requests → 503.
2. Wait up to `graceMs` (default 5000) for in-flight runs to finish.
3. Call `runManager.shutdown(remainingMs)` to SIGTERM any OpenCode child.
4. `server.close()` to stop accepting connections.
5. `await sessionStore.checkpointWal()` (or the equivalent DB close with WAL truncate).
6. Mark `stopped = true`. Subsequent calls → no-op Promise.resolve().

**Must not leak:**
- OpenCode child process
- HTTP listener (the random port)
- SQLite connections / WAL bytes beyond a sane threshold
- The raw-mode flag on the parent's TTY
- The bearer token (never written to logs, env, or stdout)

### Raw mode + TTY restore

Before mounting the TUI: set `process.stdin` to raw mode, hide cursor (`\x1b[?25l`), enable bracketed paste (`\x1b[?2004h`).

On exit (ALL paths — clean, signal, crash): restore cooked mode, show cursor (`\x1b[?25h`), disable bracketed paste (`\x1b[?2004l`), emit a final newline. Wrap this in a `restoreTty()` helper called from both the `finally` block and a `process.on("exit")` last-resort handler.

### Perceived-latency / boot ordering

Don't block first paint on server health. Order:

1. **Immediately** (t=0): write a spinner frame to stderr ("starting jellyclaw…") — the user sees motion within 50 ms.
2. (t ≈ 50–200 ms): spawn the embedded server in the background.
3. (t ≈ 200–500 ms): poll `/healthz` with 50 ms backoff up to 10 s.
4. On first 200: hand off to `renderTui`. The spinner frame is replaced by the TUI's first render.

If health never arrives, tear down the partial state (kill the child, close SQLite) and exit 1 with a human-readable error on stderr.

### Flag → subsystem wiring

| Flag            | Propagates to                                            |
| --------------- | -------------------------------------------------------- |
| `--cwd`         | Spawned server's session paths; TUI's `cwd` prop         |
| `--model`       | First `POST /runs` query param                           |
| `--provider`    | First `POST /runs` query param                           |
| `--config-dir`  | Embedded server's `SessionPaths({ configDir })`          |
| `--resume <id>` | TUI `initialSession` + first `POST /runs` `?resume=`     |
| `--continue`    | CLI resolves newest session ID up-front, then same as `--resume` |
| `--no-color`    | TUI theme (disables ANSI) + spinner (plain text)         |
| `--ascii`       | TUI spinner + glyph set (unicode → ASCII)                |
| `--verbose`     | Spawned server logger level = `debug`; TUI keeps default |

### Health probe implementation

```ts
export async function waitForHealth(
  baseUrl: string,
  token: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/healthz`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 200) return;
      lastErr = new Error(`healthz returned ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await sleep(50);
  }
  throw new TuiHealthTimeoutError(
    `embedded server did not become ready within ${timeoutMs}ms: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
  );
}
```

The 50 ms cadence gives ~200 attempts in 10 s. Do NOT back off exponentially — the server either comes up in < 1 s on a warm machine or it's broken; exponential backoff just wastes the timeout budget.

### Exit-code reference

| Code | Meaning                                                  |
| ---- | -------------------------------------------------------- |
| 0    | Clean exit: user typed `/exit` or pressed Ctrl-D.        |
| 1    | Crash: uncaught exception in TUI or embedded server.     |
| 2    | User error: bad flag, Windows platform, piped stdin, `--resume` + `--continue`. |
| 130  | SIGINT (128 + 2): user pressed Ctrl-C during the session.|
| 143  | SIGTERM (128 + 15): process was asked to terminate.      |

All non-zero paths run the same `finally` block; cleanup is invariant across exit codes.

### Error classes

Reuse existing engine error types where they fit; add one new typed error in `engine/src/cli/shared/errors.ts` (or extend the existing errors module):

```ts
export class TuiHealthTimeoutError extends Error {
  override readonly name = "TuiHealthTimeoutError";
}
```

Map it to exit code 1 in `main.ts`'s `mapErrorToExitCode` (it's an internal failure, not a user error).

### Windows handling

Out of scope for this phase. Detect `process.platform === "win32"` at the top of `tuiAction` and exit with code 2 and a clear stderr message: `"jellyclaw tui: Windows is not supported in this release. Track progress: https://github.com/gtrush03/jellyclaw-engine/issues/<TBD>"`.

### Shell commands

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine
bun run typecheck
bun run build
chmod +x engine/bin/jellyclaw

# Smoke: help
bun run engine/src/cli/main.ts --help                 # expect: `tui` listed
bun run engine/src/cli/main.ts tui --help             # expect: full flag docs

# Test matrix
bun run test test/cli/tui-flags.test.ts
bun run test test/cli/tui-spawn.test.ts
bun run test test/cli/tui-ctrl-c.test.ts
bun run test test/cli/tui-crash.test.ts

# Lint
bun run lint
```

### Expected output

- `jellyclaw --help` lists the `tui` subcommand in the subcommand index.
- `jellyclaw tui --help` prints every flag with a description.
- `jellyclaw tui` opens the vendored TUI (jellyfish theme), accepts a prompt, streams events from the embedded server, exits cleanly on `/exit` or Ctrl-D.
- After exit: `lsof -iTCP -sTCP:LISTEN` shows NO leftover listener on the random port the TUI chose.
- After exit: the SQLite WAL file (`~/.jellyclaw/sessions.db-wal`) is gone or < 1 KB (proves a clean WAL checkpoint).
- After exit: `ps` shows no orphaned OpenCode child.

### Tests to add

#### `test/cli/tui-flags.test.ts`

In-process parser test — uses `buildProgram()` directly and never spawns a subprocess.

- `--cwd`, `--model`, `--provider`, `--config-dir`, `--resume`, `--continue`, `--no-color`, `--ascii`, `--verbose` all parse to the expected `TuiCliOptions` shape.
- `--resume` + `--continue` together → Commander throws; mapped to exit code 2.
- `--provider` rejects unknown values (only `primary | secondary`).
- `--no-color` → `options.color === false`.
- `--ascii` → `options.ascii === true`.
- No flags → all option fields are `undefined` / defaults.
- `tui --help` exits 0 (Commander's `commander.helpDisplayed` is mapped to 0 by `mapErrorToExitCode`).

Assert via injecting a stub `tuiAction` that captures the received options without booting the TUI. Pattern: swap the dynamic import target via a DI shim already used by 10.01's CLI tests.

#### `test/cli/tui-spawn.test.ts`

- Spawn `bun run engine/src/cli/main.ts tui` via `child_process.spawn` with `stdio: "pipe"`.
- Wait for the bootstrap signal (a known line on stderr, e.g. `"jellyclaw: tui ready"`, or a probe timeout of 3 s).
- Write `/exit\n` to child stdin.
- Assert child exits within 5 s with code 0.
- Assert no listener remains on the port the child picked (capture from verbose log or a test-only stderr probe line).

#### `test/cli/tui-ctrl-c.test.ts`

- Spawn, wait for bootstrap, send `SIGINT` via `child.kill("SIGINT")`.
- Assert exit code 130 within 10 s.
- Assert no zombie OpenCode child (use a test-only marker env var that makes the child write its PID to a temp file; check the PID isn't running post-exit).
- Assert no SQLite `-wal` leftover beyond 1 KB.

#### `test/cli/tui-crash.test.ts`

- Spawn with env var `JELLYCLAW_TUI_FORCE_CRASH=1` (test-only flag that makes `renderTui` throw after 500 ms).
- Gate the env var behind `process.env.JELLYCLAW_INTERNAL_TEST === "1"` so it's inert in production builds.
- Assert exit code 1 within 15 s.
- Assert the server was stopped (no listener on the captured port, no zombie OpenCode child).
- Assert SQLite WAL was checkpointed: `fs.statSync(wal).size < 1024` or the file is absent.
- Assert stderr contains a useful error message (not a silent exit) — `grep` for the forced-crash signature.
- Assert cooked mode is restored — check `process.stdin.isRaw === false` in the parent test runner (the child's raw-mode state doesn't leak to the parent's TTY).

#### Test support: `test/cli/_helpers/tui-harness.ts`

Extract a small harness (not a test file) with:

- `spawnTui(args: string[], env?: Record<string, string>): ChildProcess` — wraps `child_process.spawn` with `stdio: "pipe"`, inherits a deterministic cwd, and sets `JELLYCLAW_INTERNAL_TEST=1`.
- `waitForReadyBanner(child, timeoutMs = 5_000): Promise<{ port: number }>` — scans stderr for a test-only `"jellyclaw-tui-ready port=<n>"` line emitted from `tuiAction` when `JELLYCLAW_INTERNAL_TEST=1`. Returns the port.
- `assertNoListener(port: number): Promise<void>` — polls for ≤ 2 s; uses `net.createConnection({ port }).on("error", resolve)` to confirm nothing accepts.
- `assertNoZombie(pidFile: string): Promise<void>` — reads the PID and calls `process.kill(pid, 0)`; ENOENT → no zombie.

### Docs update

#### `docs/cli.md`

Add a new section in the subcommand index:

| Subcommand      | Purpose                                            |
| --------------- | -------------------------------------------------- |
| `run`           | Dispatch a wish; stream events to stdout           |
| `resume`        | Rehydrate a session by id                          |
| `continue`      | Continue newest session for this project           |
| `serve`         | HTTP server (Hono + SSE)                           |
| **`tui`**       | **Interactive TUI (Claude-Code-style terminal)**   |
| `sessions`      | Session inspection                                 |
| `skills`, `agents`, `mcp` | Registry listings                        |
| `config`        | Effective merged config                            |
| `doctor`        | Diagnose install state                             |

Followed by a full `tui` section in the same shape as `run`:

- One-paragraph summary.
- Flag table with description, type, default:

  | Flag | Type | Default | Description |
  | --- | --- | --- | --- |
  | `--cwd <path>` | path | `process.cwd()` | Run as-if cwd; scopes session search and file discovery. |
  | `--model <id>` | string | config default | Provider-agnostic model id. |
  | `--provider <name>` | `primary \| secondary` | `primary` | Routes through the Phase 02 provider strategy. |
  | `--config-dir <path>` | path | `~/.jellyclaw` | Override config directory. |
  | `--resume <id>` | string | — | Rehydrate a session by id. Conflicts with `--continue`. |
  | `--continue` | flag | — | Resume newest session for this project. Conflicts with `--resume`. |
  | `--no-color` | flag | auto-detect | Disable ANSI colors (theme + spinner). |
  | `--ascii` | flag | off | ASCII-only glyphs/spinner (unicode fallback). |
  | `--verbose` | flag | off | Verbose logging to stderr. |

- Opening-frame ASCII demo (copy from 10.5.01 acceptance artifact).
- "What it spawns internally" paragraph: in-process engine HTTP server on `127.0.0.1:<random>` with an in-memory bearer password (never logged, never written to disk, never crosses the network); the server is stopped gracefully on exit with a 5 s drain window for in-flight runs.
- Troubleshooting:
  - **Windows:** unsupported in this release; `jellyclaw tui` exits 2 with a pointer to the tracking issue. Use WSL2 as a workaround.
  - **Non-TTY stdin:** if stdin is piped (`echo ... | jellyclaw tui`), the TUI refuses to start and suggests `jellyclaw run` instead. Exit code 2.
  - **`/healthz` timeout:** the embedded server failed to come up. Run `jellyclaw doctor` to rule out SQLite/patches/providers. Re-run with `--verbose` to see the server's startup log on stderr.
  - **Port collision:** shouldn't happen (port `0` → OS-assigned free port), but if the OS exhausts the ephemeral range, retry once.
  - **Terminal left in raw mode after a kill -9:** `stty sane && printf '\e[?25h\e[?2004l'` restores.

#### `docs/library.md`

Append a single line under the "Consumers" heading: "The TUI (`jellyclaw tui`, Phase 10.5) is the fourth consumer of `createEngine()`, alongside CLI `run`, HTTP `serve`, and external library embedders."

### Common pitfalls

- **Double-spawning the engine server.** If the user runs `jellyclaw tui` while `jellyclaw serve` is already running on port 8765, the TUI MUST NOT try to share that server. **Decision for this phase:** always spawn a fresh embedded server on a random free port; the TUI's server is private and dies with the TUI. Document this in `docs/cli.md` explicitly so users aren't surprised by two processes.
- **OpenCode server + TUI both reading stdin.** The OpenCode child is spawned by the embedded server; ensure it inherits `stdio: "ignore"` (or `"pipe"` with stdin immediately ended), never `"inherit"`. Otherwise the TUI and OpenCode fight over keystrokes and the TUI goes deaf.
- **Cold-start perceived latency.** Paint the spinner FIRST (synchronously, before any `await`). Only then start spawning the server. A 1 s bootstrap feels like 200 ms if the user sees motion within 50 ms; it feels like 5 s if the first visible frame is at t=1 s.
- **Password leak.** Never write the bearer password to logs (even at `debug`), env vars, process titles, or stdout. Pass it via an in-memory variable only. If the TUI's `renderTui` accepts a password, it's only used to set an `Authorization: Bearer …` header on in-process requests; it never crosses the network. Add a lint/grep check in the test: `grep -r "bearer" engine/dist/ | wc -l` should be zero beyond the header-setting call site.
- **Bun `spawn` + raw TTY.** The TUI needs raw mode on the parent's stdin. Ensure the parent CLI process sets `process.stdin.setRawMode(true)` BEFORE `renderTui` mounts, and restores cooked mode on EVERY exit path (clean, signal, crash). Emit `\x1b[?25h` (show cursor) and `\x1b[?2004l` (disable bracketed paste) in the restore routine. Register the restore as `process.on("exit", restoreTty)` as a last-resort belt-and-braces.
- **`--no-color` must propagate to both theme AND spinner fallbacks.** The theme alone isn't enough — the bootstrap spinner (painted before the TUI mounts) also needs to honor it. Plumb `noColor` through the spinner component.
- **`--ascii` swaps unicode spinner → ASCII.** `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` becomes `|/-\`. Plumb the choice through the spinner component AND through the TUI's glyph set (if 10.5.01 exposed an `ascii` prop).
- **Crash recovery.** If the Solid render inside the TUI throws an uncaught exception, the server MUST still be stopped. Wrap the TUI mount in a `try/finally` that unconditionally calls `serverHandle.stop()`. Do NOT rely on Solid's own error boundaries alone.
- **Windows.** Not supported. Detect at entry, exit 2 with a clear message. Do NOT attempt partial Windows support; it'll leak terminal state on Ctrl-C.
- **Mutually-exclusive `--resume` / `--continue`.** Same rule as `run`. Commander's `conflicts("continue")` on the `Option` handles it; assert in tests.
- **`--continue` resolution timing.** `--continue` needs the newest session ID for this project before `renderTui` mounts (so the TUI can fetch the session summary on first paint). Resolve it BEFORE spawning the server so the bootstrap sequence has everything it needs.
- **Health probe retries.** 50 ms backoff, 10 s cap, ~200 attempts. On timeout throw `TuiHealthTimeoutError` and clean up the partial state.
- **`process.exit` discipline.** Per CLAUDE.md, only `cli/main.ts` may call `process.exit`. `tui.ts` returns a numeric exit code; `main.ts` maps it. Do not regress this.
- **Idempotent `serverHandle.stop()`.** Called from the `finally` block AND from the signal handler's abort path — must be safe to call twice. Guard with a `stopped` flag.
- **SQLite WAL checkpoint on shutdown.** The server's `stop()` must run `PRAGMA wal_checkpoint(TRUNCATE)` before closing the connection. Verify in the crash test that the `-wal` file is < 1 KB post-exit.
- **Test-only escape hatches.** The tests use env vars like `JELLYCLAW_TUI_FORCE_CRASH=1` and `JELLYCLAW_TUI_PID_FILE=/tmp/...`. Gate ALL such hatches behind `process.env.NODE_ENV === "test"` or an explicit `JELLYCLAW_INTERNAL_TEST=1` guard so they can't be triggered in production.
- **Stdout discipline.** In TUI mode, stdout is the TTY canvas — the TUI owns it. ALL logging (including `--verbose`) goes to stderr. Do not log to stdout under any circumstance.

### Verification

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine
bun run build

# Help surface
./engine/bin/jellyclaw --help | grep -q "tui"                  # expect: match
./engine/bin/jellyclaw tui --help | grep -q -- "--cwd"         # expect: match
./engine/bin/jellyclaw tui --help | grep -q -- "--resume"      # expect: match
./engine/bin/jellyclaw tui --help | grep -q -- "--no-color"    # expect: match

# Manual smoke — opens the TUI, type a prompt, confirm streaming, /exit
./engine/bin/jellyclaw tui

# After exit: verify no leftover listener and a clean WAL
lsof -iTCP -sTCP:LISTEN | grep -c "jellyclaw\|node"            # expect: 0
ls -l ~/.jellyclaw/sessions.db-wal 2>/dev/null                 # expect: missing or < 1 KB

# Automated tests
bun run test test/cli/tui-flags.test.ts
bun run test test/cli/tui-spawn.test.ts
bun run test test/cli/tui-ctrl-c.test.ts
bun run test test/cli/tui-crash.test.ts

# Lint + typecheck
bun run typecheck
bun run lint
```

All of the above must pass before flipping 10.5.03 to ✅.

<!-- BEGIN: paste from /Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/COMPLETION-UPDATE-TEMPLATE.md -->
<!-- On success: 10.5.03 ✅ in COMPLETION-LOG.md; STATUS.md notes next prompt is 10.5.04 (docs sweep + phase closeout). Do NOT flip Phase 10.5 to ✅ yet — 10.5.04 is the closeout prompt. -->
<!-- END paste -->

**Note:** This is the final **substantive** prompt in Phase 10.5 (the wiring prompt). Prompt 10.5.04 is a docs-only sweep that flips Phase 10.5 to ✅ and bumps the progress counter. Do NOT flip the phase here.
