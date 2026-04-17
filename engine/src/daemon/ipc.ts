/**
 * IPC control plane for the scheduler daemon (T4-01).
 *
 * Unix domain socket at `<state-dir>/scheduler.sock` with length-prefixed
 * JSON frames. Implements enqueue/list/cancel/status/shutdown verbs.
 */

import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";

import { z } from "zod";
import type { Scheduler, SchedulerStatus } from "./scheduler.js";
import type { InsertJobInput, Job, ListFilter } from "./store.js";

// ---------------------------------------------------------------------------
// Protocol schemas
// ---------------------------------------------------------------------------

export const IpcRequestEnvelope = z.object({
  id: z.string(),
  verb: z.string(),
  params: z.unknown(),
});
export type IpcRequestEnvelope = z.infer<typeof IpcRequestEnvelope>;

export const IpcResponseEnvelope = z.object({
  id: z.string(),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
    })
    .optional(),
});
export type IpcResponseEnvelope = z.infer<typeof IpcResponseEnvelope>;

// Verb-specific param schemas.
export const EnqueueParams = z.object({
  id: z.string(),
  kind: z.enum(["wakeup", "cron"]),
  fire_at: z.number().int(),
  cron_expr: z.string().nullable().optional(),
  payload: z.string(),
  owner: z.string(),
});

export const CancelParams = z.object({
  id: z.string(),
});

export const ListParams = z
  .object({
    status: z.enum(["pending", "running", "done", "failed", "cancelled"]).optional(),
    owner: z.string().optional(),
    kind: z.enum(["wakeup", "cron"]).optional(),
  })
  .optional();

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export interface IpcServerOptions {
  scheduler: Scheduler;
  socketPath?: string;
}

export class IpcServer {
  readonly socketPath: string;
  readonly #scheduler: Scheduler;
  #server: net.Server | null = null;

