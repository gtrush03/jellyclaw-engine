/**
 * Sidecar client for Jellyclaw desktop app (T4-06).
 *
 * Provides typed access to the Rust sidecar supervisor via Tauri IPC,
 * with retry logic and event stream helpers.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Sidecar connection info returned by the Rust supervisor.
 */
export const SidecarInfoSchema = z.object({
  port: z.number().int().min(1).max(65535),
  token: z.string().min(1),
});

export type SidecarInfo = z.infer<typeof SidecarInfoSchema>;

/**
 * Error thrown when sidecar operations fail.
 */
export class SidecarError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "SidecarError";
  }
}

// ---------------------------------------------------------------------------
// IPC interface
// ---------------------------------------------------------------------------

/**
 * Tauri invoke function type.
 * In tests, this can be mocked.
 */
export type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

/**
 * Get the Tauri invoke function.
 * Returns a mock in test environments.
 */
async function getInvoke(): Promise<InvokeFn> {
  // Check if we're in a Tauri environment
  if (typeof window !== "undefined" && "__TAURI__" in window) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke as InvokeFn;
  }

  // In non-Tauri environments (tests), use a mock
  throw new SidecarError("Not running in Tauri environment");
}

// ---------------------------------------------------------------------------
// Retry logic
// ---------------------------------------------------------------------------

/**
 * Retry options for sidecar operations.
 */
export interface RetryOptions {
  /** Maximum number of attempts (default: 5) */
  maxAttempts?: number;
  /** Initial delay in ms (default: 200) */
  initialDelayMs?: number;
  /** Backoff multiplier (default: 2) */
  backoffMultiplier?: number;
}

/**
 * Execute a function with exponential backoff retry.
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const { maxAttempts = 5, initialDelayMs = 200, backoffMultiplier = 2 } = options;

  let lastError: unknown;
  let delayMs = initialDelayMs;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt < maxAttempts) {
        // Wait before next attempt
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        delayMs *= backoffMultiplier;
      }
    }
  }

  throw new SidecarError(
    `Failed after ${maxAttempts} attempts`,
    lastError,
  );
}

// ---------------------------------------------------------------------------
// Sidecar client
// ---------------------------------------------------------------------------

/**
 * Get sidecar connection info with retry.
 *
 * @param invoke - Optional invoke function (for testing)
 * @param retryOptions - Retry configuration
 * @returns Sidecar connection info (port and token)
 */
export async function getSidecarInfo(
  invoke?: InvokeFn,
  retryOptions?: RetryOptions,
): Promise<SidecarInfo> {
  const invokeFn = invoke ?? (await getInvoke());

  return withRetry(async () => {
    const result = await invokeFn<unknown>("get_sidecar_info");
    const parsed = SidecarInfoSchema.safeParse(result);

    if (!parsed.success) {
      throw new SidecarError(
        `Invalid sidecar info: ${parsed.error.message}`,
        parsed.error,
      );
    }

    return parsed.data;
  }, retryOptions);
}

/**
 * Check if the sidecar is running.
 *
 * @param invoke - Optional invoke function (for testing)
 */
export async function isSidecarRunning(invoke?: InvokeFn): Promise<boolean> {
  const invokeFn = invoke ?? (await getInvoke());
  return invokeFn<boolean>("is_sidecar_running");
}

/**
 * Restart the sidecar.
 *
 * @param invoke - Optional invoke function (for testing)
 */
export async function restartSidecar(invoke?: InvokeFn): Promise<SidecarInfo> {
  const invokeFn = invoke ?? (await getInvoke());
  const result = await invokeFn<unknown>("restart_sidecar");
  const parsed = SidecarInfoSchema.safeParse(result);

  if (!parsed.success) {
    throw new SidecarError(
      `Invalid sidecar info: ${parsed.error.message}`,
      parsed.error,
    );
  }

  return parsed.data;
}

/**
 * Shutdown the sidecar.
 *
 * @param invoke - Optional invoke function (for testing)
 */
export async function shutdownSidecar(invoke?: InvokeFn): Promise<void> {
  const invokeFn = invoke ?? (await getInvoke());
  await invokeFn<void>("shutdown_sidecar");
}

// ---------------------------------------------------------------------------
// Event stream helpers
// ---------------------------------------------------------------------------

/**
 * Options for opening an event stream.
 */
export interface EventStreamOptions {
  /** Path to connect to (e.g., "/events") */
  path: string;
  /** Event handler callback */
  onMessage: (event: MessageEvent) => void;
  /** Error handler callback */
  onError?: (error: Error) => void;
  /** Open handler callback */
  onOpen?: () => void;
}

/**
 * Open an SSE event stream to the sidecar.
 *
 * Uses @microsoft/fetch-event-source to support auth headers.
 *
 * @param info - Sidecar connection info
 * @param options - Stream options
 * @returns Abort controller to close the stream
 */
export async function openEventStream(
  info: SidecarInfo,
  options: EventStreamOptions,
): Promise<AbortController> {
  const { fetchEventSource } = await import("@microsoft/fetch-event-source");

  const controller = new AbortController();
  const url = `http://127.0.0.1:${info.port}${options.path}`;

  // Start the event source (non-blocking)
  fetchEventSource(url, {
    signal: controller.signal,
    headers: {
      Authorization: `Bearer ${info.token}`,
    },
    onopen: async (response) => {
      if (response.ok) {
        options.onOpen?.();
      } else {
        throw new SidecarError(`Event stream failed: ${response.status}`);
      }
    },
    onmessage: (event) => {
      options.onMessage(new MessageEvent("message", { data: event.data }));
    },
    onerror: (error) => {
      options.onError?.(error instanceof Error ? error : new Error(String(error)));
    },
  }).catch((error) => {
    // Only report if not aborted
    if (!controller.signal.aborted) {
      options.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  });

  return controller;
}

/**
 * Make an authenticated HTTP request to the sidecar.
 *
 * @param info - Sidecar connection info
 * @param path - Request path
 * @param options - Fetch options (method, body, etc.)
 */
export async function sidecarFetch(
  info: SidecarInfo,
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  const url = `http://127.0.0.1:${info.port}${path}`;

  return fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      Authorization: `Bearer ${info.token}`,
    },
  });
}
