/**
 * Jellyclaw credentials store.
 *
 * Purpose
 * -------
 * On first run the TUI asks the user to paste their provider API keys and
 * persists them under `~/.jellyclaw/credentials.json` (mode 0600, dir 0700)
 * so subsequent launches start silently.
 *
 * Security contract
 * -----------------
 *  - File is written atomically: write to `.tmp` then `rename()`.
 *  - File mode is forced to 0o600 (user r/w only). Dir is 0o700.
 *  - Content is validated through a zod schema on read. Invalid JSON or
 *    schema-mismatched content degrades to an empty `{}` — we never throw
 *    on a corrupt creds file because that would brick the TUI.
 *  - Never log field values; `apiKey`/`anthropicApiKey` are already in the
 *    pino redact list (see `engine/src/logger.ts`).
 *
 * Test hooks
 * ----------
 *  - `JELLYCLAW_CREDENTIALS_PATH` env var overrides the default path. Intended
 *    for tests only (vitest swaps it via `process.env` before import).
 */

import { constants as fsConstants } from "node:fs";
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { z } from "zod";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const CredentialsSchema = z.object({
  anthropicApiKey: z.string().min(10).optional(),
  openaiApiKey: z.string().min(10).optional(),
});

export type Credentials = z.infer<typeof CredentialsSchema>;

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

export function defaultCredentialsDir(): string {
  const override = process.env.JELLYCLAW_CREDENTIALS_PATH;
  if (typeof override === "string" && override.length > 0) {
    return dirname(override);
  }
  return join(homedir(), ".jellyclaw");
}

export function defaultCredentialsPath(): string {
  const override = process.env.JELLYCLAW_CREDENTIALS_PATH;
  if (typeof override === "string" && override.length > 0) {
    return override;
  }
  return join(defaultCredentialsDir(), "credentials.json");
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

/**
 * Read credentials from disk. Returns `{}` if the file is missing, unreadable,
 * not valid JSON, or fails schema validation. Never throws.
 */
export async function loadCredentials(path?: string): Promise<Credentials> {
  const filePath = path ?? defaultCredentialsPath();
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  const result = CredentialsSchema.safeParse(parsed);
  if (!result.success) return {};
  return result.data;
}

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

/**
 * Persist credentials atomically. Validates through the zod schema before
 * writing — callers cannot smuggle extra fields in.
 */
export async function saveCredentials(creds: Credentials, path?: string): Promise<void> {
  const parsed = CredentialsSchema.parse(creds);
  const filePath = path ?? defaultCredentialsPath();
  const dir = dirname(filePath);

  await mkdir(dir, { recursive: true, mode: 0o700 });
  // mkdir with existing dir does not reset mode; enforce explicitly.
  try {
    await chmod(dir, 0o700);
  } catch {
    /* best-effort on platforms that reject chmod */
  }

  const tmpPath = `${filePath}.tmp`;
  const body = `${JSON.stringify(parsed, null, 2)}\n`;
  // `mode` on writeFile applies only on file creation; still chmod after to
  // be safe if the tmp path already exists.
  await writeFile(tmpPath, body, { mode: 0o600, flag: "w" });
  try {
    await chmod(tmpPath, 0o600);
  } catch {
    /* best-effort */
  }
  await rename(tmpPath, filePath);
  try {
    await chmod(filePath, 0o600);
  } catch {
    /* best-effort */
  }
}

/**
 * Merge-and-save: updates only the fields provided, preserves the rest.
 */
export async function updateCredentials(
  patch: Credentials,
  path?: string,
): Promise<Credentials> {
  const current = await loadCredentials(path);
  const merged: Credentials = { ...current, ...patch };
  await saveCredentials(merged, path);
  return merged;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns true iff the credentials file exists and is readable by the current
 * process. Does not validate content — use `loadCredentials` for that.
 */
export async function credentialsFileExists(path?: string): Promise<boolean> {
  const filePath = path ?? defaultCredentialsPath();
  try {
    const s = await stat(filePath);
    if (!s.isFile()) return false;
    // Accessible?
    const { access } = await import("node:fs/promises");
    await access(filePath, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}
