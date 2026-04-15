/**
 * jellyclaw CLI — Commander entry (Phase 10.01).
 *
 * This module is the ONLY place in the codebase allowed to call `process.exit`
 * (per CLAUDE.md). All subcommands are lazy-loaded via dynamic import so that
 * `jellyclaw --help` stays snappy (no engine bootstrap, no SQLite open).
 *
 * Error → exit-code mapping:
 *   0  ok
 *   1  generic / uncaught error
 *   2  user error (bad flag, missing prompt, mutually-exclusive conflict,
 *                  Commander validation, known domain errors like BindViolation)
 *
 * Commander is put into `exitOverride()` mode so validation errors throw
 * `CommanderError` instead of calling `process.exit` from inside the library.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Command, CommanderError, Option } from "commander";

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

function readVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // dist/cli/main.js → ../../engine/package.json
    // engine/src/cli/main.ts (test/dev) → ../../package.json
    const candidates = [
      resolve(here, "../../engine/package.json"),
      resolve(here, "../../package.json"),
    ];
    for (const p of candidates) {
      try {
        const raw = readFileSync(p, "utf8");
        const pkg = JSON.parse(raw) as { version?: string; name?: string };
        if (pkg.name === "@jellyclaw/engine" && typeof pkg.version === "string") {
          return pkg.version;
        }
      } catch {
        /* try next candidate */
      }
    }
  } catch {
    /* fall through */
  }
  return "0.0.0";
}

// ---------------------------------------------------------------------------
// Exit envelope
// ---------------------------------------------------------------------------

export class ExitError extends Error {
  override readonly name = "ExitError";
  constructor(
    public readonly code: number,
    message?: string,
  ) {
    super(message ?? `exit ${code}`);
  }
}

