/**
 * Barrel for the security scrubber (Phase 08.03).
 */

export {
  type ApplyScrubOptions,
  type ApplyScrubResult,
  applyScrub,
} from "./apply-scrub.js";
export { type ScrubOptions, type ScrubResult, scrubString } from "./scrub.js";
export {
  builtInPatterns,
  compileUserPatterns,
  InvalidPatternError,
  mergePatterns,
  ReDoSRejectedError,
  type SecretPattern,
  type UserPatternSpec,
} from "./secret-patterns.js";
