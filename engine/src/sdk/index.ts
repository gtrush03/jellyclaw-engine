/**
 * SDK barrel export (T3-12).
 *
 * Re-exports the query() function and related types for SDK compatibility.
 */

export { query } from "./query.js";
export type {
  AssistantMessage,
  Query,
  QueryOptions,
  ResultMessage,
  SDKMessage,
  SystemInitMessage,
  UserInputMessage,
  UserMessage,
} from "./types.js";
