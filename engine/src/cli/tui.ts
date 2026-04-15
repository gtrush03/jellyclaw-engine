/**
 * Phase 10.5 Prompt 03 — `jellyclaw tui` CLI action.
 *
 * Flow:
 *   1. Windows guard → exit 2 with a clear message.
 *   2. `attach <url>` → skip spawn, hand the URL+token straight to `launchTui`.
 *   3. Otherwise → `spawnEmbeddedServer()` → `waitForHealth()` → `launchTui()`.
 *   4. `await handle.onExit` for the TUI's own exit code (Agent F contract).
 *   5. Teardown: stop the server, restore the TTY, return the exit code.
 *
 * Exit-code map (see prompts/phase-10.5/03-tui-command.md):
 *   0   clean exit (value of `handle.onExit`)
 *   1   generic error / crash
 *   2   Windows / bad flag combo
 *   124 `TuiHealthTimeoutError` (embedded server never came up)
 *   130 SIGINT
 *   143 SIGTERM
 *
 * This module never calls `process.exit` — per CLAUDE.md only `cli/main.ts`
 * may do that. All exit paths return a numeric code.
 */

import type { LaunchTuiHandle, LaunchTuiOptions } from "../tui/index.js";
import { ExitError } from "./main.js";
import type { EmbeddedServerHandle, SpawnEmbeddedServerOptions } from "./shared/spawn-server.js";
import { TuiHealthTimeoutError } from "./shared/spawn-server.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * `launchTui` handle the CLI depends on. Phase 99-06 narrowed this to the
 * `{ cwd, onExit, dispose }` shape produced by the new Ink launcher in
 * `engine/src/tui/index.ts`. We keep `onExit` optional in the type so the
 * embedded-test fakes (which still ship a stub launchTui) compile cleanly.
 */
export interface LaunchTuiHandleLike {
  readonly dispose: () => Promise<void>;
  readonly onExit?: Promise<number>;
  readonly cwd?: string;
}

export type LaunchTuiFn = (opts: LaunchTuiOptions) => Promise<LaunchTuiHandleLike>;

// Keep the public type for callers wanting the precise handle shape.
export type { LaunchTuiHandle };

export type SpawnEmbeddedServerFn = (
  opts?: SpawnEmbeddedServerOptions,
) => Promise<EmbeddedServerHandle>;

export type WaitForHealthFn = (baseUrl: string, timeoutMs?: number) => Promise<void>;

export interface TuiOptions {
  /** Subcommand + flags from Commander: ["tui", ...] or ["attach", url, ...]. */
  readonly args: readonly string[];
  /** Commander-parsed flags (camelCase). Undefined in back-compat call sites. */
  readonly flags?: TuiFlags;
  /** Override env; defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** Project cwd; defaults to `process.cwd()`. */
  readonly cwd?: string;
  /** Test hook. */
  readonly launchTui?: LaunchTuiFn;
  /** Test hook. */
  readonly spawnEmbeddedServer?: SpawnEmbeddedServerFn;
  /** Test hook. */
  readonly waitForHealth?: WaitForHealthFn;
  /** Test hook — allows simulating Windows without mocking process.platform. */
  readonly platform?: NodeJS.Platform;
  /** Test hook — stream writes for user-facing messages. Defaults to stderr. */
  readonly stderr?: NodeJS.WritableStream;
  /** Test hook — stdin (used for raw-mode toggling). */
  readonly stdin?: NodeJS.ReadableStream & {
    isTTY?: boolean;
    setRawMode?: (b: boolean) => unknown;
  };
}

export interface TuiFlags {
  readonly cwd?: string;
  readonly model?: string;
  readonly provider?: "primary" | "secondary";
  readonly resume?: string;
  readonly continue?: boolean;
  /** `--no-color` flips this to `false`. Undefined = auto-detect. */
  readonly color?: boolean;
  readonly ascii?: boolean;
  readonly verbose?: boolean;
}

// ---------------------------------------------------------------------------
// Loader (real launchTui)
// ---------------------------------------------------------------------------

async function loadLaunchTui(): Promise<LaunchTuiFn> {
  const mod = (await import("../tui/index.js")) as { launchTui: LaunchTuiFn };
  return mod.launchTui;
}

// ---------------------------------------------------------------------------
// Raw-mode / cursor restore
// ---------------------------------------------------------------------------

interface RestoreHandle {
  restore: () => void;
}

