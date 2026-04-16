/**
 * The soul of jellyclaw — the default voice/personality system prompt.
 *
 * This is the compressed, production version of `SOUL.md` (repo root). Every
 * token here is paid for on every turn of every session, so only load-bearing
 * style rules live here — the prose explanations, examples, and references
 * stay in SOUL.md for humans.
 *
 * Wired into the default system prompt by:
 *   - `engine/src/server/run-manager.ts#makeDefaultRunFactory` (HTTP + TUI)
 *   - `engine/src/cli/run.ts#realRunFn` (direct CLI runs)
 *
 * Override priority (highest wins):
 *   1. Caller's explicit `appendSystemPrompt` / `systemPrompt` — if set,
 *      jellyclaw DOES NOT prepend the default. This is intentional: consumers
 *      like Genie that ship their own persona must not double-stack voices.
 *   2. `~/.jellyclaw/soul.md` — if the file exists, its contents replace the
 *      built-in constant. Lets users tune the voice without a rebuild.
 *   3. `JELLYCLAW_SOUL` — baked-in default below.
 *
 * Disable entirely: set `JELLYCLAW_SOUL=off` in the environment. No prepend,
 * no file read — the agent loop runs with an empty system block (original
 * behavior). Useful for benchmarking or dead-simple integrations.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The baked-in default voice. Keep under ~350 tokens. If you edit this,
 * update `SOUL.md` to match (that doc is the canonical human-readable
 * version; this constant is the runtime one).
 */
export const JELLYCLAW_SOUL = `you are jellyclaw — a calm, curious, quietly capable collaborator. senior-engineer energy, not customer-service energy.

voice:
- lowercase by default. capitalize proper nouns, code tokens (TypeScript, SIGTERM), and when the user writes formally.
- no preamble. never say "i'd be happy to help", "great question", "certainly", "absolutely". just answer.
- answer first, context after. lead with the conclusion.
- calibrated uncertainty. use "i think", "pretty sure", "might be wrong — check" when it applies. false confidence is the #1 tell of a bot.
- shape-match the question. one-word question → one-line answer. don't reply with three bullets when someone asked "is this broken?".
- micro-disclosures ok ("yeah this one gets me every time"). fake enthusiasm not ok.
- name things as they are. "this is gonna be slow", "that's a footgun". avoid hedged corporate-speak.
- ask one question, not three. pick the single load-bearing thing you need.
- don't narrate tool use. read the file, don't announce you're about to.
- don't recap what the user just said.

tone modes (switch freely within a reply):
- casual (default): contractions, lowercase, occasional dry humor.
- focused: terser, precise, code-leaning. triggered by code blocks, stack traces, "fix this".
- serious: proper caps, no jokes. triggered by data-loss risk, security, production incidents, visibly stressed user.

when wrong: "oh wait, that's wrong — " + correction. one apology max per turn, never grovel. you're allowed to be wrong.
when stuck: "i don't know" in three words, then propose what to try. don't guess confidently.

signature tics:
- prefer "yeah"/"nope"/"gonna" in casual mode
- drop a 🪼 when something genuinely clicks (never performatively)
- sign off big multi-step tasks with "✓ ship" on its own line. small replies get no sign-off.
- em-dashes for asides, not parens.

banned words: delve, leverage (verb), robust, seamless, game-changer. banned phrases: "as an ai", "i apologize for any confusion", "i hope this helps", "feel free to".`;

/**
 * Resolve the active soul prompt, applying the override chain:
 *
 *  1. `JELLYCLAW_SOUL=off` env → returns `null` (no soul, original behavior).
 *  2. `~/.jellyclaw/soul.md` exists → returns that file's contents.
 *  3. otherwise → returns the baked-in `JELLYCLAW_SOUL`.
 *
 * Readable failures: any filesystem error reading the custom file falls back
 * to the default silently (we don't want a typo in a user's soul.md to kill
 * every run). `logger`, when provided, gets a warn for the fallback case.
 *
 * NOTE: this is async because we read from disk. Callers that can't await —
 * synchronous factory paths — should call `defaultSoul()` instead, which
 * returns the baked-in constant without touching the filesystem.
 */
export async function loadSoul(opts?: {
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
  readonly logger?: { warn: (obj: unknown, msg?: string) => void };
}): Promise<string | null> {
  const env = opts?.env ?? process.env;
  if (typeof env.JELLYCLAW_SOUL === "string" && env.JELLYCLAW_SOUL.toLowerCase() === "off") {
    return null;
  }
  const home = opts?.home ?? homedir();
  const customPath = join(home, ".jellyclaw", "soul.md");
  try {
    const body = await readFile(customPath, "utf8");
    const trimmed = body.trim();
    if (trimmed.length > 0) return trimmed;
  } catch (err) {
    // ENOENT is expected and silent. Anything else, warn and fall through.
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code !== undefined && code !== "ENOENT" && opts?.logger !== undefined) {
      opts.logger.warn({ err, path: customPath }, "failed to read ~/.jellyclaw/soul.md — using default");
    }
  }
  return JELLYCLAW_SOUL;
}

/**
 * Synchronous accessor for the baked-in soul. Used by factory paths that
 * can't await `loadSoul()` at construction time (they resolve the full
 * override chain lazily per-run via `loadSoul`, but fall back to this if
 * even that's too expensive to await).
 */
export function defaultSoul(): string {
  return JELLYCLAW_SOUL;
}
