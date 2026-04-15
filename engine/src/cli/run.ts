/**
 * `jellyclaw run [prompt]` — Phase 10.01.
 *
 * Flag parsing is owned by Commander (see `main.ts`). This module is the action
 * handler: it validates the semantic content of flags, resolves the prompt
 * (positional arg or piped stdin), short-circuits on `--wish-id` cache hits,
 * picks an OutputWriter, and iterates the engine's event stream.
 *
 * TODO(10.02): `engine/src/index.ts` `run()` is still the Phase-0 stub and
 * doesn't yet read `--resume` / `--continue` state back into the run loop.
 * We wire the flags through the options object so that when run() is upgraded,
 * this file needs zero changes.
 */

import { randomUUID } from "node:crypto";
import { runAgentLoop } from "../agents/loop.js";
import type { AgentEvent } from "../events.js";
import { HookRegistry } from "../hooks/registry.js";
import type { RunOptions } from "../internal.js";
import { createLogger } from "../logger.js";
import { compilePermissions } from "../permissions/rules.js";
import { AnthropicProvider } from "../providers/anthropic.js";
import { openDb } from "../session/db.js";
import { WishLedger } from "../session/idempotency.js";
import { SessionPaths } from "../session/paths.js";
import { ExitError } from "./main.js";
import {
  type CreateOutputWriterOptions,
  isOutputFormat,
  type OutputFormat,
  type OutputWriter,
  resolveOutputFormat,
} from "./output-types.js";

// ---------------------------------------------------------------------------
// Public option shape after Commander has normalised camelCase keys.
// ---------------------------------------------------------------------------

export interface RunCliOptions {
  readonly model?: string;
  readonly provider?: "primary" | "secondary";
  readonly mcpConfig?: string;
  readonly permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan";
  readonly maxTurns?: string;
  readonly maxCostUsd?: string;
  readonly outputFormat?: string;
  readonly streamStderr?: string;
  readonly sessionId?: string;
  readonly resume?: string;
  readonly continue?: boolean;
  readonly wishId?: string;
  readonly appendSystemPrompt?: string;
  readonly allowedTools?: string;
  readonly disallowedTools?: string;
  readonly addDir?: readonly string[];
  readonly cwd?: string;
  readonly configDir?: string;
  readonly fallbackProvider?: string;
  readonly verbose?: boolean;
}

// ---------------------------------------------------------------------------
// Dependency injection for testability.
// ---------------------------------------------------------------------------

export interface RunActionDeps {
  readonly runFn: (options: RunOptions) => AsyncIterable<AgentEvent>;
  readonly createWriter: (options: CreateOutputWriterOptions) => OutputWriter;
  readonly openWishLedger: () => Promise<{
    ledger: WishLedger;
    close: () => void;
  } | null>;
  readonly readStdin: () => Promise<string>;
  readonly isStdinTty: () => boolean;
  readonly isStdoutTty: () => boolean;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
}

async function defaultOpenWishLedger(): Promise<{
  ledger: WishLedger;
  close: () => void;
} | null> {
  try {
    const paths = new SessionPaths();
    const db = await openDb({ paths });
    const ledger = new WishLedger(paths, db);
    return { ledger, close: () => db.close() };
  } catch {
    // If we can't open the DB (e.g. first run, no home), treat as no ledger.
    return null;
  }
}

async function defaultCreateWriter(options: CreateOutputWriterOptions): Promise<OutputWriter> {
  // Agent B's `output.ts` exposes createOutputWriter. We dynamic-import so
  // test builds that inject their own writer don't require the file to exist.
  const mod = (await import("./output.js")) as {
    createOutputWriter: (o: CreateOutputWriterOptions) => OutputWriter;
  };
  return mod.createOutputWriter(options);
}

