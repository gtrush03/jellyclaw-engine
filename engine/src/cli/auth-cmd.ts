/**
 * Auth subcommands for jellyclaw CLI (T3-10).
 *
 * Commands:
 * - `jellyclaw auth login-subscription` — run `claude setup-token`, save to credentials
 * - `jellyclaw auth logout-subscription` — remove subscription field from credentials
 * - `jellyclaw auth status` — print which auth modes are present (never print tokens)
 */

import { Command } from "commander";
import { obtainSubscriptionCredentials } from "../providers/subscription-auth.js";
import { type Credentials, loadCredentials, updateCredentials } from "./credentials.js";

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export async function loginSubscriptionAction(): Promise<number> {
  process.stdout.write("Starting Claude subscription login...\n");
  process.stdout.write("This will open a browser for OAuth authentication.\n\n");

  try {
    const subscription = await obtainSubscriptionCredentials({
      stdio: "inherit",
      timeoutMs: 120_000,
    });

    await updateCredentials({ subscription });

    process.stdout.write("\n");
    process.stdout.write("Subscription credentials saved to ~/.jellyclaw/credentials.json\n");
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`\nFailed to obtain subscription credentials: ${message}\n`);
    process.stderr.write("\nMake sure the Claude CLI is installed: https://claude.ai/download\n");
    return 1;
  }
}

export async function logoutSubscriptionAction(): Promise<number> {
  const creds = await loadCredentials();

  if (creds.subscription === undefined) {
    process.stdout.write("No subscription credentials found.\n");
    return 0;
  }

  // Remove subscription field, preserve others
  const updated: Credentials = { ...creds };
  delete (updated as { subscription?: unknown }).subscription;

  const { saveCredentials } = await import("./credentials.js");
  await saveCredentials(updated);

  process.stdout.write("Subscription credentials removed from ~/.jellyclaw/credentials.json\n");
  process.stdout.write("API key credentials (if any) were preserved.\n");
  return 0;
}

export async function statusAction(): Promise<number> {
  const creds = await loadCredentials();

  process.stdout.write("jellyclaw auth status:\n\n");

  // Anthropic API key
  if (creds.anthropicApiKey !== undefined && creds.anthropicApiKey.length > 0) {
    process.stdout.write(`  Anthropic API key: present (${creds.anthropicApiKey.length} chars)\n`);
  } else {
    process.stdout.write("  Anthropic API key: not set\n");
  }

  // OpenAI API key
  if (creds.openaiApiKey !== undefined && creds.openaiApiKey.length > 0) {
    process.stdout.write(`  OpenAI API key: present (${creds.openaiApiKey.length} chars)\n`);
  } else {
    process.stdout.write("  OpenAI API key: not set\n");
  }

  // Subscription
  if (creds.subscription !== undefined) {
    const sub = creds.subscription;
    const obtainedDate = new Date(sub.obtainedAt).toISOString();
    process.stdout.write(`  Subscription OAuth: present (obtained ${obtainedDate})\n`);
    if (sub.expiresAt !== undefined) {
      const expiresDate = new Date(sub.expiresAt).toISOString();
      const now = Date.now();
      if (sub.expiresAt < now) {
        process.stdout.write(`    Expired at: ${expiresDate} (re-login required)\n`);
      } else {
        process.stdout.write(`    Expires at: ${expiresDate}\n`);
      }
    }
  } else {
    process.stdout.write("  Subscription OAuth: not set\n");
  }

  process.stdout.write("\n");
  return 0;
}

// ---------------------------------------------------------------------------
// Command builder (for registration in main.ts)
// ---------------------------------------------------------------------------

export function buildAuthCommand(): Command {
  const auth = new Command("auth").description("manage authentication credentials");

  auth
    .command("login-subscription")
    .description("login via Claude Pro/Max subscription OAuth")
    .action(async () => {
      const code = await loginSubscriptionAction();
      if (code !== 0) {
        const { ExitError } = await import("./main.js");
        throw new ExitError(code);
      }
    });

  auth
    .command("logout-subscription")
    .description("remove subscription credentials (preserves API keys)")
    .action(async () => {
      const code = await logoutSubscriptionAction();
      if (code !== 0) {
        const { ExitError } = await import("./main.js");
        throw new ExitError(code);
      }
    });

  auth
    .command("status")
    .description("show which auth modes are configured (never prints tokens)")
    .action(async () => {
      const code = await statusAction();
      if (code !== 0) {
        const { ExitError } = await import("./main.js");
        throw new ExitError(code);
      }
    });

  return auth;
}
