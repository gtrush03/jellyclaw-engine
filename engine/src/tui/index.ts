/**
 * Phase 99 — TUI module barrel.
 *
 * Public surface: the jellyclaw HTTP client. The old OpenCode-shape SDK
 * adapter + vendored TUI renderer are gone. Callers that need to talk to
 * the jellyclaw server use `createClient()`. The `launchTui` compat wrapper
 * is preserved for the CLI's `attach <url>` subcommand.
 */

export type {
  CreateClientOptions,
  CreateRunInput,
  HealthResponse,
  JellyclawClient,
  LaunchTuiHandle,
  LaunchTuiOptions,
  SessionMeta,
} from "./client.js";
export {
  createClient,
  JellyclawClientError,
  launchTui,
} from "./client.js";
