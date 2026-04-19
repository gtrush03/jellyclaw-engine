/**
 * FTS5 read-side helpers (Phase 09.01).
 *
 * The `messages_fts` virtual table is populated exclusively by triggers in
 * `schema.sql` — this module never writes to it. Callers pass raw user
 * query strings; we sanitize to a safe subset of fts5 syntax before binding.
 *
 * Sanitization trade-off: each whitespace-separated token is wrapped in
 * double quotes and joined with spaces (implicit AND). This means users
 * cannot use fts5 boolean operators (`OR`, `NOT`), column filters, or
 * prefix matching (`foo*`). In exchange, arbitrary input including `"`,
 * `*`, `(`, `)`, `:` never throws. If callers want richer syntax we can
 * add an `advanced: true` escape later.
 */

import type { Db } from "./db.js";

export interface FtsHit {
  sessionId: string;
  role: "user" | "assistant" | "system";
  content: string;
  ts: number;
  snippet: string;
  rank: number;
}

export interface FtsSearchOptions {
  query: string;
  limit?: number;
  sessionId?: string;
  role?: "user" | "assistant" | "system";
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

interface FtsRow {
  session_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  ts: number;
  snippet: string;
  rank: number;
}

/**
 * Convert raw user input into a safe fts5 MATCH expression. Strips fts5
 * metacharacters by quoting each whitespace-delimited token.
 *
 * Examples:
 *   `auth bug`       -> `"auth" "bug"`
 *   `foo* "bar"`     -> `"foo" "bar"`     (metachars stripped inside quotes)
 *   `  (weird:op)  ` -> `"weird" "op"`
 *
 * Returns `null` if no usable tokens remain — caller should short-circuit
 * to an empty result set rather than issue a MATCH with an empty string
 * (which fts5 rejects).
 */
function sanitizeQuery(raw: string): string | null {
  // Split on whitespace, drop fts5 special chars from inside each token, then
  // discard empty tokens. Quote each surviving token.
  const tokens = raw
    .split(/\s+/)
    .map((t) => t.replace(/["*()\-:^]/g, "").trim())
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"`).join(" ");
}

export function searchMessages(db: Db, opts: FtsSearchOptions): FtsHit[] {
  const match = sanitizeQuery(opts.query);
  if (match === null) return [];

  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

  const clauses: string[] = ["messages_fts MATCH ?"];
  const bindings: (string | number)[] = [match];

  if (opts.sessionId !== undefined) {
    clauses.push("session_id = ?");
    bindings.push(opts.sessionId);
  }
  if (opts.role !== undefined) {
    clauses.push("role = ?");
    bindings.push(opts.role);
  }
  bindings.push(limit);

  const sql = `
    SELECT session_id, role, content, ts,
           snippet(messages_fts, 0, '<b>', '</b>', '…', 32) AS snippet,
           rank
      FROM messages_fts
     WHERE ${clauses.join(" AND ")}
     ORDER BY rank
     LIMIT ?
  `;

  const rows = db.raw.prepare(sql).all(bindings) as FtsRow[];
  return rows.map((r) => ({
    sessionId: r.session_id,
    role: r.role,
    content: r.content,
    ts: r.ts,
    snippet: r.snippet,
    rank: r.rank,
  }));
}
