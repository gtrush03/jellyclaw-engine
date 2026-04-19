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
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import path, { join } from "node:path";
import { SubagentDispatcher } from "../agents/dispatch.js";
import { DEFAULT_DISPATCH_CONFIG } from "../agents/dispatch-types.js";
import { runAgentLoop } from "../agents/loop.js";
import { AgentRegistry } from "../agents/registry.js";
import { createSubagentSemaphore } from "../agents/semaphore.js";
import { loadSoul } from "../agents/soul.js";
import type { ToolFilter } from "../agents/tool-filter.js";
import { type LoadClaudeSettingsResult, loadClaudeSettings } from "../config/settings-loader.js";
import type { AgentEvent } from "../events.js";
import { HookRegistry } from "../hooks/registry.js";
import type { RunOptions } from "../internal.js";
import { createLogger } from "../logger.js";
import { McpRegistry } from "../mcp/registry.js";
import { ensureChromeRunning, extractLocalCdpPorts } from "./chrome-autolaunch.js";
import { captureAllTabs } from "./session-screenshot.js";
import { AnthropicProvider } from "../providers/anthropic.js";
import { resolveModel } from "../providers/models.js";
import { parseRole, selectAuth } from "../providers/subscription-auth.js";
import { findLatestForProject } from "../session/continue.js";
import { openDb } from "../session/db.js";
import { WishLedger } from "../session/idempotency.js";
import { projectHash, SessionPaths } from "../session/paths.js";
import { resumeSession } from "../session/resume.js";
import { type PriorMessage, toPriorMessages } from "../session/to-prior-messages.js";
import { NoSessionForProjectError, SessionNotFoundError } from "../session/types.js";
import { buildSkillInjection } from "../skills/inject.js";
import { SkillRegistry } from "../skills/registry.js";
import { createSessionRunner } from "../subagents/runner.js";
import type { Credentials } from "./credentials.js";
import { loadCredentials } from "./credentials.js";
import { ExitError } from "./main.js";
import { loadMcpConfigs } from "./mcp-config-loader.js";
import {
  type CreateOutputWriterOptions,
  isOutputFormat,
  type OutputFormat,
  type OutputWriter,
  resolveOutputFormat,
} from "./output-types.js";
import { InvalidPermissionModeError } from "./permission-mode-resolver.js";

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
  const logger = createLogger({
    level: process.env.JELLYCLAW_LOG_LEVEL ?? "info",
    destination: "stderr",
  });

  // Load credentials from disk, with env fallback for back-compat (T0-01).
  const diskCreds = await loadCredentials();
  const envKey = process.env.ANTHROPIC_API_KEY;
  const creds: Credentials = {
    ...diskCreds,
    // Env fallback: if no anthropicApiKey in creds file, check ANTHROPIC_API_KEY env var
    ...(diskCreds.anthropicApiKey === undefined && typeof envKey === "string" && envKey.length > 0
      ? { anthropicApiKey: envKey }
      : {}),
  };
  const auth = selectAuth(creds, parseRole(process.env.JELLYCLAW_ROLE));
  if (auth === null) {
    throw new ExitError(
      1,
      "jellyclaw: no credentials. Run `jellyclaw auth login` or `jellyclaw key set`.",
    );
  }
  // For now, only apiKey auth is supported for the provider.
  // Subscription (OAuth) auth will require different SDK configuration.
  if (auth.kind !== "apiKey") {
    throw new ExitError(
      1,
      "jellyclaw: subscription auth not yet supported for `run`. Use an API key.",
    );
  }
  const provider = new AnthropicProvider({ apiKey: auth.key, logger });

  // Load settings.json from ~/.claude and ./.claude (T2-05, T2-06).
  // Permission mode is resolved with priority: flag > settings > env > "default".
  let settingsResult: LoadClaudeSettingsResult;
  try {
    settingsResult = loadClaudeSettings({
      ...(opts.permissionMode !== undefined ? { overrideMode: opts.permissionMode } : {}),
    });
  } catch (err) {
    if (err instanceof InvalidPermissionModeError) {
      throw new ExitError(2, err.message);
    }
    throw err;
  }
  for (const warning of settingsResult.warnings) {
    logger.warn({ warning }, "settings load warning");
  }
  const hooks = new HookRegistry(settingsResult.hookConfigs, { logger });
  const permissions = settingsResult.permissions;
  const ac = new AbortController();
  const onSig = (): void => {
    ac.abort();
  };
  process.once("SIGINT", onSig);
  process.once("SIGTERM", onSig);

  // MCP registry: load configs from CLI flag, cwd, and home configs (T0-01).
  const cwd = opts.cwd ?? process.cwd();
  const mcpConfigs = await loadMcpConfigs({
    mcpConfig: opts.mcpConfig,
    configDir: opts.configDir,
    cwd,
    logger,
  });
  let mcp: McpRegistry | undefined;
  if (mcpConfigs.length > 0) {
    // T4-01: Auto-launch Chrome if MCP configs contain local CDP endpoints.
    await ensureChromeRunning(mcpConfigs, logger);
    mcp = new McpRegistry({ logger });
    try {
      await mcp.start(mcpConfigs);
      logger.info({ count: mcpConfigs.length }, `mcp: started ${mcpConfigs.length} server(s)`);
    } catch (err) {
      logger.warn({ err }, "one or more MCP servers failed to start; continuing without them");
      // Keep `mcp` around — registry handles per-server failure with retry/backoff.
    }
  }

  // Subagent dispatcher: build AgentRegistry, Semaphore, SessionRunner, and wire
  // into a SubagentDispatcher so Task tool calls work. T2-02.
  const agentRegistry = new AgentRegistry();
  await agentRegistry.loadAll({ logger });
  const semaphore = createSubagentSemaphore({ maxConcurrency: 2, logger });

  // Session resume handling (T2-07).
  // When resuming, load prior messages from the JSONL transcript and preserve
  // the session ID so subsequent writes append to the same file.
  let sessionId = opts.sessionId ?? randomUUID();
  let priorMessages: readonly PriorMessage[] = opts.priorMessages ?? [];

  if (opts.resume !== undefined) {
    const paths = new SessionPaths();
    const db = await openDb({ paths });
    try {
      const state = await resumeSession({
        sessionId: opts.resume,
        paths,
        db,
        logger,
      });
      priorMessages = toPriorMessages(state, { logger });
      sessionId = opts.resume; // Preserve session ID for append.
    } catch (err) {
      if (err instanceof SessionNotFoundError) {
        throw new ExitError(2, `unknown session id: ${opts.resume}`);
      }
      throw err;
    } finally {
      db.close();
    }
  } else if (opts.continue === true) {
    // Session continue handling (T2-08).
    // Find the most recently touched session for the current project and resume it.
    const paths = new SessionPaths();
    const db = await openDb({ paths });
    try {
      const cwd = opts.cwd ?? process.cwd();
      const projectHashStr = projectHash(cwd);
      const latest = await findLatestForProject(db, projectHashStr);
      if (latest === null) {
        throw new ExitError(2, `no prior session for project (cwd=${cwd})`);
      }
      const state = await resumeSession({
        sessionId: latest.id,
        paths,
        db,
        logger,
        projectHash: projectHashStr,
      });
      priorMessages = toPriorMessages(state, { logger });
      sessionId = latest.id;
    } catch (err) {
      if (err instanceof NoSessionForProjectError) {
        const cwd = opts.cwd ?? process.cwd();
        throw new ExitError(2, `no prior session for project (cwd=${cwd})`);
      }
      throw err;
    } finally {
      db.close();
    }
  }

  const model = resolveModel({ configModel: "claude-opus-4-7", env: process.env });

  // Build the session runner (recursive runAgentLoop driver).
  const sessionRunner = createSessionRunner({
    provider,
    permissions,
    hooks,
    logger,
    clock: Date.now,
    // subagents will be set after we create the dispatcher (circular dep resolved below)
    ...(mcp !== undefined ? { mcp } : {}),
  });

  // Build the dispatcher with parent context.
  const subagentDispatcher = new SubagentDispatcher({
    registry: agentRegistry,
    runner: sessionRunner,
    semaphore,
    config: DEFAULT_DISPATCH_CONFIG,
    parent: {
      sessionId,
      // Root session allows all builtin tools. MCP tools are added separately.
      allowedTools: [
        "Bash",
        "Edit",
        "Glob",
        "Grep",
        "NotebookEdit",
        "Read",
        "Task",
        "TodoWrite",
        "WebFetch",
        "WebSearch",
        "Write",
      ],
      model,
      depth: 0,
    },
    clock: Date.now,
    logger,
    signal: ac.signal,
  });

  try {
    // Inject jellyclaw's default voice. `loadSoul()` honours both the env
    // kill-switch (JELLYCLAW_SOUL=off → null) and ~/.jellyclaw/soul.md.
    const soul = await loadSoul({ logger });

    // Load skill registry and build injection block (T2-04).
    const skillRegistry = new SkillRegistry();
    await skillRegistry.loadAll({ logger });
    const skills = skillRegistry.list();
    const { block: skillBlock } = buildSkillInjection({ skills, logger });

    // Compose system prompt: soul + skill block + append-system-prompt (T2-10).
    const systemPromptParts = [soul, skillBlock, opts.appendSystemPrompt].filter(
      (p): p is string => typeof p === "string" && p.length > 0,
    );
    const systemPrompt = systemPromptParts.length > 0 ? systemPromptParts.join("\n\n") : undefined;

    // Build tool filter from CLI flags (T2-09).
    const toolFilter: ToolFilter | undefined =
      opts.allowedTools !== undefined || opts.disallowedTools !== undefined
        ? { allow: opts.allowedTools, deny: opts.disallowedTools }
        : undefined;

    // Normalize --add-dir paths to absolute and validate they exist (T2-10).
    let additionalRoots: readonly string[] | undefined;
    if (opts.addDir !== undefined && opts.addDir.length > 0) {
      const cwd = opts.cwd ?? process.cwd();
      const normalized: string[] = [];
      for (const dir of opts.addDir) {
        // Reject paths with .. segments before resolution.
        if (dir.includes("..")) {
          throw new ExitError(2, `--add-dir: path must not contain '..' (got ${dir})`);
        }
        const abs = path.resolve(cwd, dir);
        try {
          // Validate the path exists and resolve any symlinks.
          const real = realpathSync(abs);
          normalized.push(real);
        } catch {
          throw new ExitError(2, `--add-dir: path must exist and not traverse (${dir})`);
        }
      }
      additionalRoots = normalized;
    }

    // T4-02: Intercept events to add final_screenshots to session.completed.
    // Note: Screenshots must be captured AFTER mcp.stop() because playwright-mcp's
    // CDP connection blocks Page.captureScreenshot commands. However, Chrome itself
    // (launched via jellyclaw-chrome.sh) stays running as a detached process.
    let pendingSessionCompleted: AgentEvent | null = null;

    for await (const event of runAgentLoop({
      provider,
      hooks,
      permissions,
      model,
      prompt: opts.wish,
      sessionId,
      cwd: opts.cwd ?? process.cwd(),
      signal: ac.signal,
      logger,
      subagents: subagentDispatcher,
      ...(systemPrompt !== undefined ? { systemPrompt } : {}),
      ...(priorMessages.length > 0 ? { priorMessages } : {}),
      ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
      ...(opts.maxCostUsd !== undefined ? { maxBudgetUsd: opts.maxCostUsd } : {}),
      ...(mcp !== undefined ? { mcp } : {}),
      ...(skills.length > 0 ? { skillRegistry } : {}),
      ...(toolFilter !== undefined ? { toolFilter } : {}),
      ...(additionalRoots !== undefined ? { additionalRoots } : {}),
    })) {
      if (event.type === "session.completed") {
        // Defer session.completed until after mcp.stop() so we can capture screenshots.
        pendingSessionCompleted = event;
      } else {
        yield event;
      }
    }

    // Stop MCP first so playwright-mcp releases its CDP connection.
    if (mcp !== undefined) {
      await mcp.stop();
      mcp = undefined; // Prevent double-stop in finally
      // Give CDP time to stabilize after MCP releases its connection.
      // 1s delay helps prevent screenshot capture timeouts.
      await new Promise((r) => setTimeout(r, 1000));
    }

    // T4-02: Now capture screenshots (CDP is no longer blocked by playwright-mcp).
    if (pendingSessionCompleted) {
      const finalScreenshots: string[] = [];
      try {
        const ports = extractLocalCdpPorts(mcpConfigs);
        if (ports.size > 0) {
          const outDir = join(homedir(), ".jellyclaw", "sessions", sessionId, "screenshots");
          for (const port of ports) {
            const saved = await captureAllTabs(port, outDir, logger);
            finalScreenshots.push(...saved);
          }
        }
      } catch (err) {
        logger.warn({ err }, "session: final-screenshot hook failed");
      }
      // Emit modified session.completed with final_screenshots if any.
      yield {
        ...pendingSessionCompleted,
        ...(finalScreenshots.length > 0 ? { final_screenshots: finalScreenshots } : {}),
      };
    }
  } finally {
    process.off("SIGINT", onSig);
    process.off("SIGTERM", onSig);
    // Clean up MCP registry if it was started (may have been stopped above).
    if (mcp !== undefined) {
      await mcp.stop();
    }
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
    // Validate maxTurns upper bound at CLI layer.
    if (maxTurns !== undefined && maxTurns > 150) {
      throw new ExitError(2, `--max-turns must be <= 150 (got ${maxTurns})`);
    }

    const runOptions: RunOptions = { wish: prompt };
    if (options.cwd !== undefined) runOptions.cwd = options.cwd;
    if (options.sessionId !== undefined) runOptions.sessionId = options.sessionId;
    if (options.resume !== undefined) runOptions.resume = options.resume;
    if (options.continue === true) runOptions.continue = true;
    if (maxTurns !== undefined) runOptions.maxTurns = maxTurns;
    if (maxCostUsd !== undefined) runOptions.maxCostUsd = maxCostUsd;
    if (allowedTools !== undefined) runOptions.allowedTools = allowedTools;
    if (disallowedTools !== undefined) runOptions.disallowedTools = disallowedTools;
    if (options.appendSystemPrompt !== undefined)
      runOptions.appendSystemPrompt = options.appendSystemPrompt;
    if (options.addDir !== undefined) runOptions.addDir = options.addDir;

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
