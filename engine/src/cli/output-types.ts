/**
 * Phase 10.01 — frozen contract between `run.ts` (producer) and `output.ts` (writers).
 *
 * Do not inline any formatter logic here; this file is types + one pure resolver only.
 * Agents A (run) and B (output) both import from this file and must not mutate the
 * shape. If Phase 10.02 needs additional fields, extend — don't break.
 */

import type { AgentEvent } from "../events.js";

export type OutputFormat = "stream-json" | "text" | "json" | "claude-stream-json";

export const OUTPUT_FORMATS: readonly OutputFormat[] = [
  "stream-json",
  "text",
  "json",
  "claude-stream-json",
] as const;

export function isOutputFormat(value: unknown): value is OutputFormat {
  return typeof value === "string" && (OUTPUT_FORMATS as readonly string[]).includes(value);
}

/**
 * One handler per run; `finish()` flushes any buffered state (json format) and must
 * be awaited before the CLI exits. `write()` must be serialized internally — callers
 * may `await` sequentially without an external lock.
 */
export interface OutputWriter {
  write(event: AgentEvent): Promise<void>;
  finish(): Promise<void>;
}

export interface CreateOutputWriterOptions {
  readonly format: OutputFormat;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  /**
   * When true, `text` format also mirrors tool events to stderr as
   * `[tool: <Name>] <stringified-input>` lines. Ignored by stream-json and json.
   */
  readonly verbose: boolean;
}

/**
 * Default when `--output-format` is not given:
 *   - TTY → "text"
 *   - piped/redirected → "stream-json"
 * Explicit flag always wins.
 */
export function resolveOutputFormat(flagValue: string | undefined, isTTY: boolean): OutputFormat {
  if (flagValue === undefined) return isTTY ? "text" : "stream-json";
  if (!isOutputFormat(flagValue)) {
    throw new Error(
      `invalid --output-format "${flagValue}": must be one of ${OUTPUT_FORMATS.join(", ")}`,
    );
  }
  return flagValue;
}
