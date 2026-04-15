/**
 * Structured logger. All engine code logs through here — never `console.log`.
 *
 * The pino `redact` list scrubs known-sensitive fields before output. If you add a
 * config key or env var that holds a secret, add its path here in the same commit.
 */

import { type Logger, pino } from "pino";

const DEFAULT_REDACT = [
  "apiKey",
  "api_key",
  "password",
  "authorization",
  "Authorization",
  "ANTHROPIC_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENCODE_SERVER_PASSWORD",
  "*.apiKey",
  "*.api_key",
  "*.password",
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
}

export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const level = options.level ?? process.env.JELLYCLAW_LOG_LEVEL ?? "info";
  const pretty = options.pretty ?? (process.env.NODE_ENV !== "production" && process.stdout.isTTY);

  return pino({
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
  });
}

export type { Logger } from "pino";

// Shared default instance for quick use. Library consumers should prefer to make their own.
export const logger: Logger = createLogger();
