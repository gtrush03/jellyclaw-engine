/**
 * Dispatch-time safety gate for the provider layer.
 *
 * Per `engine/provider-research-notes.md` §10 decision table:
 *   - provider=anthropic: ALWAYS allow (no gate).
 *   - provider=openrouter + non-Anthropic model: allow regardless of gate
 *     (the intended OR use case; non-Anthropic models don't hit the
 *     caching regressions documented in issues #1245 / #17910).
 *   - provider=openrouter + Anthropic model + gate=false: THROW.
 *   - provider=openrouter + Anthropic model + gate=true: allow. The
 *     accompanying warning is the OpenRouterProvider's responsibility;
 *     this helper only enforces the refusal path.
 *
 * Unlike `assertCachingGate(config)` in config/loader.ts, this helper
 * takes an EXPLICIT `model` argument because the router may dispatch a
 * model other than `config.model` (per-call override). Consumers should
 * pass the model that is actually about to be invoked.
 */

import { CachingGateError } from "../config/loader.js";
import type { Config } from "../config/schema.js";

export { CachingGateError };

/** Matches `anthropic/*` OpenRouter slugs and bare `claude-*` / `claude_*` ids. */
function isAnthropicModel(model: string): boolean {
  return model.startsWith("anthropic/") || /^claude[-_]/i.test(model);
}

/**
 * Enforces the `acknowledgeCachingLimits` gate at dispatch time.
 * Throws `CachingGateError` for the forbidden combination; otherwise
 * returns void.
 */
export function enforceCachingGate(config: Config, model: string): void {
  if (config.provider !== "openrouter") return;
  if (isAnthropicModel(model) && !config.acknowledgeCachingLimits) {
    throw new CachingGateError(model);
  }
}
