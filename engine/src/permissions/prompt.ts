/**
 * Stdin ask-handler for the permission engine.
 *
 * In a TTY context we prompt the user [y/N/a] and resolve to `allow`/`deny`.
 * In a non-TTY context (CI, piped input) we immediately return `deny` with a
 * single-line stderr warning. We never block indefinitely; we never silently
 * allow. Hook-driven / GUI ask-handlers land in Phase 10.
 */

import { createInterface } from "node:readline";
import type { AskContext, AskHandler, ToolCall } from "./types.js";

export interface CreateStdinAskHandlerOptions {
  readonly tty?: NodeJS.ReadStream;
  readonly out?: NodeJS.WriteStream;
  readonly err?: NodeJS.WriteStream;
}

function shortInputSummary(call: ToolCall): string {
  const { input } = call;
  const cmd = input["command"];
  if (typeof cmd === "string") return cmd.slice(0, 80);
  const fp = input["file_path"] ?? input["path"] ?? input["pattern"];
  if (typeof fp === "string") return fp.slice(0, 120);
  const url = input["url"];
  if (typeof url === "string") return url.slice(0, 120);
  try {
    return JSON.stringify(input).slice(0, 120);
  } catch {
    return "";
  }
}

function formatPrompt(call: ToolCall, ctx: AskContext): string {
  const matched = ctx.matchedRule?.source ?? "(no rule — mode fallback)";
  const summary = shortInputSummary(call);
  return [
    `jellyclaw: allow ${call.name} ${summary}? [y/N/a]`,
    `  mode: ${ctx.mode}`,
    `  matched rule: ${matched}`,
    `  reason: ${ctx.reason}`,
    "",
  ].join("\n");
}

/**
 * Build an `AskHandler` that prompts on stdin. Non-TTY always denies.
 */
export function createStdinAskHandler(opts: CreateStdinAskHandlerOptions = {}): AskHandler {
  const tty = opts.tty ?? process.stdin;
  const out = opts.out ?? process.stdout;
  const err = opts.err ?? process.stderr;

  return async (call, ctx) => {
    if (!tty.isTTY) {
      err.write(`jellyclaw: non-TTY context; refusing ${call.name} (reason: ${ctx.reason})\n`);
      return "deny";
    }

    out.write(formatPrompt(call, ctx));

    const rl = createInterface({ input: tty, output: out, terminal: false });
    try {
      const answer: string = await new Promise((resolve) => {
        rl.once("line", (line) => resolve(line));
        rl.once("close", () => resolve(""));
      });
      const normalized = answer.trim().toLowerCase();
      if (normalized === "y" || normalized === "yes" || normalized === "a") {
        return "allow";
      }
      return "deny";
    } finally {
      rl.close();
    }
  };
}
