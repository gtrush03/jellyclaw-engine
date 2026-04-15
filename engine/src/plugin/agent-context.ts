/**
 * agent-context — enriches OpenCode `tool.execute.before` / `tool.execute.after`
 * hook envelopes with the originating agent's name and its parent session chain.
 *
 * OpenCode v1.4.5 fires tool hooks for both root sessions and subagents, but the
 * envelope does not carry an `agent` field (upstream issue #5894). This module
 * resolves that gap by consulting a {@link SessionResolver} to look up the agent
 * name and parent session for the hook's `sessionID`, then walking ancestors to
 * build a root-first `agentChain`.
 *
 * This module is pure data transform — registration with the OpenCode plugin
 * runtime happens at bootstrap time elsewhere.
 */

/**
 * Maximum depth of the parent-session chain. Exceeding this throws, guarding
 * against accidental cycles in session metadata.
 */
export const MAX_AGENT_CHAIN_DEPTH = 16;

export interface ToolHookEnvelope {
  tool: string;
  sessionID: string;
  callID: string;
  /** Extra fields the hook invocation happened to include (args, etc.). */
  [key: string]: unknown;
}

export interface EnrichedToolHookEnvelope extends ToolHookEnvelope {
  /** The name of the agent that made this tool call. `undefined` for root/unknown. */
  agent: string | undefined;
  /** Parent sessionID if this is a subagent call; `undefined` for root. */
  parentSessionID: string | undefined;
  /** Full chain of ancestor sessions from root → this session's parent. Empty for root. */
  agentChain: readonly string[];
}

export interface SessionMetadata {
  agentName: string | undefined;
  parentSessionID: string | undefined;
}

export interface SessionResolver {
  /** Return session metadata needed to enrich a tool hook envelope. */
  getSession(sessionID: string): Promise<SessionMetadata | undefined>;
}

/**
 * Enrich a tool-hook envelope with its originating agent and ancestor chain.
 *
 * Walks the parent chain via {@link SessionResolver.getSession} until a session
 * has no parent, building `agentChain` in root-first order. Throws if the chain
 * exceeds {@link MAX_AGENT_CHAIN_DEPTH} hops (cycle protection).
 *
 * If the envelope's own session is unknown to the resolver, returns the envelope
 * with `agent: undefined`, `parentSessionID: undefined`, `agentChain: []`.
 */
export async function enrichHookEnvelope(
  envelope: ToolHookEnvelope,
  resolver: SessionResolver,
): Promise<EnrichedToolHookEnvelope> {
  const self = await resolver.getSession(envelope.sessionID);
  if (self === undefined) {
    return {
      ...envelope,
      agent: undefined,
      parentSessionID: undefined,
      agentChain: [],
    };
  }

  // Build ancestor chain leaf → root, then reverse for root-first order.
  const ancestorsLeafFirst: string[] = [];
  let cursor: string | undefined = self.parentSessionID;
  let hops = 0;
  while (cursor !== undefined) {
    if (hops >= MAX_AGENT_CHAIN_DEPTH) {
      throw new Error(
        `agent-context: parent session chain exceeded ${MAX_AGENT_CHAIN_DEPTH} hops ` +
          `starting from session ${envelope.sessionID} (possible cycle)`,
      );
    }
    ancestorsLeafFirst.push(cursor);
    hops += 1;
    const parent: SessionMetadata | undefined = await resolver.getSession(cursor);
    if (parent === undefined) {
      break;
    }
    cursor = parent.parentSessionID;
  }

  const agentChain: readonly string[] = ancestorsLeafFirst.slice().reverse();

  return {
    ...envelope,
    agent: self.agentName,
    parentSessionID: self.parentSessionID,
    agentChain,
  };
}

/**
 * Wrap a {@link SessionResolver} with an in-memory cache keyed on `sessionID`.
 *
 * Intended lifetime: a single CLI invocation. Cache hits bypass the underlying
 * resolver entirely. The cache stores `undefined` results as well, so repeated
 * misses do not re-hit the underlying resolver.
 */
export function createCachedResolver(base: SessionResolver): SessionResolver {
  const cache = new Map<string, SessionMetadata | undefined>();
  return {
    async getSession(sessionID: string): Promise<SessionMetadata | undefined> {
      if (cache.has(sessionID)) {
        return cache.get(sessionID);
      }
      const value = await base.getSession(sessionID);
      cache.set(sessionID, value);
      return value;
    },
  };
}
