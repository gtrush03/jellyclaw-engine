/**
 * Structured logger. All engine code logs through here — never `console.log`.
 *
 * The pino `redact` list scrubs known-sensitive fields before output. If you add a
 * config key or env var that holds a secret, add its path here in the same commit.
 */

import { type Logger, pino, destination as pinoDestination } from "pino";

const DEFAULT_REDACT = [
  "apiKey",
  "api_key",
  "password",
  "authorization",
  "Authorization",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENCODE_SERVER_PASSWORD",
  "anthropicApiKey",
  "openaiApiKey",
  "token",
  "credentials",
  "*.apiKey",
  "*.api_key",
  "*.anthropicApiKey",
  "*.openaiApiKey",
  "*.password",
  "*.token",
  "*.credentials",
  "headers.authorization",
  "headers.Authorization",
  "headers.x-api-key",
  "headers['x-api-key']",
];

export interface CreateLoggerOptions {
  level?: string;
  pretty?: boolean;
  redact?: string[];
  name?: string;
  /**
   * Where to write log lines. Defaults to "stderr" so NDJSON event streams on
   * stdout (`--output-format stream-json`) stay pure. Pass "stdout" to keep
   * legacy behavior.
   */
  destination?: "stdout" | "stderr";
}

export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const level = options.level ?? process.env.JELLYCLAW_LOG_LEVEL ?? "info";
  const destination = options.destination ?? "stderr";
  // pino-pretty writes via its own transport; it doesn't compose with an
  // explicit destination stream. Only enable pretty when we can let pino own
  // the output (i.e. default stdout routing).
  const canPretty = destination === "stdout";
  const pretty =
    options.pretty ?? (canPretty && process.env.NODE_ENV !== "production" && process.stdout.isTTY);

  const baseOpts = {
    name: options.name ?? "jellyclaw",
    level,
    redact: {
      paths: [...DEFAULT_REDACT, ...(options.redact ?? [])],
      censor: "[redacted]",
    },
    ...(pretty && {
      transport: {
        target: "pino-pretty",
        options: { colorize: true, singleLine: false, translateTime: "HH:MM:ss.l" },
      },
    }),
  };

  if (destination === "stderr") {
    // fd=2 → stderr. sync:false avoids blocking on slow terminals.
    return pino(baseOpts, pinoDestination({ dest: 2, sync: false }));
  }
  return pino(baseOpts);
}

export type { Logger } from "pino";

// Shared default instance for quick use. Library consumers should prefer to make their own.
export const logger: Logger = createLogger();
