/**
 * Phase 08 Prompt 02 — single-hook child-process runner.
 *
 * Spawns one user-configured hook command via `child_process.spawn` with no
 * shell interpolation (see `engine/SECURITY.md` §2 and the header of
 * `./types.ts` for invariants). Pipes `{event, payload}` JSON to stdin,
 * collects bounded stdout / stderr, enforces a timeout with SIGTERM→SIGKILL
 * grace, maps the exit-code / stdout contract to a `HookOutcome`, and
 * NEVER throws.
 *
 * This module is the sole low-level spawn primitive for the hooks engine.
 * Composition (deny-wins across multiple hooks, audit-log emission) lives
 * in `registry.ts`, owned by a different agent.
 */

import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import { performance } from "node:perf_hooks";

import type { Logger } from "../logger.js";
import {
  BLOCKING_EVENTS,
  type CompiledHook,
  DEFAULT_HOOK_TIMEOUT_MS,
  HOOK_KILL_GRACE_MS,
  type HookEvent,
  type HookEventKind,
  type HookEventMap,
  type HookOutcome,
  MAX_HOOK_OUTPUT_BYTES,
  MAX_HOOK_TIMEOUT_MS,
  MODIFIABLE_EVENTS,
} from "./types.js";

export interface RunSingleHookOptions {
  readonly logger?: Logger;
  readonly defaultTimeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly signal?: AbortSignal;
}

/**
 * Serialize a hook event to the canonical wire form: a single JSON object
 * `{event, payload}` followed by a newline. Exported so tests + registry
 * can mirror the runner's framing without reimplementing it.
 */
export function stringifyPayload(event: HookEvent): string {
  return `${JSON.stringify({ event: event.kind, payload: event.payload })}\n`;
}

function mergeEnv(extra: Readonly<Record<string, string>> | undefined): NodeJS.ProcessEnv {
  // process.env values are all string|undefined; spreading preserves shape.
  return { ...process.env, ...(extra ?? {}) };
}

function clampTimeout(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return DEFAULT_HOOK_TIMEOUT_MS;
  if (ms > MAX_HOOK_TIMEOUT_MS) return MAX_HOOK_TIMEOUT_MS;
  return ms;
}

/**
 * A relative command path that is neither absolute (`/usr/bin/foo`) nor
 * explicitly cwd-qualified (`./foo`) is PATH-resolved by the OS. This is
 * valid but carries a PATH-shift risk: a malicious entry earlier in PATH
 * could hijack the hook. We warn but do not refuse.
 */
function isPathResolvedBinary(command: string): boolean {
  if (path.isAbsolute(command)) return false;
  if (command.startsWith("./") || command.startsWith("../")) return false;
  // Windows-style relative prefixes are handled by path.isAbsolute on win32.
  if (command.startsWith(".\\") || command.startsWith("..\\")) return false;
  return true;
}

/**
 * Parsed shape of hook stdout. We only care about three fields; anything
 * else is ignored. `modified` is carried through as `unknown` and narrowed
 * by the caller (registry re-validates with the event-kind Zod schema).
 */
interface ParsedHookStdout {
  readonly decision?: unknown;
  readonly modified?: unknown;
  readonly reason?: unknown;
}

