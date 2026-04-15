/**
 * `jellyclaw resume <id> [prompt]` and `jellyclaw continue [prompt]` — Phase 10.01.
 *
 * Thin sugar over the `run` action. We construct a `RunCliOptions` with the
 * corresponding flag pre-filled and invoke the shared handler so that all
 * flag semantics (stdin piping, output-format defaults, wish idempotency) stay
 * in one place.
 */

import { type RunCliOptions, runAction } from "./run.js";

/** `jellyclaw resume <id> [prompt]`. */
export async function resumeAction(id: string, prompt: string | undefined): Promise<void> {
  const options: RunCliOptions = { resume: id };
  await runAction(prompt, options);
}

/** `jellyclaw continue [prompt]`. */
export async function continueAction(prompt: string | undefined): Promise<void> {
  const options: RunCliOptions = { continue: true };
  await runAction(prompt, options);
}