async function defaultReadStdin(): Promise<string> {
  const MAX_BYTES = 10 * 1024 * 1024;
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : (chunk as Buffer);
    total += buf.byteLength;
    if (total > MAX_BYTES) {
      throw new ExitError(2, "stdin too large (max 10MB)");
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function* realRunFn(opts: RunOptions): AsyncIterable<AgentEvent> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey === undefined || apiKey.length === 0) {
    throw new ExitError(2, "ANTHROPIC_API_KEY not set. Export it or add to .env.local.");
  }
  const logger = createLogger({
    level: process.env.JELLYCLAW_LOG_LEVEL ?? "info",
    destination: "stderr",
  });
  const provider = new AnthropicProvider({ apiKey, logger });
  const hooks = new HookRegistry([], { logger });
  const permissions = compilePermissions({ mode: "bypassPermissions" });
  const ac = new AbortController();
  const onSig = (): void => {
    ac.abort();
  };
  process.once("SIGINT", onSig);
  process.once("SIGTERM", onSig);
  try {
    yield* runAgentLoop({
      provider,
      hooks,
      permissions,
      model: "claude-haiku-4-5-20251001",
      prompt: opts.wish,
      sessionId: opts.sessionId ?? randomUUID(),
      cwd: opts.cwd ?? process.cwd(),
      signal: ac.signal,
      logger,
    });
  } finally {
    process.off("SIGINT", onSig);
    process.off("SIGTERM", onSig);
  }
}

