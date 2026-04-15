/**
 * Hook engine public surface (Phase 08.02).
 *
 * Named re-exports only. Import from `"./hooks"` rather than sub-modules so
 * downstream code survives internal reorganization.
 */

export * from "./audit-log.js";
export * from "./events.js";
export * from "./registry.js";
export * from "./runner.js";
export type { HookRecord, HookRecorderOptions } from "./test-harness.js";

/**
 * @deprecated Phase 08 Prompt 02 replaces the in-memory recorder with the
 * real hook engine. `HookRecorder` is kept only until Phase 11 test cleanup
 * removes the Phase 06 regression harness that still depends on it.
 */
export { HookRecorder } from "./test-harness.js";
export * from "./types.js";