function tryParseStdout(stdout: string): ParsedHookStdout | "invalid" {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return "invalid";
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return "invalid";
  return parsed as ParsedHookStdout;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * Run a single compiled hook against an event instance.
 *
 * Never throws. Always resolves to a populated `HookOutcome`:
 *
 *   - Exit 0 + empty stdout                → neutral
 *   - Exit 0 + JSON `{decision:"allow"}`   → allow (blocking events only)
 *   - Exit 0 + JSON `{decision:"deny",…}`  → deny  (blocking events only)
 *   - Exit 0 + JSON `{decision:"modify",…}`→ modify (modifiable events only)
 *   - Exit 0 + malformed stdout            → neutral + warn
 *   - Exit 2 (blocking event)              → deny  (reason from stderr)
 *   - Exit 2 (non-blocking event)          → neutral + warn
 *   - Non-zero non-2 exit                  → neutral + warn
 *   - Timeout / external abort             → neutral + warn, timedOut=true
 *   - Spawn error (ENOENT, EPERM, …)       → neutral + warn, exitCode=null
 *
 * Decisions on events outside `BLOCKING_EVENTS` are downgraded to neutral
 * with a warning. Likewise `modify` on non-`MODIFIABLE_EVENTS`.
 */
export function runSingleHook<K extends HookEventKind>(
  hook: CompiledHook,
  event: HookEvent & { readonly kind: K },
  sessionId: string,
  opts: RunSingleHookOptions = {},
): Promise<HookOutcome<K>> {
  // sessionId is carried for symmetry with the registry contract + future
  // per-session logging. The payload already contains it where relevant.
  void sessionId;

  const logger = opts.logger;
  const maxOutputBytes = opts.maxOutputBytes ?? MAX_HOOK_OUTPUT_BYTES;
  const timeoutMs = clampTimeout(
    hook.config.timeout ?? opts.defaultTimeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS,
  );
  const startedAt = performance.now();
  const hookName = hook.name;
  const eventKind = event.kind;

  const warnings: string[] = [];
  const pushWarn = (w: string): void => {
    warnings.push(w);
  };
  const composeWarn = (): string | undefined =>
    warnings.length === 0 ? undefined : warnings.join("; ");

  // --- pre-spawn: PATH-shift warning ---------------------------------------
  if (isPathResolvedBinary(hook.config.command)) {
    const msg = `relative command "${hook.config.command}" resolved via PATH (PATH-shift risk)`;
    pushWarn(msg);
    logger?.warn({ hook: hookName, event: eventKind }, msg);
  }

  return new Promise<HookOutcome<K>>((resolve) => {
    const finalize = (outcome: HookOutcome<K>): void => {
      resolve(outcome);
    };

    const neutralBase = (extra: Partial<HookOutcome<K>> = {}): HookOutcome<K> => ({
      hookName,
      event: eventKind,
      decision: "neutral",
      durationMs: Math.max(0, performance.now() - startedAt),
      exitCode: null,
      timedOut: false,
      ...(composeWarn() !== undefined ? { warn: composeWarn() as string } : {}),
      ...extra,
    });

    // --- spawn -------------------------------------------------------------
    let child: ChildProcess;
    try {
      child = spawn(hook.config.command, hook.config.args ? [...hook.config.args] : [], {
        stdio: ["pipe", "pipe", "pipe"],
        env: mergeEnv(hook.config.env),
        // NEVER shell: true. User input must never be shell-interpreted.
        shell: false,
      });
    } catch (err) {
      const code =
        err instanceof Error && "code" in err
          ? String((err as { code?: unknown }).code)
          : "unknown";
      pushWarn(`spawn failed: ${code}`);
      finalize(neutralBase());
      return;
    }

    let stdoutBuf = Buffer.alloc(0);
    let stderrBuf = Buffer.alloc(0);
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let settled = false;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | null = null;
    let graceTimer: NodeJS.Timeout | null = null;
    let abortHandler: (() => void) | null = null;

    const cleanupTimers = (): void => {
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
      if (graceTimer) {
        clearTimeout(graceTimer);
        graceTimer = null;
      }
      if (abortHandler && opts.signal) {
        opts.signal.removeEventListener("abort", abortHandler);
        abortHandler = null;
      }
    };

    /**
     * SIGTERM → wait HOOK_KILL_GRACE_MS → SIGKILL. Mirrors the MCP client
     * kill ladder. Safe to call multiple times; escalation is guarded.
     */
    const killLadder = (): void => {
      if (graceTimer) return; // already escalating
      try {
        child.kill("SIGTERM");
      } catch {
        // child may already be dead
      }
      graceTimer = setTimeout(() => {
        graceTimer = null;
        if (child.exitCode !== null || child.signalCode !== null || child.killed) return;
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }, HOOK_KILL_GRACE_MS);
    };

    // --- stdout collection (bounded) --------------------------------------
    const onStdout = (chunk: Buffer): void => {
      if (stdoutTruncated) return;
      const room = maxOutputBytes - stdoutBuf.length;
      if (chunk.length <= room) {
        stdoutBuf = Buffer.concat([stdoutBuf, chunk], stdoutBuf.length + chunk.length);
        return;
      }
      if (room > 0) {
        stdoutBuf = Buffer.concat([stdoutBuf, chunk.subarray(0, room)], stdoutBuf.length + room);
      }
      stdoutTruncated = true;
      child.stdout?.removeListener("data", onStdout);
    };
    const onStderr = (chunk: Buffer): void => {
      if (stderrTruncated) return;
      const room = maxOutputBytes - stderrBuf.length;
      if (chunk.length <= room) {
        stderrBuf = Buffer.concat([stderrBuf, chunk], stderrBuf.length + chunk.length);
        return;
      }
      if (room > 0) {
        stderrBuf = Buffer.concat([stderrBuf, chunk.subarray(0, room)], stderrBuf.length + room);
      }
      stderrTruncated = true;
      child.stderr?.removeListener("data", onStderr);
    };

    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    // Silence stream errors so they never escape as unhandledException.
    child.stdout?.on("error", () => undefined);
    child.stderr?.on("error", () => undefined);

    // --- stdin: write payload + close immediately -------------------------
    const payload = stringifyPayload(event);
    const stdin = child.stdin;
    if (stdin) {
      stdin.on("error", () => undefined);
      try {
        stdin.write(payload);
      } catch {
        // ignore — the hook may not have read stdin; not our problem.
      }
      try {
        stdin.end();
      } catch {
        // ignore
      }
    }

    // --- timeout ----------------------------------------------------------
    killTimer = setTimeout(() => {
      timedOut = true;
      pushWarn(`timeout after ${timeoutMs}ms`);
      killLadder();
    }, timeoutMs);

    // --- external abort ---------------------------------------------------
    if (opts.signal) {
      if (opts.signal.aborted) {
        timedOut = true; // treat abort same as timeout for outcome shape
        pushWarn("aborted");
        // Kick off kill ladder in next tick so the 'exit' handler wires up first.
        setImmediate(() => killLadder());
      } else {
        abortHandler = (): void => {
          timedOut = true;
          pushWarn("aborted");
          killLadder();
        };
        opts.signal.addEventListener("abort", abortHandler, { once: true });
      }
    }

    // --- error event (spawn failure, e.g. ENOENT) -------------------------
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      cleanupTimers();
      const code = err.code ?? "unknown";
      pushWarn(`spawn failed: ${code}`);
      finalize(neutralBase());
    });

    // --- exit / close -----------------------------------------------------
    child.on("close", (code: number | null) => {
      if (settled) return;
      settled = true;
      cleanupTimers();

      const durationMs = Math.max(0, performance.now() - startedAt);
      const stdout = stdoutBuf.toString("utf8");
      const stderr = stderrBuf.toString("utf8");
      const truncFlags = {
        ...(stdoutTruncated ? { stdoutTruncated: true as const } : {}),
        ...(stderrTruncated ? { stderrTruncated: true as const } : {}),
      };

      const base = {
        hookName,
        event: eventKind,
        durationMs,
        exitCode: timedOut ? null : code,
        timedOut,
        ...truncFlags,
      };

      // Timeout / abort: always neutral regardless of any collected output.
      if (timedOut) {
        finalize({
          ...base,
          decision: "neutral",
          exitCode: null,
          timedOut: true,
          ...(composeWarn() !== undefined ? { warn: composeWarn() as string } : {}),
        } as HookOutcome<K>);
        return;
      }

      // Exit 2 → block on blocking events, neutral+warn otherwise.
      if (code === 2) {
        if (BLOCKING_EVENTS.has(eventKind)) {
          const reason = stderr.trim() || `blocked by hook ${hookName}`;
          finalize({
            ...base,
            decision: "deny",
            reason,
            ...(composeWarn() !== undefined ? { warn: composeWarn() as string } : {}),
          } as HookOutcome<K>);
          return;
        }
        pushWarn(`exit 2 on non-blocking event ${eventKind}`);
        finalize({
          ...base,
          decision: "neutral",
          ...(composeWarn() !== undefined ? { warn: composeWarn() as string } : {}),
        } as HookOutcome<K>);
        return;
      }

      // Any other non-zero exit → neutral + warn.
      if (code !== 0 && code !== null) {
        pushWarn(`non-zero exit ${code}`);
        finalize({
          ...base,
          decision: "neutral",
          ...(composeWarn() !== undefined ? { warn: composeWarn() as string } : {}),
        } as HookOutcome<K>);
        return;
      }

      // code === 0 (or null without timeout — treat as neutral empty).
      const parsed = tryParseStdout(stdout);
      if (parsed === "invalid") {
        pushWarn("stdout: invalid JSON");
        finalize({
          ...base,
          decision: "neutral",
          ...(composeWarn() !== undefined ? { warn: composeWarn() as string } : {}),
        } as HookOutcome<K>);
        return;
      }

      const decision = parsed.decision;
      if (decision === undefined) {
        // Empty stdout or JSON object with no decision field → neutral.
        finalize({
          ...base,
          decision: "neutral",
          ...(composeWarn() !== undefined ? { warn: composeWarn() as string } : {}),
        } as HookOutcome<K>);
        return;
      }

      if (decision !== "allow" && decision !== "deny" && decision !== "modify") {
        pushWarn(`unknown decision "${String(decision)}"`);
        finalize({
          ...base,
          decision: "neutral",
          ...(composeWarn() !== undefined ? { warn: composeWarn() as string } : {}),
        } as HookOutcome<K>);
        return;
      }

      // Modify: only valid on MODIFIABLE_EVENTS.
      if (decision === "modify") {
        if (!MODIFIABLE_EVENTS.has(eventKind)) {
          pushWarn(`modify not supported for event ${eventKind}`);
          finalize({
            ...base,
            decision: "neutral",
            ...(composeWarn() !== undefined ? { warn: composeWarn() as string } : {}),
          } as HookOutcome<K>);
          return;
        }
        if (parsed.modified === undefined) {
          pushWarn("modify without modified payload");
          finalize({
            ...base,
            decision: "neutral",
            ...(composeWarn() !== undefined ? { warn: composeWarn() as string } : {}),
          } as HookOutcome<K>);
          return;
        }
        finalize({
          ...base,
          decision: "modify",
          modified: parsed.modified as HookEventMap[K],
          ...(asString(parsed.reason) !== undefined
            ? { reason: asString(parsed.reason) as string }
            : {}),
          ...(composeWarn() !== undefined ? { warn: composeWarn() as string } : {}),
        } as HookOutcome<K>);
        return;
      }

      // allow / deny: only meaningful on BLOCKING_EVENTS.
      if (!BLOCKING_EVENTS.has(eventKind)) {
        pushWarn(`decision on non-blocking event ${eventKind}`);
        finalize({
          ...base,
          decision: "neutral",
          ...(composeWarn() !== undefined ? { warn: composeWarn() as string } : {}),
        } as HookOutcome<K>);
        return;
      }

      if (decision === "deny") {
        const reason = asString(parsed.reason) ?? (stderr.trim() || undefined);
        finalize({
          ...base,
          decision: "deny",
          ...(reason !== undefined ? { reason } : {}),
          ...(composeWarn() !== undefined ? { warn: composeWarn() as string } : {}),
        } as HookOutcome<K>);
        return;
      }

      // allow
      finalize({
        ...base,
        decision: "allow",
        ...(asString(parsed.reason) !== undefined
          ? { reason: asString(parsed.reason) as string }
          : {}),
        ...(composeWarn() !== undefined ? { warn: composeWarn() as string } : {}),
      } as HookOutcome<K>);
    });
  });
}
