/**
 * `jellyclaw key` — rotate (or seed) the stored ANTHROPIC_API_KEY without
 * launching the TUI. Equivalent to deleting ~/.jellyclaw/credentials.json
 * and re-running `jellyclaw tui`, but non-destructive: if the user aborts
 * (Ctrl+C / empty input) the existing key is preserved.
 *
 * We expose this as a top-level subcommand because modifying the vendored
 * OpenCode TUI's slash-command registry to inject a `/key` handler would
 * reach deep into Solid-rendered components — not worth the patch debt at
 * this phase. `jellyclaw key` covers the same user need (rotation without
 * exiting-then-editing a file) and runs pre-TUI so stdio is free for the
 * paste prompt.
 *
 * Exit codes:
 *   0   key saved (or user explicitly skipped with existing key preserved)
 *   1   unexpected error (fs failure, etc.)
 *   130 Ctrl+C during prompt
 */

import { loadCredentials, updateCredentials } from "./credentials.js";
import { promptRotateApiKey } from "./credentials-prompt.js";

export async function keyAction(): Promise<number> {
  try {
    const existing = await loadCredentials();
    const result = await promptRotateApiKey();
    if (result.kind === "cancelled") return 130;
    if (result.kind === "skipped") {
      if (existing.anthropicApiKey === undefined) {
        process.stderr.write("jellyclaw key: no key provided and none on file — nothing to do\n");
      }
      return 0;
    }
    await updateCredentials({ anthropicApiKey: result.value });
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`jellyclaw key: ${msg}\n`);
    return 1;
  }
}
