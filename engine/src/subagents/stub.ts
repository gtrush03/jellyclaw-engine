/**
 * Phase-04 stub for the SubagentService.
 *
 * Always throws `SubagentsNotImplementedError` so callers fail loudly
 * instead of silently producing empty results. Phase 06 replaces this
 * with the real dispatch implementation.
 */

import { SubagentsNotImplementedError } from "../tools/types.js";
import type { SubagentService } from "./types.js";

export const stubSubagentService: SubagentService = {
  // biome-ignore lint/suspicious/useAwait: throws synchronously; async signature is the contract.
  async dispatch() {
    throw new SubagentsNotImplementedError();
  },
};