function installRawModeGuard(
  stdin: (NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (b: boolean) => unknown }) | null,
  stderr: NodeJS.WritableStream,
): RestoreHandle {
  let restored = false;
  let enteredRaw = false;

  if (stdin !== null && stdin.isTTY === true && typeof stdin.setRawMode === "function") {
    try {
      stdin.setRawMode(true);
      enteredRaw = true;
    } catch {
      enteredRaw = false;
    }
  }

  const restore = (): void => {
    if (restored) return;
    restored = true;
    if (enteredRaw && stdin !== null && typeof stdin.setRawMode === "function") {
      try {
        stdin.setRawMode(false);
      } catch {
        /* best-effort */
      }
    }
    try {
      stderr.write("\x1b[?25h");
    } catch {
      /* best-effort */
    }
  };

  // Last-resort: if the process exits before `finally` runs (hard kill path),
  // still try to restore. `process.on("exit")` fires synchronously.
  const onExit = (): void => restore();
  process.once("exit", onExit);

  return {
    restore: () => {
      process.removeListener("exit", onExit);
      restore();
    },
  };
}

// ---------------------------------------------------------------------------
// Flag → env mapping
// ---------------------------------------------------------------------------

/**
 * Returns the env patch that reflects the parsed flags. The caller layers this
 * on top of `process.env` before `launchTui` mounts; rolled back after exit.
 *
 *   --no-color   → NO_COLOR=1
 *   --ascii      → JELLYCLAW_BRAND_GLYPH=ascii
 *   --verbose    → JELLYCLAW_LOG_LEVEL=debug
 *   --model      → JELLYCLAW_MODEL
 *   --provider   → JELLYCLAW_PROVIDER
 *   --resume     → JELLYCLAW_RESUME_SESSION
 *   --continue   → JELLYCLAW_CONTINUE=1
 */
export function flagsToEnvPatch(flags: TuiFlags | undefined): Record<string, string> {
  if (flags === undefined) return {};
  const patch: Record<string, string> = {};
  if (flags.color === false) patch.NO_COLOR = "1";
  if (flags.ascii === true) patch.JELLYCLAW_BRAND_GLYPH = "ascii";
  if (flags.verbose === true) patch.JELLYCLAW_LOG_LEVEL = "debug";
  if (typeof flags.model === "string") patch.JELLYCLAW_MODEL = flags.model;
  if (typeof flags.provider === "string") patch.JELLYCLAW_PROVIDER = flags.provider;
  if (typeof flags.resume === "string") patch.JELLYCLAW_RESUME_SESSION = flags.resume;
  if (flags.continue === true) patch.JELLYCLAW_CONTINUE = "1";
  return patch;
}

// ---------------------------------------------------------------------------
// Target resolution (attach path)
// ---------------------------------------------------------------------------

function resolveAttachTarget(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): { url: string; token: string } | null {
  const [first, second] = args;
  if (first !== "attach") return null;
  const url = typeof second === "string" && second.length > 0 ? second : env.JELLYCLAW_SERVER_URL;
  if (typeof url !== "string" || url.length === 0) {
    return {
      url: "http://127.0.0.1:8765",
      token: env.JELLYCLAW_SERVER_TOKEN ?? env.JELLYCLAW_TOKEN ?? "",
    };
  }
  const token = env.JELLYCLAW_SERVER_TOKEN ?? env.JELLYCLAW_TOKEN ?? "";
  return { url, token };
}

// ---------------------------------------------------------------------------
// tuiAction
// ---------------------------------------------------------------------------