// ---------------------------------------------------------------------------
// Program builder (exported so tests can parse without spawning a subprocess).
// ---------------------------------------------------------------------------

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("jellyclaw")
    .description("jellyclaw — open-source Claude Code replacement")
    .version(readVersion(), "-v, --version", "print version and exit")
    .showHelpAfterError()
    .enablePositionalOptions()
    .exitOverride();

  // --- run ----------------------------------------------------------------
  const runCmd = program
    .command("run [prompt]")
    .description("dispatch a wish; stream AgentEvents to stdout");

  runCmd
    .option("--model <id>", "provider-agnostic model id")
    .addOption(
      new Option("--provider <name>", "route through the primary or secondary provider").choices([
        "primary",
        "secondary",
      ]),
    )
    .option("--mcp-config <path>", "override MCP config path")
    .addOption(
      new Option("--permission-mode <mode>", "permission policy for tool use").choices([
        "default",
        "acceptEdits",
        "bypassPermissions",
        "plan",
      ]),
    )
    .option("--max-turns <n>", "maximum assistant turns (integer)")
    .option("--max-cost-usd <n>", "abort when cumulative cost ≥ threshold (fractional USD)")
    .option("--output-format <format>", "stream-json | text | json | claude-stream-json")
    .option("--stream-stderr <format>", "structured stderr format (jsonl)")
    .option("--session-id <id>", "start with a specific session id")
    .option("--continue", "resume the newest session for this project")
    .option("--wish-id <id>", "idempotency key (cached wishes short-circuit)")
    .option("--append-system-prompt <text>", "concat to the system prompt")
    .option("--allowed-tools <csv>", "comma-separated tool allow-list")
    .option("--disallowed-tools <csv>", "comma-separated tool deny-list")
    .option("--add-dir <path...>", "extra search dir (repeatable)", [])
    .option("--cwd <path>", "run as-if cwd")
    .option("--config-dir <path>", "override config directory (default ~/.jellyclaw)")
    .option("--fallback-provider <name>", "provider to fall back to on failure")
    .option("--verbose", "verbose logging to stderr")
    .addOption(new Option("--resume <id>", "rehydrate a session by id").conflicts("continue"));

  runCmd.action(async (prompt: string | undefined, options: Record<string, unknown>) => {
    const { runAction } = await import("./run.js");
    await runAction(prompt, options);
  });

  // --- resume (sugar) -----------------------------------------------------
  program
    .command("resume <id> [prompt]")
    .description("rehydrate a session by id (sugar for `run --resume <id>`)")
    .action(async (id: string, prompt: string | undefined) => {
      const { resumeAction } = await import("./resume.js");
      await resumeAction(id, prompt);
    });

  // --- continue (sugar) ---------------------------------------------------
  program
    .command("continue [prompt]")
    .description("continue newest session for this project (sugar for `run --continue`)")
    .action(async (prompt: string | undefined) => {
      const { continueAction } = await import("./resume.js");
      await continueAction(prompt);
    });

  // --- serve --------------------------------------------------------------
  program
    .command("serve")
    .description("HTTP server (Hono + SSE). Bearer-auth required. Loopback-only by default.")
    .option("--port <n>", "port", "8765")
    .option("--host <addr>", "host", "127.0.0.1")
    .option(
      "--auth-token <token>",
      "bearer token (else OPENCODE_SERVER_PASSWORD, JELLYCLAW_TOKEN, auto-gen)",
    )
    .option(
      "--cors <origins>",
      'comma-separated CORS origins (use "" to disable CORS)',
      "http://localhost:*,http://127.0.0.1:*",
    )
    .option("--i-know-what-im-doing", "allow non-loopback bind")
    .option("--verbose", "verbose logging")
    .action(async (options: Record<string, unknown>) => {
      // Bun + Hono streamSSE is broken (chunked-encoding mismatch in
      // @hono/node-server 1.19.x). Warn but don't block — the user may have a
      // patched bun or not need SSE.
      if ((process.versions as Record<string, string | undefined>).bun !== undefined) {
        process.stderr.write(
          "[warn] Bun is not supported for 'jellyclaw serve' yet due to an SSE+chunked-encoding bug. Use 'jellyclaw-serve' (node) or 'node engine/dist/cli/main.js serve'. Tracked at: https://github.com/honojs/node-server.\n",
        );
      }
      const { serveAction } = await import("./serve.js");
      const code = await serveAction(options as Parameters<typeof serveAction>[0]);
      if (code !== 0) throw new ExitError(code);
    });

  // --- sessions (Phase 09.02 sub-dispatcher) ------------------------------
  program
    .command("sessions")
    .description("session inspection (list | search | show | rm | reindex)")
    .allowUnknownOption()
    .passThroughOptions()
    .argument("[args...]", "subcommand and flags forwarded to the dispatcher")
    .action(async (args: readonly string[] = []) => {
      const { sessionsCommand } = await import("./sessions.js");
      const code = await sessionsCommand(args);
      if (code !== 0) throw new ExitError(code);
    });

  // --- skills / agents / mcp ----------------------------------------------
  // These helpers return numeric exit codes (Phase 09 pattern). We bridge them
  // through ExitError so main()'s catch-block maps to the correct exit.
  const passExitCode = (code: number): void => {
    if (code !== 0) throw new ExitError(code);
  };

  const skills = program.command("skills").description("skill registry");
  skills
    .command("list")
    .description("list registered skills")
    .action(async () => {
      const mod = (await import("./skills-cmd.js")) as unknown as {
        skillsListAction: () => Promise<number>;
      };
      passExitCode(await mod.skillsListAction());
    });

  const agents = program.command("agents").description("agent registry");
  agents
    .command("list")
    .description("list registered agents")
    .action(async () => {
      const mod = (await import("./agents-cmd.js")) as unknown as {
        agentsListAction: () => Promise<number>;
      };
      passExitCode(await mod.agentsListAction());
    });

  const mcp = program.command("mcp").description("MCP tools");
  mcp
    .command("list")
    .description("list MCP tools")
    .action(async () => {
      const mod = (await import("./mcp-cmd.js")) as unknown as {
        mcpListAction: () => Promise<number>;
      };
      passExitCode(await mod.mcpListAction());
    });

  // --- config -------------------------------------------------------------
  const config = program.command("config").description("effective config");
  config
    .command("show")
    .description("print effective merged config")
    .option("--redact", "redact secrets (default: true)", true)
    .option("--no-redact", "show secrets verbatim")
    .action(async (options: { redact?: boolean }) => {
      const mod = (await import("./config-cmd.js")) as unknown as {
        configShowAction: (o: { redact: boolean }) => Promise<number>;
      };
      passExitCode(await mod.configShowAction({ redact: options.redact !== false }));
    });
  config
    .command("check")
    .description("lint rules for conflicts")
    .action(async () => {
      const mod = (await import("./config-cmd.js")) as unknown as {
        configCheckAction: () => Promise<number>;
      };
      passExitCode(await mod.configCheckAction());
    });

  // --- tui ----------------------------------------------------------------
  // Phase 10.5 Prompt 03: spawns an embedded engine server on a random free
  // port, waits for /v1/health, then hands off to the vendored TUI.
  const tuiCmd = program
    .command("tui")
    .description("launch the interactive terminal UI (Claude-Code-style)")
    .option("--cwd <path>", "run as-if cwd")
    .option("--model <id>", "provider-agnostic model id")
    .addOption(
      new Option("--provider <name>", "route through the primary or secondary provider").choices([
        "primary",
        "secondary",
      ]),
    )
    .option("--no-color", "disable ANSI colors (propagates to theme + spinner)")
    .option("--ascii", "ASCII-only spinner/glyphs")
    .option("--verbose", "verbose logging to stderr")
    .option("--continue", "resume newest session for this project");
  tuiCmd.addOption(new Option("--resume <id>", "rehydrate a session by id").conflicts("continue"));
  tuiCmd.action(async (options: Record<string, unknown>) => {
    const { tuiAction } = await import("./tui.js");
    type TuiFlags = NonNullable<Parameters<typeof tuiAction>[0]["flags"]>;
    const code = await tuiAction({
      args: ["tui"],
      flags: options as TuiFlags,
    });
    if (code !== 0) throw new ExitError(code);
  });

  const attachCmd = program
    .command("attach <url>")
    .description("attach the TUI to a running jellyclaw/opencode server")
    .option("--cwd <path>", "run as-if cwd")
    .option("--no-color", "disable ANSI colors")
    .option("--ascii", "ASCII-only glyphs")
    .option("--verbose", "verbose logging to stderr");
  attachCmd.action(async (url: string, options: Record<string, unknown>) => {
    const { tuiAction } = await import("./tui.js");
    type TuiFlags = NonNullable<Parameters<typeof tuiAction>[0]["flags"]>;
    const code = await tuiAction({
      args: ["attach", url],
      flags: options as TuiFlags,
    });
    if (code !== 0) throw new ExitError(code);
  });

  // --- key ----------------------------------------------------------------
  // Rotate/seed ANTHROPIC_API_KEY into ~/.jellyclaw/credentials.json without
  // launching the TUI. See `engine/src/cli/key-cmd.ts`.
  program
    .command("key")
    .description("set or rotate the stored ANTHROPIC_API_KEY (~/.jellyclaw/credentials.json)")
    .action(async () => {
      const mod = (await import("./key-cmd.js")) as unknown as {
        keyAction: () => Promise<number>;
      };
      passExitCode(await mod.keyAction());
    });

  // --- doctor -------------------------------------------------------------
  program
    .command("doctor")
    .description("diagnose install state (versions, patches, providers, MCP, SQLite)")
    .action(async () => {
      const mod = (await import("./doctor.js")) as unknown as {
        doctorAction: () => Promise<number>;
      };
      passExitCode(await mod.doctorAction());
    });

  return program;
}

