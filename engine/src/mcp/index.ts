/**
 * Public barrel for the MCP client layer (Phase 07 Prompt 01 — stdio
 * only). Prompt 02 will extend with HTTP/SSE factories; consumers
 * import through this file so those additions are non-breaking.
 */

export { createStdioMcpClient } from "./client-stdio.js";
export { buildCredentialScrubber, REDACTED, scrubCredentials } from "./credential-strip.js";
export { McpRegistry } from "./registry.js";
export type {
  McpCallToolResult,
  McpClient,
  McpClientEvent,
  McpClientFactoryOptions,
  McpClientListener,
  McpClientStatus,
  McpRegistryOptions,
  McpRegistrySnapshot,
  McpServerConfig,
  McpTool,
  McpTransport,
  StdioMcpServerConfig,
} from "./types.js";
export {
  McpNotReadyError,
  McpUnknownServerError,
  NAMESPACED_TOOL_RE,
  namespaceTool,
  parseNamespaced,
} from "./types.js";
