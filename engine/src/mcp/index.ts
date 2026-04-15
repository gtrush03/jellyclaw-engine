/**
 * Public barrel for the MCP client layer (Phase 07 Prompt 01 — stdio
 * only). Prompt 02 will extend with HTTP/SSE factories; consumers
 * import through this file so those additions are non-breaking.
 */

export { createHttpMcpClient } from "./client-http.js";
export { createSseMcpClient } from "./client-sse.js";
export { createStdioMcpClient } from "./client-stdio.js";
export { buildCredentialScrubber, REDACTED, scrubCredentials } from "./credential-strip.js";
export {
  InvalidServerNameError,
  InvalidToolNameError,
  NAMESPACED_TOOL_RE as NAMESPACING_RE,
  namespace,
  parse as parseNamespace,
  validateServerName,
} from "./namespacing.js";
export {
  awaitOAuthCallback,
  createOAuthClientProvider,
  OAuthCallbackPortInUseError,
  OAuthStateMismatchError,
  pkce,
} from "./oauth.js";
export { McpRegistry } from "./registry.js";
export type { StoredTokens, TokenStoreOptions } from "./token-store.js";
export { TokenStore, TokenStoreInsecureError } from "./token-store.js";
export type {
  HttpMcpServerConfig,
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
  OAuthConfig,
  SseMcpServerConfig,
  StdioMcpServerConfig,
} from "./types.js";
export {
  McpNotReadyError,
  McpUnknownServerError,
  NAMESPACED_TOOL_RE,
  namespaceTool,
  parseNamespaced,
} from "./types.js";
