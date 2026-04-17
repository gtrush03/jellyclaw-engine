/**
 * Slash-command parser + dispatcher for the Ink TUI.
 *
 * The TUI's InputBox `onSubmit` routes any text beginning with `/` through
 * this module INSTEAD of sending it to the model. The dispatcher returns a
 * `CommandResult` which the caller folds back into the reducer (for
 * transcript-visible output) and/or consumes as a side-effect (exit, clear,
 * etc.).
 *
 * Pure parsing logic lives in `parseSlash`; the handlers in `./registry.ts`
 * carry the business logic and are invoked via `executeCommand`.
 */

import type { AgentEvent } from "../../events.js";
import type { JellyclawClient } from "../client.js";

// ---------------------------------------------------------------------------
// Parsed command shape
// ---------------------------------------------------------------------------

export interface ParsedCommand {
  /** Canonical command name, lowercased, without the leading `/`. */
  readonly name: string;
  /** Raw arg string (everything after the first whitespace), trimmed. */
  readonly argString: string;
  /** Whitespace-split args. */
  readonly args: readonly string[];
  /** Original raw input (including the `/`). */
  readonly raw: string;
}

/**
 * Parse a user-typed line. Returns `null` if the line does not start with `/`
 * (or is just a bare `/`), in which case the caller should treat the input
 * as a normal prompt to the model.
 */
export function parseSlash(input: string): ParsedCommand | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (trimmed.length < 2) return null;
  if (!trimmed.startsWith("/")) return null;

  const body = trimmed.slice(1); // drop leading /
  const firstSpace = body.search(/\s/);
  let name: string;
  let argString: string;
  if (firstSpace === -1) {
    name = body;
    argString = "";
  } else {
    name = body.slice(0, firstSpace);
    argString = body.slice(firstSpace).trim();
  }
  if (name.length === 0) return null;

  const args = argString.length === 0 ? [] : argString.split(/\s+/);
  return {
    name: name.toLowerCase(),
    argString,
    args,
    raw: trimmed,
  };
}

// ---------------------------------------------------------------------------
// Execution context + result
// ---------------------------------------------------------------------------

export interface CommandContext {
  readonly client: JellyclawClient;
  readonly cwd: string;
  readonly sessionId: string | null;
  readonly runId: string | null;
  readonly currentModel: string;
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens: number;
    readonly cacheWriteTokens: number;
    readonly costUsd: number;
  };
  /** Called to append a system-text line to the transcript. */
  readonly pushSystem: (text: string) => void;
  /** Called when a command wants to exit the app gracefully. */
  readonly exit: (code: number) => void;
  /** Called to dispatch a reducer action. */
  readonly dispatchAction: (action: UiCommandAction) => void;
  /** Called when the command produces a full replay — for /resume. */
  readonly dispatchEvent: (event: AgentEvent) => void;
}

/**
 * Reducer actions that commands may emit. These are a strict subset of
 * `UiAction` (plus new variants) — defined separately so we don't have a
 * circular dep with the reducer.
 */
export type UiCommandAction =
  | { readonly kind: "clear-transcript" }
  | { readonly kind: "new-session" }
  | { readonly kind: "set-model"; readonly model: string }
  | { readonly kind: "run-cancelled" }
  | { readonly kind: "open-modal"; readonly modal: "api-key" }
  | { readonly kind: "close-modal" };

export interface CommandResult {
  /**
   * `"ok"`  — handled, no further action needed.
   * `"unknown"` — parser recognized a `/cmd` but no registered handler
   *   matches. Caller should surface a "unknown command" message.
   */
  readonly status: "ok" | "unknown";
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

import { COMMANDS } from "./registry.js";

export async function executeCommand(
  cmd: ParsedCommand,
  ctx: CommandContext,
): Promise<CommandResult> {
  const def = COMMANDS.find((c) => c.name === cmd.name || (c.aliases ?? []).includes(cmd.name));
  if (def === undefined) {
    ctx.pushSystem(`unknown command: /${cmd.name} — type /help to list available commands`);
    return { status: "unknown" };
  }
  try {
    await def.handler(cmd, ctx);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.pushSystem(`/${cmd.name} failed: ${message}`);
  }
  return { status: "ok" };
}
