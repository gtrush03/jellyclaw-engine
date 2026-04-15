/**
 * jellyclaw CLI.
 *
 * Minimal on purpose. The CLI translates arg-parsing and exit codes; everything else
 * is in the library (`./index.ts`). If you find yourself adding business logic here,
 * move it.
 *
 * Usage:
 *   jellyclaw run "<wish>"      one-shot dispatch; streams events to stdout as NDJSON
 *   jellyclaw version           print version
 *   jellyclaw help              print help
 */

import { run } from "./index.js";
import { createLogger } from "./logger.js";

const VERSION = "0.0.1";

const USAGE = `jellyclaw ${VERSION}

USAGE
  jellyclaw run <wish>         Dispatch a wish; stream AgentEvent JSON to stdout.
  jellyclaw version            Print version and exit.
  jellyclaw help               Print this message and exit.

FLAGS (for \`run\`)
  --agent <name>               Agent name (default: "default").
  --cwd <path>                 Working directory (default: $PWD).
  --config <path>              Path to jellyclaw.json (default: ./jellyclaw.json if present).
  --pretty                     Pretty-print events instead of NDJSON.

ENV
  ANTHROPIC_API_KEY            Required for Anthropic provider (default).
  OPENROUTER_API_KEY           Required for OpenRouter provider.
  JELLYCLAW_LOG_LEVEL          trace|debug|info|warn|error|fatal|silent (default: info).
`;

// biome-ignore lint/suspicious/useAwait: Phase 2 will introduce awaited work
async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return 0;
  }

  if (command === "version" || command === "--version" || command === "-v") {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  if (command === "run") {
    return runCommand(rest);
  }

  process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
  return 2;
}

async function runCommand(argv: readonly string[]): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  const wish = positional.join(" ").trim();
  if (!wish) {
    process.stderr.write("jellyclaw run: missing <wish>\n");
    return 2;
  }

  const pretty = flags.pretty === "true";

  try {
    const runOpts: Parameters<typeof run>[0] = { wish };
    const agent = flags.agent;
    if (agent !== undefined) runOpts.agent = agent;
    const cwd = flags.cwd;
    if (cwd !== undefined) runOpts.cwd = cwd;
    const configPath = flags.config;
    if (configPath !== undefined) runOpts.configPath = configPath;

    for await (const event of run(runOpts)) {
      if (pretty) {
        process.stdout.write(`[${event.type}] ${JSON.stringify(event, null, 2)}\n`);
      } else {
        process.stdout.write(`${JSON.stringify(event)}\n`);
      }
    }
    return 0;
  } catch (err) {
    const log = createLogger({ name: "jellyclaw-cli" });
    log.error({ err }, "run failed");
    return 1;
  }
}

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string>;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[name] = next;
        i++;
      } else {
        flags[name] = "true";
      }
    } else {
      positional.push(arg);
    }
  }

  return { positional, flags };
}

// ---------------------------------------------------------------------------

main(process.argv.slice(2))
  .then((code) => {
    process.exit(code);
  })
  .catch((err: unknown) => {
    process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