// ---------------------------------------------------------------------------
// Error → exit-code mapping
// ---------------------------------------------------------------------------

export async function mapErrorToExitCode(err: unknown): Promise<number> {
  if (err instanceof ExitError) return err.code;
  if (err instanceof CommanderError) {
    const code = err.code;
    if (
      code === "commander.help" ||
      code === "commander.version" ||
      code === "commander.helpDisplayed"
    ) {
      return 0;
    }
    return 2;
  }
  // Known typed errors → 2 (user fixable). Lazy-imported so this file stays
  // cheap to load for `--help`.
  try {
    const engineMod = (await import("../index.js")) as {
      BindViolationError?: new (...a: never[]) => Error;
      OpenCodeVersionError?: new (...a: never[]) => Error;
    };
    if (engineMod.BindViolationError && err instanceof engineMod.BindViolationError) return 2;
    if (engineMod.OpenCodeVersionError && err instanceof engineMod.OpenCodeVersionError) return 2;
  } catch {
    /* ignore — fall through to generic */
  }
  try {
    const serverTypes = (await import("../server/types.js")) as {
      BindSafetyError?: new (...a: never[]) => Error;
      AuthTokenMissingError?: new (...a: never[]) => Error;
    };
    if (serverTypes.BindSafetyError && err instanceof serverTypes.BindSafetyError) return 2;
    if (serverTypes.AuthTokenMissingError && err instanceof serverTypes.AuthTokenMissingError) {
      return 2;
    }
  } catch {
    /* ignore */
  }
  return 1;
}

// ---------------------------------------------------------------------------
// main()
// ---------------------------------------------------------------------------

export async function main(argv: readonly string[]): Promise<number> {
  const program = buildProgram();
  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (err) {
    const code = await mapErrorToExitCode(err);
    if (code !== 0 && !(err instanceof CommanderError)) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`jellyclaw: ${message}\n`);
    }
    return code;
  }
}

// ---------------------------------------------------------------------------
// Self-invocation when loaded as the binary entry point.
// ---------------------------------------------------------------------------

const invokedDirectly: boolean = (() => {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    const here = fileURLToPath(import.meta.url);
    return (
      entry === here || entry.endsWith("/dist/cli/main.js") || entry.endsWith("/bin/jellyclaw")
    );
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  void main(process.argv.slice(2)).then((code) => {
    process.exit(code);
  });
}
