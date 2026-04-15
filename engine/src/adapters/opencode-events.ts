/**
 * OpenCode → jellyclaw event adapter.
 *
 * Subscribes to OpenCode's `GET /event` SSE stream, decodes the
 * `{ type, properties }` envelope, and yields the canonical 15-variant
 * jellyclaw `Event` union. Implements the ordering invariants documented
 * in `docs/event-stream.md` §5:
 *
 *   - `system.init` then `system.config` are emitted before any upstream
 *     frame.
 *   - `tool.call.start` always precedes its matching `tool.call.end`
 *     (per `tool_use_id`); orphan ends are buffered for
 *     `orderingTimeoutMs` and then released with a synthesised start
 *     plus a `hook.fire{decision:"adapter.synthesize_start"}` notice.
 *   - Exactly one terminal `result` event per session.
 *
 * The adapter is split into two layers:
 *
 *   - `createAdapterFromSource` consumes raw SSE `data:` JSON strings
 *     from any `AsyncIterable<string>`. This is what the unit tests
 *     drive — the HTTP layer is bypassed.
 *   - `createAdapter` opens the HTTP stream via `fetch`, pipes it
 *     through `eventsource-parser`, and feeds the inner adapter.
 *
 * Time is injected via `opts.clock`; this module never calls `Date.now`
 * or `new Date`.
 */

import {
  Event,
  type HookFireEvent,
  redactConfig,
  type ToolCallEndEvent,
  type ToolCallStartEvent,
  type Usage,
} from "@jellyclaw/shared";
import { createParser, type EventSourceMessage } from "eventsource-parser";
import { z } from "zod";
import { createLogger, type Logger } from "../logger.js";

// ---------------------------------------------------------------------------
// Public options
// ---------------------------------------------------------------------------

export interface AdapterOptions {
  sessionId: string;
  url: string;
  authHeader: string;
  clock: () => number;
  cwd: string;
  model: string;
  tools: readonly string[];
  config: unknown;
  signal?: AbortSignal;
  orderingTimeoutMs?: number;
  costTickEvery?: number;
}

export interface AdapterFromSourceOptions extends Omit<AdapterOptions, "url" | "authHeader"> {
  /** Async iterable of SSE payload strings (the body of `data:` lines). */
  source: AsyncIterable<string>;
}

const DEFAULT_ORDERING_TIMEOUT_MS = 2000;
const DEFAULT_COST_TICK_EVERY = 5;

// ---------------------------------------------------------------------------
// Upstream frame schemas (loose; we only validate what we read)
// ---------------------------------------------------------------------------

const upstreamEnvelope = z.object({
  type: z.string(),
  properties: z.record(z.string(), z.unknown()).optional().default({}),
});

const tokenLedger = z
  .object({
    input: z.number().nonnegative().optional(),
    output: z.number().nonnegative().optional(),
    cache: z
      .object({
        read: z.number().nonnegative().optional(),
        write: z.number().nonnegative().optional(),
      })
      .partial()
      .optional(),
  })
  .partial();

const messageInfo = z.object({
  id: z.string().optional(),
  role: z.enum(["user", "assistant"]).optional(),
  time: z
    .object({
      created: z.number().optional(),
      completed: z.number().nullable().optional(),
    })
    .partial()
    .optional(),
  tokens: tokenLedger.optional(),
  error: z
    .object({
      name: z.string().optional(),
      message: z.string().optional(),
    })
    .partial()
    .optional(),
});

const partTextish = z.object({
  type: z.literal("text"),
  text: z.string().optional().default(""),
});

const partToolUse = z.object({
  type: z.literal("tool-use"),
  id: z.string().optional(),
  callID: z.string().optional(),
  tool: z.string().optional(),
  name: z.string().optional(),
  input: z.unknown().optional(),
  state: z.string().optional(),
});

