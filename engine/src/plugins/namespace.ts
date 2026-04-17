/**
 * Plugin namespace helpers (T4-05).
 *
 * Plugins use colon-separated namespaced IDs: `<pluginId>:<localId>`.
 * These helpers parse and construct namespaced identifiers.
 */

import { ALL_HOOK_EVENTS, type HookEventKind } from "../hooks/types.js";

// ---------------------------------------------------------------------------
// Namespacing helpers
// ---------------------------------------------------------------------------

/**
 * Create a namespaced ID from plugin ID and local ID.
 */
export function namespaced(pluginId: string, localId: string): string {
  return `${pluginId}:${localId}`;
}

/**
 * Parse a namespaced ID. Returns null if no colon separator found.
 */
export function parseNamespaced(id: string): { pluginId: string; localId: string } | null {
  const colonIdx = id.indexOf(":");
  if (colonIdx === -1) return null;

  const pluginId = id.slice(0, colonIdx);
  const localId = id.slice(colonIdx + 1);

  if (pluginId.length === 0 || localId.length === 0) return null;

  return { pluginId, localId };
}

/**
 * Check if an ID is namespaced (contains a colon).
 */
export function isNamespaced(id: string): boolean {
  return id.includes(":");
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/**
 * Valid kebab-case name for skills, agents, and commands.
 */
const KEBAB_CASE_RE = /^[a-z][a-z0-9-]*$/;

/**
 * Validate a local skill name.
 */
export function isValidSkillName(name: string): boolean {
  return KEBAB_CASE_RE.test(name);
}

/**
 * Validate a local agent name.
 */
export function isValidAgentName(name: string): boolean {
  return KEBAB_CASE_RE.test(name);
}

/**
 * Validate a local command name.
 */
export function isValidCommandName(name: string): boolean {
  return KEBAB_CASE_RE.test(name);
}

/**
 * Validate a hook event name.
 */
export function isValidHookEventName(name: string): name is HookEventKind {
  return (ALL_HOOK_EVENTS as readonly string[]).includes(name);
}

/**
 * Extract the local part from a namespaced ID, or return the ID if not namespaced.
 */
export function localPart(id: string): string {
  const parsed = parseNamespaced(id);
  return parsed ? parsed.localId : id;
}

/**
 * Check if an ID belongs to a specific plugin.
 */
export function belongsToPlugin(id: string, pluginId: string): boolean {
  const parsed = parseNamespaced(id);
  return parsed !== null && parsed.pluginId === pluginId;
}