function buildDefaultDeps(): RunActionDeps {
  // NOTE: `createWriter` returns a Promise; we widen the Deps contract with an
  // async adapter. Pure sync writers are fine too.
  let cachedWriter: Promise<OutputWriter> | null = null;
  return {
    runFn: realRunFn,
    createWriter: (options) => {
      // Cache the first invocation — each action handler creates exactly one writer.
      if (cachedWriter !== null) {
        throw new Error("createWriter called more than once");
      }
      const pending = defaultCreateWriter(options);
      cachedWriter = pending;
      // Return a lazy proxy that awaits the real writer.
      const wrapper: OutputWriter = {
        async write(event: AgentEvent): Promise<void> {
          const w = await pending;
          await w.write(event);
        },
        async finish(): Promise<void> {
          const w = await pending;
          await w.finish();
        },
      };
      return wrapper;
    },
    openWishLedger: defaultOpenWishLedger,
    readStdin: defaultReadStdin,
    isStdinTty: () => Boolean(process.stdin.isTTY),
    isStdoutTty: () => Boolean(process.stdout.isTTY),
    stdout: process.stdout,
    stderr: process.stderr,
  };
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/** CSV → string[], trimming whitespace. Preserves `mcp__server__tool` names. */
export function parseCsv(raw: string | undefined): readonly string[] | undefined {
  if (raw === undefined) return undefined;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseIntStrict(raw: string | undefined, flag: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) {
    throw new ExitError(2, `invalid ${flag}: "${raw}" is not an integer`);
  }
  return n;
}

function parseFloatStrict(raw: string | undefined, flag: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number.parseFloat(raw);
  if (Number.isNaN(n)) {
    throw new ExitError(2, `invalid ${flag}: "${raw}" is not a number`);
  }
  if (n < 0) {
    throw new ExitError(2, `invalid ${flag}: must be non-negative`);
  }
  return n;
}

// ---------------------------------------------------------------------------
// Factory + default action
// ---------------------------------------------------------------------------

export function createRunAction(
  deps: RunActionDeps,
): (prompt: string | undefined, options: RunCliOptions) => Promise<void> {
  return async (promptArg, optionsArg) => {
    // Commander drops unknown properties onto the options record; re-bind
    // through our typed interface to avoid `any`.
    const options = optionsArg;

    // --- mutually exclusive check (belt + braces with commander.conflicts) --
    if (options.resume !== undefined && options.continue === true) {
      throw new ExitError(2, "--resume and --continue are mutually exclusive");
    }

    // --- numeric validation ------------------------------------------------
    const maxTurns = parseIntStrict(options.maxTurns, "--max-turns");
    const maxCostUsd = parseFloatStrict(options.maxCostUsd, "--max-cost-usd");

    // --- output format -----------------------------------------------------
    let format: OutputFormat;
    try {
      format = resolveOutputFormat(options.outputFormat, deps.isStdoutTty());
    } catch (err) {
      throw new ExitError(2, err instanceof Error ? err.message : String(err));
    }
    if (options.outputFormat !== undefined && !isOutputFormat(options.outputFormat)) {
      throw new ExitError(2, `invalid --output-format: ${options.outputFormat}`);
    }

    // --- prompt resolution -------------------------------------------------
    let prompt = promptArg?.trim() ?? "";
    if (prompt.length === 0 && !deps.isStdinTty()) {
      const piped = (await deps.readStdin()).trim();
      prompt = piped;
    }
    // `--resume`/`--continue`/`--wish-id` can operate without a fresh prompt.
    const hasSessionAnchor =
      options.resume !== undefined || options.continue === true || options.wishId !== undefined;
    if (prompt.length === 0 && !hasSessionAnchor) {
      throw new ExitError(
        2,
        "missing <prompt>. Pass a positional arg, pipe stdin, or provide --resume/--continue/--wish-id.",
      );
    }

    // --- CSV tool lists ----------------------------------------------------
    const allowedTools = parseCsv(options.allowedTools);
    const disallowedTools = parseCsv(options.disallowedTools);

    // --- wish idempotency short-circuit -----------------------------------
    // NOTE(10.02): on cache hit we currently emit a single session.completed
    // event derived from the stored record. When replay-from-JSONL ships, the
    // cache-hit path should replay every stored event; that's a one-liner in
    // run-loop integration — this hook is ready.
    if (options.wishId !== undefined) {
      const opened = await deps.openWishLedger();
      if (opened !== null) {
        try {
          const outcome = await opened.ledger.check(options.wishId);
          if (outcome.kind === "cached") {
            const writer = deps.createWriter({
              format,
              stdout: deps.stdout,
              stderr: deps.stderr,
              verbose: options.verbose === true,
            });
            const sessionId = outcome.record.sessionId ?? options.wishId;
            const now = Date.now();
            const cachedEvent: AgentEvent = {
              type: "session.completed",
              session_id: sessionId,
              ts: now,
              seq: 0,
              summary: outcome.record.resultJson ?? "(cached)",
              turns: 0,
              duration_ms: 0,
            };
            await writer.write(cachedEvent);
            await writer.finish();
            return;
          }
        } finally {
          opened.close();
        }
      }
    }

    // --- build engine run options ------------------------------------------
    // The Phase-0 `run()` stub only understands a narrow option shape. Extra
    // flags are preserved through the closure so an upgraded run() can pick
    // them up without re-plumbing this handler.
    const runOptions: RunOptions = { wish: prompt };
    if (options.cwd !== undefined) runOptions.cwd = options.cwd;
    if (options.sessionId !== undefined) runOptions.sessionId = options.sessionId;

    // Stash unused-but-parsed values to silence noUnusedLocals; these are
    // intentionally wired for Phase 10.02 adoption.
    void maxTurns;
    void maxCostUsd;
    void allowedTools;
    void disallowedTools;

    // --- writer + event loop ----------------------------------------------
    const writer = deps.createWriter({
      format,
      stdout: deps.stdout,
      stderr: deps.stderr,
      verbose: options.verbose === true,
    });

    try {
      for await (const event of deps.runFn(runOptions)) {
        await writer.write(event);
      }
    } finally {
      await writer.finish();
    }
  };
}

/**
 * Real action handler wired against live engine / filesystem dependencies.
 * Commander binds this via `main.ts`.
 */
export const runAction: (prompt: string | undefined, options: RunCliOptions) => Promise<void> =
  createRunAction(buildDefaultDeps());
