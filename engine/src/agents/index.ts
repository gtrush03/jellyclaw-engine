export type { BuildSubagentContextArgs } from "./context.js";
export { buildSubagentContext } from "./context.js";
export type { DiscoveryOptions } from "./discovery.js";
export { defaultRoots, discoverAgents } from "./discovery.js";
export type { SubagentDispatcherOptions } from "./dispatch.js";
export { createSubagentDispatcher, SubagentDispatcher } from "./dispatch.js";
// Phase 06 Prompt 02: subagent dispatch surface.
export * from "./dispatch-types.js";
export type {
  MakeSubagentEndEventArgs,
  MakeSubagentStartEventArgs,
} from "./events.js";
export { makeSubagentEndEvent, makeSubagentStartEvent } from "./events.js";
export type { ParseAgentOptions } from "./parser.js";
export { parseAgentFile } from "./parser.js";
export type { AgentsChangedEvent, AgentsListener, LoadAllOptions } from "./registry.js";
export { AgentRegistry } from "./registry.js";
export type { CreateSubagentSemaphoreOptions, Semaphore } from "./semaphore.js";
export { createSubagentSemaphore } from "./semaphore.js";
export type { Agent, AgentFile, AgentSource } from "./types.js";
export { AGENT_BODY_MAX_BYTES, AgentFrontmatter, AgentLoadError } from "./types.js";
