/**
 * Claude Pro/Max subscription OAuth authentication (T3-10).
 *
 * Provides utilities for:
 * - Obtaining subscription credentials via `claude setup-token`
 * - Selecting the appropriate auth source based on role
 *
 * Security notes:
 * - Tokens are NEVER logged
 * - File permissions mirror credentials.ts (0600 file, 0700 dir)
 */

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import type { Credentials, SubscriptionCredentials } from "../cli/credentials.js";

// ---------------------------------------------------------------------------
// Claude CLI credentials file schema
// ---------------------------------------------------------------------------

const ClaudeCredentialsSchema = z.object({
  claudeAiOauth: z
    .object({
      accessToken: z.string().min(1),
      refreshToken: z.string().min(1).optional(),
      expiresAt: z.number().optional(),
    })
    .optional(),
});

// ---------------------------------------------------------------------------
// Obtain subscription credentials
// ---------------------------------------------------------------------------

export interface ObtainSubscriptionOptions {
  /** Path to the claude binary. Default: "claude" */
  readonly claudeBinary?: string;
  /** Timeout in ms for the interactive flow. Default: 120_000 (2 min) */
  readonly timeoutMs?: number;
  /** stdio mode. Default: "inherit" for interactive OAuth browser flow */
  readonly stdio?: "inherit" | "pipe";
  /** Abort signal */
  readonly signal?: AbortSignal;
}

/**
 * Run `claude setup-token` to obtain subscription credentials.
 * After the command completes, reads the Claude CLI's credentials file.
 */
export async function obtainSubscriptionCredentials(
  opts: ObtainSubscriptionOptions = {},
): Promise<SubscriptionCredentials> {
  const { claudeBinary = "claude", timeoutMs = 120_000, stdio = "inherit", signal } = opts;

  // Run claude setup-token
  await runClaudeSetupToken({
    claudeBinary,
    timeoutMs,
    stdio,
    ...(signal !== undefined ? { signal } : {}),
  });

  // Read the Claude CLI credentials file
  const claudeCredsPath = join(homedir(), ".claude", ".credentials.json");
  let raw: string;
  try {
    raw = await readFile(claudeCredsPath, "utf8");
  } catch (err) {
    throw new Error(
      `Failed to read Claude credentials file at ${claudeCredsPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Claude credentials file is not valid JSON: ${claudeCredsPath}`);
  }

  const result = ClaudeCredentialsSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Claude credentials file has invalid schema: ${result.error.message}`);
  }

  const oauth = result.data.claudeAiOauth;
  if (oauth === undefined || oauth.accessToken.length === 0) {
    throw new Error("No OAuth credentials found in Claude credentials file");
  }

  return {
    kind: "oauth",
    accessToken: oauth.accessToken,
    ...(oauth.refreshToken !== undefined ? { refreshToken: oauth.refreshToken } : {}),
    ...(oauth.expiresAt !== undefined ? { expiresAt: oauth.expiresAt } : {}),
    obtainedAt: Date.now(),
  };
}

function runClaudeSetupToken(opts: {
  claudeBinary: string;
  timeoutMs: number;
  stdio: "inherit" | "pipe";
  signal?: AbortSignal;
}): Promise<void> {
  const { claudeBinary, timeoutMs, stdio, signal } = opts;

  return new Promise((resolve, reject) => {
    const child = spawn(claudeBinary, ["setup-token"], {
      stdio,
      env: { ...process.env },
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    const onAbort = (): void => {
      child.kill("SIGTERM");
      reject(new Error("Aborted"));
    };

    if (signal !== undefined) {
      signal.addEventListener("abort", onAbort, { once: true });
    }

    child.on("error", (err) => {
      clearTimeout(timer);
      if (signal !== undefined) {
        signal.removeEventListener("abort", onAbort);
      }
      reject(new Error(`Failed to spawn ${claudeBinary}: ${err.message}`));
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (signal !== undefined) {
        signal.removeEventListener("abort", onAbort);
      }
      if (timedOut) {
        reject(new Error(`${claudeBinary} setup-token timed out after ${timeoutMs}ms`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`${claudeBinary} setup-token exited with code ${code ?? "unknown"}`));
        return;
      }
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// Auth selection
// ---------------------------------------------------------------------------

export type JellyclawRole = "worker" | "tester" | "default";

export type AuthSelection =
  | { kind: "subscription"; token: string }
  | { kind: "apiKey"; key: string }
  | null;

/**
 * Select auth source for a given role.
 *
 * - `worker`: subscription required, errors if missing
 * - `tester`: apiKey preferred, falls back to subscription
 * - `default`: apiKey preferred, falls back to subscription
 *
 * Never logs the token value.
 */
export function selectAuth(creds: Credentials, role: JellyclawRole): AuthSelection {
  const hasSubscription =
    creds.subscription !== undefined && creds.subscription.accessToken.length > 0;
  const hasApiKey = creds.anthropicApiKey !== undefined && creds.anthropicApiKey.length > 0;

  switch (role) {
    case "worker":
      // Workers MUST use subscription
      if (hasSubscription && creds.subscription !== undefined) {
        return { kind: "subscription", token: creds.subscription.accessToken };
      }
      return null; // Caller should error with actionable message

    case "tester":
      // Testers prefer API key, fall back to subscription
      if (hasApiKey && creds.anthropicApiKey !== undefined) {
        return { kind: "apiKey", key: creds.anthropicApiKey };
      }
      if (hasSubscription && creds.subscription !== undefined) {
        return { kind: "subscription", token: creds.subscription.accessToken };
      }
      return null;

    default:
      // Default: API key preferred, fall back to subscription
      if (hasApiKey && creds.anthropicApiKey !== undefined) {
        return { kind: "apiKey", key: creds.anthropicApiKey };
      }
      if (hasSubscription && creds.subscription !== undefined) {
        return { kind: "subscription", token: creds.subscription.accessToken };
      }
      return null;
  }
}

/**
 * Parse the JELLYCLAW_ROLE environment variable.
 */
export function parseRole(env: string | undefined): JellyclawRole {
  if (env === "worker" || env === "tester") {
    return env;
  }
  return "default";
}

/**
 * Scrub ANTHROPIC_API_KEY from env when using subscription auth.
 * This mirrors the Jelly-Claw dispatcher pattern to avoid silent override.
 */
export function scrubEnvForSubscription(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const result = { ...env };
  delete result.ANTHROPIC_API_KEY;
  return result;
}