const partToolResult = z.object({
  type: z.literal("tool-result"),
  callID: z.string().optional(),
  tool_use_id: z.string().optional(),
  output: z.unknown().optional(),
  isError: z.boolean().optional(),
  is_error: z.boolean().optional(),
  time: z
    .object({
      start: z.number().optional(),
      end: z.number().optional(),
    })
    .partial()
    .optional(),
});

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface ToolBufferEntry {
  started: boolean;
  pendingEnd: ToolCallEndEvent | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  startTs: number | undefined;
  name: string | undefined;
}

interface RollingUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  cost_usd: number;
}

const EMPTY_USAGE: RollingUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  cost_usd: 0,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Open a live OpenCode SSE subscription and yield jellyclaw events.
 * Thin `fetch` wrapper around `createAdapterFromSource`.
 */
export function createAdapter(opts: AdapterOptions): AsyncIterable<Event> {
  const source = openSseSource(opts);
  return createAdapterFromSource({
    source,
    sessionId: opts.sessionId,
    clock: opts.clock,
    cwd: opts.cwd,
    model: opts.model,
    tools: opts.tools,
    config: opts.config,
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.orderingTimeoutMs !== undefined ? { orderingTimeoutMs: opts.orderingTimeoutMs } : {}),
    ...(opts.costTickEvery !== undefined ? { costTickEvery: opts.costTickEvery } : {}),
  });
}

/**
 * Test-friendly entry point. Pump `data:` payload strings (already
 * extracted from the SSE stream) and receive jellyclaw events.
 *
 * The returned object is an `AsyncIterable<Event>` plus two test-only
 * mutators (`pushSubagent` / `popSubagent`) that simulate nested
 * `task` tool dispatches without requiring a full upstream trace.
 * Production callers should treat the result as `AsyncIterable<Event>`
 * and ignore the helpers.
 */
export interface AdapterHandle extends AsyncIterable<Event> {
  pushSubagent(name: string, sessionID: string): void;
  popSubagent(): void;
}

export function createAdapterFromSource(opts: AdapterFromSourceOptions): AdapterHandle {
  return new AdapterIterable(opts);
}

// ---------------------------------------------------------------------------
// HTTP source
// ---------------------------------------------------------------------------

