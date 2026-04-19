/**
 * Model registry + resolver.
 *
 * Centralises the list of real Anthropic model ids jellyclaw is willing to
 * dispatch, plus a small priority-based resolver used by `cli/run.ts` and
 * `cli/serve.ts`. Having a single source of truth means a typo in `--model`
 * or `~/.jellyclaw/config.json` is caught at resolution time rather than
 * silently shipped to the provider (which rejects it).
 *
 * Priority (highest wins): flag → config.json → env → DEFAULT_MODEL.
 *
 * Not namespaced by provider on purpose — Phase 0/T0 is Anthropic-only and a
 * multi-provider registry is out of scope.
 */

export const KNOWN_MODELS = [
  // 4.7 family — April 2026 (current latest)
  "claude-opus-4-7",
  "claude-sonnet-4-7",
  "claude-haiku-4-7",
  // 4.6 family — Feb 2026
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-haiku-4-6",
  // 4.5 family — late 2025 (kept for back-compat)
  "claude-sonnet-4-5",
  "claude-opus-4-5",
  "claude-haiku-4-5",
] as const;

export type KnownModel = (typeof KNOWN_MODELS)[number];

export const DEFAULT_MODEL: KnownModel = "claude-opus-4-7";

export class InvalidModelError extends Error {
  readonly modelId: string;
  constructor(modelId: string) {
    super(`unknown model id: "${modelId}". Known models: ${KNOWN_MODELS.join(", ")}.`);
    this.name = "InvalidModelError";
    this.modelId = modelId;
  }
}

export function isKnownModel(id: string): id is KnownModel {
  return (KNOWN_MODELS as readonly string[]).includes(id);
}

export interface ResolveModelOptions {
  readonly flag?: string;
  readonly configModel?: string;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Resolves the model id for a single run.
 *
 * Priority order (first non-empty wins):
 *   1. `opts.flag`           — `--model` CLI flag
 *   2. `opts.configModel`    — `~/.jellyclaw/config.json` `model` field
 *   3. `opts.env.ANTHROPIC_DEFAULT_MODEL`
 *   4. `DEFAULT_MODEL`
 *
 * Throws `InvalidModelError` if the resolved id is not in `KNOWN_MODELS`.
 */
export function resolveModel(opts: ResolveModelOptions = {}): KnownModel {
  const envValue = opts.env?.ANTHROPIC_DEFAULT_MODEL;
  const candidate =
    firstNonEmpty(opts.flag) ??
    firstNonEmpty(opts.configModel) ??
    firstNonEmpty(envValue) ??
    DEFAULT_MODEL;
  if (!isKnownModel(candidate)) {
    throw new InvalidModelError(candidate);
  }
  return candidate;
}

function firstNonEmpty(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Returns the model family tier ("4-5" | "4-6" | "4-7") for a given model id,
 * or `null` if the id does not match the `claude-(opus|sonnet|haiku)-4-(5|6|7)`
 * shape. Used by provider code to gate family-wide behaviour (e.g. beta
 * headers) without copy-pasting `.startsWith()` checks per model.
 */
export function familyOf(model: string): "4-5" | "4-6" | "4-7" | null {
  const match = /^claude-(?:opus|sonnet|haiku)-4-(5|6|7)(?:-|$)/.exec(model);
  if (match === null) return null;
  const tier = match[1];
  if (tier === "5") return "4-5";
  if (tier === "6") return "4-6";
  if (tier === "7") return "4-7";
  return null;
}