  constructor(opts: IpcServerOptions) {
    this.#scheduler = opts.scheduler;
    this.socketPath = opts.socketPath ?? path.join(this.#scheduler.stateDir, "scheduler.sock");
  }

  start(): void {
    if (this.#server !== null) return;

    // Remove stale socket file.
    try {
      fs.unlinkSync(this.socketPath);
    } catch {
      // Ignore.
    }

    this.#server = net.createServer((socket) => {
      this.#handleConnection(socket);
    });

    this.#server.listen(this.socketPath, () => {
      // Set socket permissions to 0600.
      fs.chmodSync(this.socketPath, 0o600);
    });
  }

  stop(): Promise<void> {
    if (this.#server === null) return Promise.resolve();

    return new Promise((resolve) => {
      this.#server?.close(() => {
        this.#server = null;
        // Remove socket file.
        try {
          fs.unlinkSync(this.socketPath);
        } catch {
          // Ignore.
        }
        resolve();
      });
    });
  }

  #handleConnection(socket: net.Socket): void {
    let buffer = Buffer.alloc(0);

    socket.on("data", (chunk) => {
      const data = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      buffer = Buffer.concat([buffer, data]);

      // Process complete frames.
      while (buffer.length >= 4) {
        const frameLen = buffer.readUInt32BE(0);
        if (buffer.length < 4 + frameLen) break;

        const frameData = buffer.subarray(4, 4 + frameLen);
        buffer = buffer.subarray(4 + frameLen);

        try {
          const parsed: unknown = JSON.parse(frameData.toString("utf8"));
          const request = IpcRequestEnvelope.parse(parsed);
          const response = this.#handleRequest(request);
          this.#sendResponse(socket, response);
        } catch (err) {
          const errorResponse: IpcResponseEnvelope = {
            id: "unknown",
            ok: false,
            error: {
              code: "parse_error",
              message: err instanceof Error ? err.message : String(err),
            },
          };
          this.#sendResponse(socket, errorResponse);
        }
      }
    });

    socket.on("error", () => {
      // Ignore connection errors.
    });
  }

  #sendResponse(socket: net.Socket, response: IpcResponseEnvelope): void {
    const json = JSON.stringify(response);
    const frame = Buffer.alloc(4 + Buffer.byteLength(json, "utf8"));
    frame.writeUInt32BE(Buffer.byteLength(json, "utf8"), 0);
    frame.write(json, 4, "utf8");
    socket.write(frame);
  }

  #handleRequest(request: IpcRequestEnvelope): IpcResponseEnvelope {
    const { id, verb, params } = request;

    try {
      switch (verb) {
        case "enqueue": {
          const parsed = EnqueueParams.parse(params);
          const input: InsertJobInput = {
            id: parsed.id,
            kind: parsed.kind,
            fire_at: parsed.fire_at,
            cron_expr: parsed.cron_expr ?? null,
            payload: parsed.payload,
            owner: parsed.owner,
          };
          const job = this.#scheduler.store.insertJob(input);
          return { id, ok: true, result: job };
        }

        case "list": {
          const filter = ListParams.parse(params) as ListFilter;
          const jobs = this.#scheduler.store.listAll(filter);
          return { id, ok: true, result: jobs };
        }

        case "cancel": {
          const parsed = CancelParams.parse(params);
          const cancelled = this.#scheduler.store.cancel(parsed.id);
          return { id, ok: true, result: { cancelled } };
        }

        case "status": {
          const status = this.#scheduler.status();
          return { id, ok: true, result: status };
        }

        case "shutdown": {
          // Trigger async shutdown.
          setImmediate(() => {
            void this.#scheduler.stop().then(() => {
              process.exit(0);
            });
          });
          return { id, ok: true, result: { shutting_down: true } };
        }

        case "get": {
          const parsed = CancelParams.parse(params);
          const job = this.#scheduler.store.getById(parsed.id);
          if (!job) {
            return {
              id,
              ok: false,
              error: { code: "not_found", message: `Job not found: ${parsed.id}` },
            };
          }
          return { id, ok: true, result: job };
        }

        default:
          return {
            id,
            ok: false,
            error: { code: "unknown_verb", message: `Unknown verb: ${verb}` },
          };
      }
    } catch (err) {
      return {
        id,
        ok: false,
        error: {
          code: "internal_error",
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface IpcClientOptions {
  socketPath: string;
  timeoutMs?: number;
}

export class IpcClient {
  readonly socketPath: string;
  readonly #timeoutMs: number;
  #requestId = 0;

  constructor(opts: IpcClientOptions) {
    this.socketPath = opts.socketPath;
    this.#timeoutMs = opts.timeoutMs ?? 5000;
  }

  #request(verb: string, params: unknown = {}): Promise<unknown> {
    const id = String(++this.#requestId);
    const request: IpcRequestEnvelope = { id, verb, params };

    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error("IPC request timeout"));
      }, this.#timeoutMs);

      let buffer = Buffer.alloc(0);

      socket.on("connect", () => {
        const json = JSON.stringify(request);
        const frame = Buffer.alloc(4 + Buffer.byteLength(json, "utf8"));
        frame.writeUInt32BE(Buffer.byteLength(json, "utf8"), 0);
        frame.write(json, 4, "utf8");
        socket.write(frame);
      });

      socket.on("data", (chunk) => {
        const data = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        buffer = Buffer.concat([buffer, data]);

        if (buffer.length >= 4) {
          const frameLen = buffer.readUInt32BE(0);
          if (buffer.length >= 4 + frameLen) {
            clearTimeout(timeout);
            const frameData = buffer.subarray(4, 4 + frameLen);
            socket.end();

            try {
              const parsed: unknown = JSON.parse(frameData.toString("utf8"));
              const response = IpcResponseEnvelope.parse(parsed);

              if (response.id !== id) {
                reject(new Error(`Response ID mismatch: expected ${id}, got ${response.id}`));
                return;
              }

              if (!response.ok) {
                reject(new Error(response.error?.message ?? "Unknown error"));
                return;
              }

              resolve(response.result);
            } catch (err) {
              reject(err);
            }
          }
        }
      });

      socket.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  async enqueue(input: InsertJobInput): Promise<Job> {
    const result = (await this.#request("enqueue", input)) as Job;
    return result;
  }

  async list(filter?: ListFilter): Promise<Job[]> {
    const result = (await this.#request("list", filter)) as Job[];
    return result;
  }

  async cancel(id: string): Promise<boolean> {
    const result = (await this.#request("cancel", { id })) as { cancelled: boolean };
    return result.cancelled;
  }

  async status(): Promise<SchedulerStatus> {
    const result = (await this.#request("status")) as SchedulerStatus;
    return result;
  }

  async shutdown(): Promise<void> {
    await this.#request("shutdown");
  }

  async get(id: string): Promise<Job> {
    const result = (await this.#request("get", { id })) as Job;
    return result;
  }
}

// Helper to create a client for a given state directory.
export function ipcClient(stateDir: string): IpcClient {
  return new IpcClient({
    socketPath: path.join(stateDir, "scheduler.sock"),
  });
}