function openSseSource(opts: AdapterOptions): AsyncIterable<string> {
  // Wrap fetch + parser into an async iterable of `data:` payload strings.
  return {
    [Symbol.asyncIterator](): AsyncIterator<string> {
      const queue: string[] = [];
      const waiters: Array<(v: IteratorResult<string>) => void> = [];
      let done = false;
      let failed: unknown;

      const pushDone = () => {
        done = true;
        while (waiters.length > 0) {
          const w = waiters.shift();
          if (w) w({ value: undefined as unknown as string, done: true });
        }
      };

      const pushValue = (v: string) => {
        if (waiters.length > 0) {
          const w = waiters.shift();
          if (w) w({ value: v, done: false });
        } else {
          queue.push(v);
        }
      };

      const parser = createParser({
        onEvent: (msg: EventSourceMessage) => {
          if (msg.data) pushValue(msg.data);
        },
      });

      void (async () => {
        try {
          const init: RequestInit = {
            method: "GET",
            headers: {
              Authorization: opts.authHeader,
              Accept: "text/event-stream",
            },
            ...(opts.signal ? { signal: opts.signal } : {}),
          };
          const res = await fetch(`${opts.url}/event`, init);
          if (!res.ok || !res.body) {
            throw new Error(`opencode SSE returned HTTP ${res.status}`);
          }
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          for (;;) {
            const { value, done: rdDone } = await reader.read();
            if (rdDone) break;
            if (value) parser.feed(decoder.decode(value, { stream: true }));
          }
        } catch (err) {
          failed = err;
        } finally {
          pushDone();
        }
      })();

      return {
        next(): Promise<IteratorResult<string>> {
          if (queue.length > 0) {
            const v = queue.shift();
            return Promise.resolve({ value: v as string, done: false });
          }
          if (done) {
            if (failed) return Promise.reject(failed);
            return Promise.resolve({ value: undefined as unknown as string, done: true });
          }
          return new Promise((resolve) => waiters.push(resolve));
        },
        return(): Promise<IteratorResult<string>> {
          done = true;
          return Promise.resolve({ value: undefined as unknown as string, done: true });
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// AdapterIterable — the heart of the adapter
// ---------------------------------------------------------------------------

class AdapterIterable implements AdapterHandle {
  private readonly opts: AdapterFromSourceOptions;
  private readonly orderingTimeoutMs: number;
  private readonly costTickEvery: number;
  private readonly logger: Logger;
  private iterator: AdapterIterator | undefined;

  constructor(opts: AdapterFromSourceOptions) {
    this.opts = opts;
    this.orderingTimeoutMs = opts.orderingTimeoutMs ?? DEFAULT_ORDERING_TIMEOUT_MS;
    this.costTickEvery = opts.costTickEvery ?? DEFAULT_COST_TICK_EVERY;
    this.logger = createLogger({ name: "adapter.opencode" });
  }

  [Symbol.asyncIterator](): AsyncIterator<Event> {
    if (!this.iterator) {
      this.iterator = new AdapterIterator(
        this.opts,
        this.orderingTimeoutMs,
        this.costTickEvery,
        this.logger,
      );
    }
    return this.iterator;
  }

  pushSubagent(name: string, sessionID: string): void {
    if (!this.iterator) this[Symbol.asyncIterator]();
    this.iterator?.pushSubagent(name, sessionID);
  }

  popSubagent(): void {
    this.iterator?.popSubagent();
  }
}

class AdapterIterator implements AsyncIterator<Event> {
  private readonly opts: AdapterFromSourceOptions;
  private readonly orderingTimeoutMs: number;
  private readonly costTickEvery: number;
  private readonly logger: Logger;

  private readonly outQueue: Event[] = [];
  private readonly waiters: Array<(v: IteratorResult<Event>) => void> = [];
  private readonly toolBuffer = new Map<string, ToolBufferEntry>();
  private readonly seenToolStart = new Set<string>(); // (messageID|partID) keys
  private readonly seenAssistantMsg = new Set<string>();
  private readonly subagentStack: Array<{ name: string; sessionID: string }> = [];

  private readonly rollingUsage: RollingUsage = { ...EMPTY_USAGE };
  private toolEndCount = 0;
  private toolsCalled = 0;
  private turnsCount = 0;
  private startTs: number | undefined;
  private resultEmitted = false;
  private finished = false;
  private lastAssistantMessageWasTerminal = false;
  private resultStatus: "success" | "error" | "cancelled" | "max_turns" | undefined;
  private sourceIterator: AsyncIterator<string> | undefined;
  private pumpStarted = false;

  constructor(
    opts: AdapterFromSourceOptions,
    orderingTimeoutMs: number,
    costTickEvery: number,
    logger: Logger,
  ) {
    this.opts = opts;
    this.orderingTimeoutMs = orderingTimeoutMs;
    this.costTickEvery = costTickEvery;
    this.logger = logger;

    // Two synthetic frames go first — `system.init` then `system.config`.
    const initTs = this.opts.clock();
    this.startTs = initTs;
    this.emit({
      type: "system.init",
      session_id: this.opts.sessionId,
      cwd: this.opts.cwd,
      model: this.opts.model,
      tools: [...this.opts.tools],
      ts: initTs,
    });
    const configTs = this.opts.clock();
    const redacted = redactConfig(this.opts.config);
    this.emit({
      type: "system.config",
      config: (redacted ?? {}) as Record<string, unknown>,
      ts: configTs,
    });
  }

  // --- AsyncIterator surface ------------------------------------------------

  next(): Promise<IteratorResult<Event>> {
    this.startPumpOnce();

    if (this.opts.signal?.aborted && !this.resultEmitted) {
      this.synthesiseResult("cancelled");
    }

    if (this.outQueue.length > 0) {
      const value = this.outQueue.shift() as Event;
      if (value.type === "result") this.finished = true;
      return Promise.resolve({ value, done: false });
    }

    if (this.finished) {
      return Promise.resolve({ value: undefined as unknown as Event, done: true });
    }

    return new Promise<IteratorResult<Event>>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  return(): Promise<IteratorResult<Event>> {
    this.finished = true;
    this.cleanupTimers();
    if (this.sourceIterator?.return) void this.sourceIterator.return();
    return Promise.resolve({ value: undefined as unknown as Event, done: true });
  }

  // --- Output helpers -------------------------------------------------------

  /**
   * Validate then enqueue an event. Validation failures are logged
   * loudly but never thrown — a malformed synthetic event is a bug,
   * not a stream-level recoverable condition, but throwing out of the
   * pump would deadlock the consumer.
   */
  private emit(event: Event): void {
    const parsed = Event.safeParse(event);
    if (!parsed.success) {
      this.logger.error(
        { issues: parsed.error.issues, event_type: event.type },
        "adapter produced an invalid event; dropping",
      );
      return;
    }
    const e = parsed.data;

    if (this.resultEmitted) {
      // Nothing may follow `result`. Drop silently — by construction the
      // adapter only synthesises one and never tries to emit after it,
      // so reaching here means a logic bug; log and move on.
      this.logger.warn({ event_type: e.type }, "event produced after terminal result; dropping");
      return;
    }

    if (e.type === "result") this.resultEmitted = true;

    if (this.waiters.length > 0) {
      const w = this.waiters.shift();
      if (w) {
        if (e.type === "result") this.finished = true;
        w({ value: e, done: false });
        return;
      }
    }
    this.outQueue.push(e);
  }

  // --- Source pump ----------------------------------------------------------

  private startPumpOnce(): void {
    if (this.pumpStarted) return;
    this.pumpStarted = true;
    void this.pump();
  }

  private async pump(): Promise<void> {
    const it = this.opts.source[Symbol.asyncIterator]();
    this.sourceIterator = it;

    try {
      for (;;) {
        if (this.opts.signal?.aborted) {
          this.synthesiseResult("cancelled");
          break;
        }
        const r = await it.next();
        if (r.done) break;
        this.handleRawLine(r.value);
        if (this.resultEmitted) break;
      }
    } catch (err) {
      this.logger.error({ err }, "adapter source pump errored");
    } finally {
      this.cleanupTimers();
      if (!this.resultEmitted) {
        const status =
          this.resultStatus ?? (this.lastAssistantMessageWasTerminal ? "success" : "cancelled");
        this.synthesiseResult(status);
      }
      this.finished = true;
      // Flush waiters that are still parked.
      while (this.waiters.length > 0) {
        const w = this.waiters.shift();
        if (w) w({ value: undefined as unknown as Event, done: true });
      }
    }
  }

  private handleRawLine(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      this.emitParseError(raw, err);
      return;
    }
    const env = upstreamEnvelope.safeParse(parsed);
    if (!env.success) {
      this.emitParseError(raw, env.error);
      return;
    }
    this.handleEnvelope(env.data.type, env.data.properties);
  }

  private emitParseError(raw: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    const truncated = raw.length > 256 ? `${raw.slice(0, 256)}…` : raw;
    this.logger.warn({ err: message, line: truncated }, "adapter parse error; dropping line");
    const hookEvent: HookFireEvent = {
      type: "hook.fire",
      session_id: this.opts.sessionId,
      event: "adapter.parse_error",
      decision: "adapter.drop",
      stdout: truncated,
      stderr: message,
      ts: this.opts.clock(),
    };
    this.emit(hookEvent);
  }

  // --- Envelope dispatch ----------------------------------------------------

  private handleEnvelope(type: string, props: Record<string, unknown>): void {
    switch (type) {
      case "server.connected":
      case "server.heartbeat":
      case "project.updated":
        return;

      case "global.disposed":
        this.synthesiseResult(this.resultStatus ?? "cancelled");
        return;

      case "session.error":
        this.handleSessionError(props);
        return;

      case "session.updated":
        this.handleSessionUpdated(props);
        return;

      case "message.updated":
        this.handleMessageUpdated(props);
        return;

      case "message.part.updated":
        this.handleMessagePartUpdated(props);
        return;

      case "tool.permission.ask":
        this.handlePermissionAsk(props);
        return;

      default:
        // Unknown frame — log at debug, drop.
        this.logger.debug({ frame_type: type }, "unhandled upstream frame type");
        return;
    }
  }

  private handleSessionError(props: Record<string, unknown>): void {
    const msg = typeof props.error === "string" ? (props.error as string) : "session.error";
    this.logger.warn({ message: msg }, "upstream session.error");
    this.resultStatus = "error";
    this.synthesiseResult("error");
  }

  private handleSessionUpdated(props: Record<string, unknown>): void {
    const info = props.info;
    this.emit({
      type: "session.update",
      session_id: this.opts.sessionId,
      patch: info ?? props,
      ts: this.opts.clock(),
    });

    // If `info.time.completed` is set, the session has finished its turn
    // — but we still wait for the actual stream-close before emitting
    // the terminal `result`, so just record the hint.
    const parsed = messageInfo.safeParse(info);
    if (parsed.success && parsed.data.time?.completed != null) {
      this.lastAssistantMessageWasTerminal = true;
      const errName = parsed.data.error?.name;
      if (errName === "MaxTurnsExceeded") {
        this.resultStatus = "max_turns";
      }
    }
  }

  private handleMessageUpdated(props: Record<string, unknown>): void {
    const info = messageInfo.safeParse(props.info);
    if (!info.success) return;
    const data = info.data;
    if (data.role !== "assistant") return;
    if (data.time?.completed == null) return;
    const id = data.id ?? `msg-${this.turnsCount}`;
    if (this.seenAssistantMsg.has(id)) return;
    this.seenAssistantMsg.add(id);

    // Per-turn usage from `tokens`.
    const tokens = data.tokens ?? {};
    const turnUsage: Usage = {
      input_tokens: Math.trunc(tokens.input ?? 0),
      output_tokens: Math.trunc(tokens.output ?? 0),
      cache_creation_input_tokens: Math.trunc(tokens.cache?.write ?? 0),
      cache_read_input_tokens: Math.trunc(tokens.cache?.read ?? 0),
      cost_usd: 0,
    };

    this.rollingUsage.input_tokens += turnUsage.input_tokens;
    this.rollingUsage.output_tokens += turnUsage.output_tokens;
    this.rollingUsage.cache_creation_input_tokens += turnUsage.cache_creation_input_tokens;
    this.rollingUsage.cache_read_input_tokens += turnUsage.cache_read_input_tokens;
    this.turnsCount += 1;
    this.lastAssistantMessageWasTerminal = true;

    this.emit({
      type: "assistant.message",
      session_id: this.opts.sessionId,
      message: { role: "assistant", content: "" },
      usage: turnUsage,
      ts: this.opts.clock(),
    });

    this.emit({
      type: "cost.tick",
      session_id: this.opts.sessionId,
      usage: { ...this.rollingUsage },
      ts: this.opts.clock(),
    });

    if (data.error?.name === "MaxTurnsExceeded") {
      this.resultStatus = "max_turns";
    }
  }

  private handleMessagePartUpdated(props: Record<string, unknown>): void {
    const messageID =
      typeof props.messageID === "string"
        ? (props.messageID as string)
        : ((props.messageId as string | undefined) ?? "");
    const part = props.part;
    if (typeof part !== "object" || part === null) return;
    const partType = (part as { type?: unknown }).type;

    if (partType === "text") {
      const txt = partTextish.safeParse(part);
      if (!txt.success) return;
      if (!txt.data.text) return;
      this.emit({
        type: "assistant.delta",
        session_id: this.opts.sessionId,
        text: txt.data.text,
        ts: this.opts.clock(),
      });
      return;
    }

    if (partType === "tool-use") {
      const tu = partToolUse.safeParse(part);
      if (!tu.success) return;
      const toolUseId = tu.data.id ?? tu.data.callID;
      if (!toolUseId) return;
      const partID = tu.data.id ?? toolUseId;
      const dedupeKey = `${messageID}|${partID}`;
      const name = tu.data.name ?? tu.data.tool ?? "unknown";

      const inputStr =
        typeof tu.data.input === "string" ? tu.data.input : safeStringify(tu.data.input);
      if (inputStr.length > 0) {
        this.emit({
          type: "tool.call.delta",
          session_id: this.opts.sessionId,
          tool_use_id: toolUseId,
          partial_json: inputStr,
          ts: this.opts.clock(),
        });
      }

      const isComplete = tu.data.state === "completed";
      if (!isComplete) return;
      if (this.seenToolStart.has(dedupeKey)) return;
      this.seenToolStart.add(dedupeKey);

      this.releaseToolStart(toolUseId, name, tu.data.input);
      return;
    }

    if (partType === "tool-result") {
      const tr = partToolResult.safeParse(part);
      if (!tr.success) return;
      const toolUseId = tr.data.tool_use_id ?? tr.data.callID;
      if (!toolUseId) return;

      const isErr = tr.data.isError ?? tr.data.is_error ?? false;
      const ts = this.opts.clock();
      const buf = this.toolBuffer.get(toolUseId);
      const startTs = buf?.startTs ?? tr.data.time?.start ?? ts;
      const duration = Math.max(0, ts - startTs);

      const end: ToolCallEndEvent = isErr
        ? {
            type: "tool.call.end",
            session_id: this.opts.sessionId,
            tool_use_id: toolUseId,
            error:
              typeof tr.data.output === "string" ? tr.data.output : safeStringify(tr.data.output),
            duration_ms: duration,
            ts,
          }
        : {
            type: "tool.call.end",
            session_id: this.opts.sessionId,
            tool_use_id: toolUseId,
            result: tr.data.output ?? null,
            duration_ms: duration,
            ts,
          };

      this.releaseToolEnd(toolUseId, end);
    }
  }

  private handlePermissionAsk(props: Record<string, unknown>): void {
    const tool = typeof props.tool === "string" ? (props.tool as string) : "unknown";
    this.emit({
      type: "permission.request",
      session_id: this.opts.sessionId,
      tool,
      rule_matched: "upstream.tool.permission.ask",
      action: "ask",
      ts: this.opts.clock(),
    });
  }

  // --- Tool ordering --------------------------------------------------------

  private getOrCreateBuf(toolUseId: string): ToolBufferEntry {
    let buf = this.toolBuffer.get(toolUseId);
    if (!buf) {
      buf = {
        started: false,
        pendingEnd: undefined,
        timer: undefined,
        startTs: undefined,
        name: undefined,
      };
      this.toolBuffer.set(toolUseId, buf);
    }
    return buf;
  }

  private releaseToolStart(toolUseId: string, name: string, input: unknown): void {
    const buf = this.getOrCreateBuf(toolUseId);
    if (buf.started) return;
    const ts = this.opts.clock();
    const start: ToolCallStartEvent = {
      type: "tool.call.start",
      session_id: this.opts.sessionId,
      tool_use_id: toolUseId,
      name,
      input: input ?? null,
      subagent_path: this.subagentStack.map((s) => s.name),
      ts,
    };
    this.emit(start);
    buf.started = true;
    buf.startTs = ts;
    buf.name = name;

    if (name === "task") {
      const childSession =
        typeof (input as { sessionID?: unknown } | null)?.sessionID === "string"
          ? (input as { sessionID: string }).sessionID
          : toolUseId;
      this.subagentStack.push({ name, sessionID: childSession });
    }

    if (buf.pendingEnd) {
      const pending = buf.pendingEnd;
      buf.pendingEnd = undefined;
      if (buf.timer) {
        clearTimeout(buf.timer);
        buf.timer = undefined;
      }
      this.emitToolEnd(toolUseId, pending);
    }
  }

  private releaseToolEnd(toolUseId: string, end: ToolCallEndEvent): void {
    const buf = this.getOrCreateBuf(toolUseId);
    if (buf.started) {
      this.emitToolEnd(toolUseId, end);
      return;
    }
    // Buffer the end and start the timeout.
    buf.pendingEnd = end;
    if (!buf.timer) {
      buf.timer = setTimeout(() => {
        this.flushOrphanEnd(toolUseId);
      }, this.orderingTimeoutMs);
      // Don't keep the event loop alive just to flush an orphan.
      const t = buf.timer as unknown as { unref?: () => void };
      if (typeof t.unref === "function") t.unref();
    }
  }

  private emitToolEnd(toolUseId: string, end: ToolCallEndEvent): void {
    this.emit(end);
    this.toolEndCount += 1;
    this.toolsCalled += 1;
    const buf = this.toolBuffer.get(toolUseId);
    if (buf?.name === "task" && this.subagentStack.length > 0) {
      this.subagentStack.pop();
    }
    this.toolBuffer.delete(toolUseId);

    if (this.toolEndCount % this.costTickEvery === 0) {
      this.emit({
        type: "cost.tick",
        session_id: this.opts.sessionId,
        usage: { ...this.rollingUsage },
        ts: this.opts.clock(),
      });
    }
  }

  private flushOrphanEnd(toolUseId: string): void {
    const buf = this.toolBuffer.get(toolUseId);
    if (!buf?.pendingEnd || buf.started) return;
    const end = buf.pendingEnd;
    buf.pendingEnd = undefined;
    if (buf.timer) {
      clearTimeout(buf.timer);
      buf.timer = undefined;
    }

    // Emit a synthesised minimal `start` first.
    const startTs = this.opts.clock();
    const synthStart: ToolCallStartEvent = {
      type: "tool.call.start",
      session_id: this.opts.sessionId,
      tool_use_id: toolUseId,
      name: "unknown",
      input: null,
      subagent_path: this.subagentStack.map((s) => s.name),
      ts: startTs,
    };
    this.emit(synthStart);
    buf.started = true;
    buf.startTs = startTs;
    buf.name = "unknown";

    // Hook-fire notice of the ordering violation.
    this.emit({
      type: "hook.fire",
      session_id: this.opts.sessionId,
      event: "stream.ordering_violation",
      decision: "adapter.synthesize_start",
      stdout: toolUseId,
      stderr: "",
      ts: this.opts.clock(),
    });

    this.emitToolEnd(toolUseId, end);
  }

  private cleanupTimers(): void {
    for (const buf of this.toolBuffer.values()) {
      if (buf.timer) {
        clearTimeout(buf.timer);
        buf.timer = undefined;
      }
    }
  }

  // --- Terminal result ------------------------------------------------------

  /**
   * Public test-only hook for the subagent stack. Exposed via a
   * private symbol so it doesn't leak into the public surface but
   * tests can poke at nested `task` calls without a full upstream
   * trace.
   */
  pushSubagent(name: string, sessionID: string): void {
    this.subagentStack.push({ name, sessionID });
  }

  popSubagent(): void {
    this.subagentStack.pop();
  }

  private synthesiseResult(status: "success" | "error" | "cancelled" | "max_turns"): void {
    if (this.resultEmitted) return;
    const ts = this.opts.clock();
    const start = this.startTs ?? ts;
    this.emit({
      type: "result",
      session_id: this.opts.sessionId,
      status,
      stats: {
        turns: this.turnsCount,
        tools_called: this.toolsCalled,
        duration_ms: Math.max(0, ts - start),
      },
      ts,
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeStringify(v: unknown): string {
  if (v === undefined || v === null) return "";
  try {
    return JSON.stringify(v);
  } catch {
    return "";
  }
}
