/**
 * Session index writer (Phase 09.01).
 *
 * Single-writer serial queue over the shared `better-sqlite3` handle owned by
 * {@link Db}. better-sqlite3 is synchronous, so the queue is NOT about atomic
 * statements — it exists to serialize *multi-statement transactions* across
 * concurrent engine coroutines (e.g. a tool-call UPSERT racing a
 * usage-update transaction).
 *
 * FTS index maintenance is handled by triggers declared in `schema.sql`
 * (`messages_ai`, `messages_au`, `messages_ad`). This file never touches
 * `messages_fts` directly.
 *
 * Encapsulation: do NOT expose `Db.raw` from the writer; callers use the
 * typed methods below.
 */

import type { Logger } from "pino";

import { createLogger } from "../logger.js";
import type { Db } from "./db.js";

// ---------------------------------------------------------------------------
// Public input contracts
// ---------------------------------------------------------------------------

export interface UpsertSessionInput {
  id: string;
  projectHash: string;
  cwd: string;
  model: string | null;
  createdAt: number;
  lastTurnAt: number;
  parentSessionId: string | null;
  status: "active" | "ended" | "archived";
  summary: string | null;
}

export interface AppendMessageInput {
  sessionId: string;
  turnIndex: number;
  role: "user" | "assistant" | "system";
  content: string;
  ts: number;
}

export interface AppendToolCallInput {
  sessionId: string;
  callId: string;
  toolName: string;
  inputJson: string;
  resultJson: string | null;
  durationMs: number | null;
  startedAt: number;
  finishedAt: number | null;
}

export interface UpdateUsageInput {
  sessionId: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreation: number;
  cacheRead: number;
  usdCents: number;
}

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

/**
 * Hard cap for inline `tool_calls.result_json` storage. Per spec, oversize
 * payloads are truncated with a `{"truncated": true, "bytes": N}` marker and
 * the full copy lives in the JSONL log (owned by Phase 09.02).
 */
const RESULT_JSON_MAX_BYTES = 1_000_000;

// ---------------------------------------------------------------------------
// SessionWriter
// ---------------------------------------------------------------------------

export class SessionWriter {
  private readonly raw: Db["raw"];
  private readonly logger: Logger;

  // Prepared statements. better-sqlite3 caches plans once prepared.
  private readonly stmtUpsertSession: ReturnType<Db["raw"]["prepare"]>;
  private readonly stmtInsertMessage: ReturnType<Db["raw"]["prepare"]>;
  private readonly stmtUpsertToolCall: ReturnType<Db["raw"]["prepare"]>;
  private readonly stmtUpsertTokens: ReturnType<Db["raw"]["prepare"]>;
  private readonly stmtUpsertCost: ReturnType<Db["raw"]["prepare"]>;
  private readonly txUsage: (input: UpdateUsageInput) => void;

  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(db: Db, logger?: Logger) {
    this.raw = db.raw;
    this.logger = logger ?? createLogger({ name: "session-writer" });

    this.stmtUpsertSession = this.raw.prepare(
      `INSERT INTO sessions (
         id, project_hash, cwd, model, created_at, last_turn_at,
         parent_session_id, status, summary
       ) VALUES (
         @id, @projectHash, @cwd, @model, @createdAt, @lastTurnAt,
         @parentSessionId, @status, @summary
       )
       ON CONFLICT(id) DO UPDATE SET
         last_turn_at = excluded.last_turn_at,
         model        = excluded.model,
         status       = excluded.status,
         summary      = excluded.summary`,
    );

    this.stmtInsertMessage = this.raw.prepare(
      `INSERT INTO messages (session_id, turn_index, role, content, ts)
       VALUES (@sessionId, @turnIndex, @role, @content, @ts)`,
    );

    this.stmtUpsertToolCall = this.raw.prepare(
      `INSERT INTO tool_calls (
         session_id, call_id, tool_name, input_json, result_json,
         duration_ms, started_at, finished_at
       ) VALUES (
         @sessionId, @callId, @toolName, @inputJson, @resultJson,
         @durationMs, @startedAt, @finishedAt
       )
       ON CONFLICT(session_id, call_id) DO UPDATE SET
         result_json = excluded.result_json,
         duration_ms = excluded.duration_ms,
         finished_at = excluded.finished_at`,
    );

    this.stmtUpsertTokens = this.raw.prepare(
      `INSERT INTO tokens (
         session_id, input_tokens, output_tokens, cache_creation, cache_read
       ) VALUES (
         @sessionId, @inputTokens, @outputTokens, @cacheCreation, @cacheRead
       )
       ON CONFLICT(session_id) DO UPDATE SET
         input_tokens   = excluded.input_tokens,
         output_tokens  = excluded.output_tokens,
         cache_creation = excluded.cache_creation,
         cache_read     = excluded.cache_read`,
    );

    this.stmtUpsertCost = this.raw.prepare(
      `INSERT INTO cost (session_id, usd_cents)
       VALUES (@sessionId, @usdCents)
       ON CONFLICT(session_id) DO UPDATE SET
         usd_cents = excluded.usd_cents`,
    );

    // Transaction wrapping tokens + cost so JOIN reads see consistent state.
    this.txUsage = this.raw.transaction((input: UpdateUsageInput) => {
      this.stmtUpsertTokens.run({
        sessionId: input.sessionId,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        cacheCreation: input.cacheCreation,
        cacheRead: input.cacheRead,
      });
      this.stmtUpsertCost.run({
        sessionId: input.sessionId,
        usdCents: input.usdCents,
      });
    });
  }

  /**
   * Serialize a synchronous DB operation onto the writer's queue. The queue
   * is isolated from caller failures: a rejected task does NOT poison the
   * chain — subsequent enqueues still run.
   */
  private enqueue<T>(fn: () => T): Promise<T> {
    const next = this.writeQueue.then(() => fn());
    this.writeQueue = next.catch(() => undefined);
    return next;
  }

  upsertSession(input: UpsertSessionInput): Promise<void> {
    return this.enqueue(() => {
      this.stmtUpsertSession.run(input);
    });
  }

  appendMessage(input: AppendMessageInput): Promise<number> {
    return this.enqueue(() => {
      const info = this.stmtInsertMessage.run(input);
      return Number(info.lastInsertRowid);
    });
  }

  appendToolCall(input: AppendToolCallInput): Promise<void> {
    return this.enqueue(() => {
      let resultJson = input.resultJson;
      if (resultJson !== null) {
        const byteLength = Buffer.byteLength(resultJson, "utf8");
        if (byteLength > RESULT_JSON_MAX_BYTES) {
          this.logger.warn(
            {
              sessionId: input.sessionId,
              callId: input.callId,
              bytes: byteLength,
              limit: RESULT_JSON_MAX_BYTES,
            },
            "session-writer: truncating oversized tool result; full copy lives in JSONL",
          );
          resultJson = JSON.stringify({ truncated: true, bytes: byteLength });
        }
      }
      this.stmtUpsertToolCall.run({
        sessionId: input.sessionId,
        callId: input.callId,
        toolName: input.toolName,
        inputJson: input.inputJson,
        resultJson,
        durationMs: input.durationMs,
        startedAt: input.startedAt,
        finishedAt: input.finishedAt,
      });
    });
  }

  updateUsage(input: UpdateUsageInput): Promise<void> {
    return this.enqueue(() => {
      this.txUsage(input);
    });
  }
}