export async function tuiAction(options: TuiOptions): Promise<number> {
  const platform = options.platform ?? process.platform;
  const stderr = options.stderr ?? process.stderr;
  const stdin =
    options.stdin ??
    (process.stdin as NodeJS.ReadableStream & {
      isTTY?: boolean;
      setRawMode?: (b: boolean) => unknown;
    });

  // --- Windows guard ------------------------------------------------------
  if (platform === "win32") {
    stderr.write("jellyclaw tui is macOS/Linux only for now\n");
    return 2;
  }

  const flags = options.flags;
  const cwd = flags?.cwd ?? options.cwd ?? process.cwd();
  const envSource = options.env ?? process.env;

  // Env patch (NO_COLOR etc). We mutate process.env so vendored code that
  // reads `process.env.*` sees it, and restore on exit.
  const envPatch: Record<string, string> = {
    JELLYCLAW_TUI: "1",
    JELLYCLAW_USER_CWD: cwd,
    ...flagsToEnvPatch(flags),
  };
  const prevEnv: Record<string, string | undefined> = {};
  for (const key of Object.keys(envPatch)) {
    prevEnv[key] = process.env[key];
    process.env[key] = envPatch[key];
  }
  const restoreEnv = (): void => {
    for (const key of Object.keys(prevEnv)) {
      const prev = prevEnv[key];
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    }
  };

  const launchTui = options.launchTui ?? (await loadLaunchTui());

  // --- attach path: skip spawn -------------------------------------------
  const attachTarget = resolveAttachTarget(options.args, envSource);

  // Track signal + raw-mode guard. Server lifecycle is owned by `launchTui`
  // since Phase 99-06; `tuiAction` no longer spawns directly.
  let receivedSignal: "SIGINT" | "SIGTERM" | null = null;
  let rawGuard: RestoreHandle | null = null;
  let settled = false;

  const resolved: { value: number | null } = { value: null };
  const waiters: Array<(code: number) => void> = [];
  const settle = (code: number): void => {
    if (settled) return;
    settled = true;
    resolved.value = code;
    for (const w of waiters) w(code);
  };
  const waitSettled = (): Promise<number> =>
    new Promise<number>((resolvePromise) => {
      if (resolved.value !== null) {
        resolvePromise(resolved.value);
        return;
      }
      waiters.push(resolvePromise);
    });

  const onInt = (): void => {
    receivedSignal = "SIGINT";
    settle(130);
  };
  const onTerm = (): void => {
    receivedSignal = "SIGTERM";
    settle(143);
  };
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);

  const cleanup = async (): Promise<void> => {
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
    if (rawGuard !== null) rawGuard.restore();
    restoreEnv();
  };

  try {
    // ---- attach path -----------------------------------------------------
    if (attachTarget !== null) {
      rawGuard = installRawModeGuard(stdin, stderr);
      const handle = await launchTui({
        url: attachTarget.url,
        token: attachTarget.token,
        cwd,
      });

      const onExitPromise: Promise<number> =
        handle.onExit !== undefined
          ? handle.onExit.then((n) => n).catch(() => 1)
          : Promise.resolve(0).then(async () => {
              // Legacy launchTui without onExit — dispose immediately.
              await handle.dispose().catch(() => undefined);
              return 0;
            });

      const code = await Promise.race([onExitPromise, waitSettled()]);
      if (handle.onExit !== undefined) {
        try {
          await handle.dispose();
        } catch {
          /* swallow */
        }
      }
      if (!settled) settle(code);
      await cleanup();
      return resolved.value ?? code;
    }

    // ---- default path: Ink TUI (Phase 99-06+) ---------------------------
    rawGuard = installRawModeGuard(stdin, stderr);
    const launchOpts: LaunchTuiOptions = { cwd };
    if (typeof flags?.resume === "string" && flags.resume.length > 0) {
      (launchOpts as { resumeSessionId?: string }).resumeSessionId = flags.resume;
    }
    if (flags?.continue === true) {
      (launchOpts as { continueLast?: boolean }).continueLast = true;
    }
    // Forward test seams when present so unit tests can swap spawn/health.
    if (options.spawnEmbeddedServer !== undefined) {
      (launchOpts as { spawnServer?: SpawnEmbeddedServerFn }).spawnServer =
        options.spawnEmbeddedServer;
    }
    if (options.waitForHealth !== undefined) {
      (launchOpts as { waitForHealth?: WaitForHealthFn }).waitForHealth = options.waitForHealth;
    }
    const handle = await launchTui(launchOpts);
    const onExitPromise: Promise<number> =
      handle.onExit !== undefined
        ? handle.onExit.then((n) => n).catch(() => 1)
        : Promise.resolve(0);
    const code = await Promise.race([onExitPromise, waitSettled()]);
    try {
      await handle.dispose();
    } catch {
      /* swallow */
    }
    if (!settled) settle(code);
    await cleanup();
    return resolved.value ?? code;
  } catch (err) {
    if (err instanceof TuiHealthTimeoutError) {
      stderr.write(`jellyclaw tui: ${err.message}\n`);
      if (!settled) settle(124);
      await cleanup();
      return 124;
    }
    if (err instanceof ExitError) {
      // Propagate typed exit codes (e.g. Phase 99-06 NotImplemented path).
      if (!settled) settle(err.code);
      await cleanup();
      throw err;
    }
    if (!settled) {
      const msg = err instanceof Error ? err.message : String(err);
      stderr.write(`jellyclaw tui: ${msg}\n`);
      settle(1);
    }
    await cleanup();
    return resolved.value ?? 1;
  } finally {
    // Ensure signal handlers & env are always rolled back even on sync throw.
    if (!settled) {
      // Defensive — should never hit.
      settle(1);
    }
    // `cleanup()` above already ran in the try/catch branches; calling it
    // again is a no-op because rawGuard.restore() + stop() are idempotent.
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
    // Keep suppressing the `receivedSignal` unused-var lint if no signal: the
    // variable is observed via `resolved.value` (130/143) rather than read.
    void receivedSignal;
  }
}
