/**
 * Interactive paste prompt for provider API keys.
 *
 * Runs BEFORE the vendored TUI spawns — the TUI inherits stdio, so once it
 * owns the terminal we can't easily prompt without fighting its renderer.
 *
 * Visibility
 * ----------
 * Pasting an API key with a fully hidden prompt inside a stock Node TTY
 * requires a raw-mode dance (disable echo, collect keystrokes, handle ^C).
 * `readline` does not natively support hidden input. We implement the raw
 * variant when possible and fall back to a visible-paste prompt with a
 * user-facing warning.
 *
 * Never log the key. Never write it to stdout. The only sink is the
 * in-memory value returned from `promptForApiKey()`, which callers forward
 * to `saveCredentials` + the child process env.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PromptStreams {
  readonly stdin: NodeJS.ReadableStream & {
    isTTY?: boolean;
    setRawMode?: (b: boolean) => unknown;
    on: NodeJS.ReadableStream["on"];
    off: NodeJS.ReadableStream["off"];
    pause: () => void;
    resume: () => void;
  };
  readonly stdout: NodeJS.WritableStream & { isTTY?: boolean };
  readonly stderr: NodeJS.WritableStream;
}

export interface PromptOptions {
  readonly streams?: PromptStreams;
  /** Minimum acceptable length (must match schema — default 10). */
  readonly minLength?: number;
  /** Optional prefix (e.g. "sk-ant-"). If set, reject values that don't start with it. */
  readonly expectedPrefix?: string;
}

export type PromptResult =
  | { readonly kind: "ok"; readonly value: string }
  | { readonly kind: "cancelled" }
  | { readonly kind: "skipped" };

// ---------------------------------------------------------------------------
// Banner
// ---------------------------------------------------------------------------

const WELCOME = [
  "",
  "  jellyclaw — first-run setup",
  "  ─────────────────────────────",
  "  Paste your ANTHROPIC_API_KEY to continue, or press Enter to skip",
  "  (you can also set the env var or run `jellyclaw key` later).",
  "",
  "  Your key will be saved to ~/.jellyclaw/credentials.json (mode 0600)",
  "  and never printed to the terminal.",
  "",
].join("\n");

const ROTATE = [
  "",
  "  jellyclaw key — rotate ANTHROPIC_API_KEY",
  "  ─────────────────────────────────────────",
  "  Paste the new key, or press Enter to keep the current one.",
  "",
].join("\n");

// ---------------------------------------------------------------------------
// Hidden read (raw mode)
// ---------------------------------------------------------------------------

/**
 * Read one line from stdin with echo disabled. Returns null on Ctrl+C.
 * Bytes are treated as UTF-8. CR or LF terminates the line. Backspace
 * (0x7f / 0x08) removes the last char.
 */
async function readHiddenLine(streams: PromptStreams): Promise<string | null> {
  const { stdin, stdout } = streams;
  if (stdin.isTTY !== true || typeof stdin.setRawMode !== "function") {
    // No TTY — cannot mask. Caller should fall through to visible mode.
    return null;
  }
  return await new Promise<string | null>((resolve) => {
    const buf: number[] = [];
    let settled = false;

    const onData = (chunk: Buffer): void => {
      for (const byte of chunk) {
        if (byte === 0x03) {
          // Ctrl+C
          cleanup();
          resolve(null);
          return;
        }
        if (byte === 0x0d || byte === 0x0a) {
          stdout.write("\n");
          cleanup();
          resolve(Buffer.from(buf).toString("utf8"));
          return;
        }
        if (byte === 0x7f || byte === 0x08) {
          if (buf.length > 0) buf.pop();
          continue;
        }
        buf.push(byte);
      }
    };

    const cleanup = (): void => {
      if (settled) return;
      settled = true;
      try {
        stdin.setRawMode?.(false);
      } catch {
        /* best-effort */
      }
      stdin.off("data", onData as (c: Buffer) => void);
      stdin.pause();
    };

    const setRaw = stdin.setRawMode;
    if (typeof setRaw !== "function") {
      resolve(null);
      return;
    }
    try {
      setRaw.call(stdin, true);
    } catch {
      resolve(null);
      return;
    }
    stdin.resume();
    stdin.on("data", onData as (c: Buffer) => void);
  });
}

// ---------------------------------------------------------------------------
// Visible fallback
// ---------------------------------------------------------------------------

async function readVisibleLine(streams: PromptStreams): Promise<string | null> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({
    input: streams.stdin as NodeJS.ReadableStream,
    output: streams.stdout as NodeJS.WritableStream,
    terminal: streams.stdin.isTTY === true,
  });
  try {
    // `question` resolves on Ctrl+D with "" and rejects on Ctrl+C abort.
    const line = await rl.question("");
    return line;
  } catch {
    return null;
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateKey(
  raw: string,
  opts: { minLength: number; expectedPrefix?: string },
): { ok: true; value: string } | { ok: false; reason: string } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false, reason: "empty" };
  if (trimmed.length < opts.minLength) {
    return { ok: false, reason: `key is too short (min ${String(opts.minLength)} chars)` };
  }
  if (opts.expectedPrefix !== undefined && !trimmed.startsWith(opts.expectedPrefix)) {
    return {
      ok: false,
      reason: `key does not start with "${opts.expectedPrefix}"`,
    };
  }
  // Guard against accidentally-pasted surrounding quotes.
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return { ok: false, reason: "key appears to be wrapped in quotes — paste without them" };
  }
  return { ok: true, value: trimmed };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Prompt the user for an Anthropic API key on the terminal. Intended to be
 * called BEFORE the TUI takes over stdio. Returns `{ kind: "skipped" }` when
 * the user presses Enter with no input.
 */
export async function promptForApiKey(opts: PromptOptions = {}): Promise<PromptResult> {
  const streams: PromptStreams = opts.streams ?? {
    stdin: process.stdin as PromptStreams["stdin"],
    stdout: process.stdout as PromptStreams["stdout"],
    stderr: process.stderr,
  };
  const minLength = opts.minLength ?? 10;

  if (streams.stdin.isTTY !== true || streams.stdout.isTTY !== true) {
    // No TTY — we cannot interactively prompt. Treat as skip.
    return { kind: "skipped" };
  }

  streams.stdout.write(WELCOME);
  streams.stdout.write("  Key (hidden, paste then Enter): ");

  let raw: string | null = await readHiddenLine(streams);
  if (raw === null) {
    // Hidden read unsupported or cancelled — fall through to visible.
    streams.stderr.write(
      "\n  (Falling back to visible paste — clear your terminal afterwards.)\n  Key: ",
    );
    raw = await readVisibleLine(streams);
  }

  if (raw === null) return { kind: "cancelled" };
  if (raw.trim().length === 0) return { kind: "skipped" };

  const validated = validateKey(raw, {
    minLength,
    ...(opts.expectedPrefix !== undefined ? { expectedPrefix: opts.expectedPrefix } : {}),
  });
  if (!validated.ok) {
    streams.stderr.write(`  [jellyclaw] ${validated.reason}. Skipping save.\n`);
    return { kind: "skipped" };
  }
  streams.stdout.write("  [jellyclaw] key saved.\n\n");
  return { kind: "ok", value: validated.value };
}

/**
 * Variant of `promptForApiKey` that shows the "rotate" banner instead of the
 * first-run welcome.
 */
export async function promptRotateApiKey(opts: PromptOptions = {}): Promise<PromptResult> {
  const streams: PromptStreams = opts.streams ?? {
    stdin: process.stdin as PromptStreams["stdin"],
    stdout: process.stdout as PromptStreams["stdout"],
    stderr: process.stderr,
  };
  const minLength = opts.minLength ?? 10;

  if (streams.stdin.isTTY !== true || streams.stdout.isTTY !== true) {
    return { kind: "skipped" };
  }

  streams.stdout.write(ROTATE);
  streams.stdout.write("  New key (hidden, paste then Enter): ");

  let raw: string | null = await readHiddenLine(streams);
  if (raw === null) {
    streams.stderr.write(
      "\n  (Falling back to visible paste — clear your terminal afterwards.)\n  New key: ",
    );
    raw = await readVisibleLine(streams);
  }

  if (raw === null) return { kind: "cancelled" };
  if (raw.trim().length === 0) return { kind: "skipped" };

  const validated = validateKey(raw, {
    minLength,
    ...(opts.expectedPrefix !== undefined ? { expectedPrefix: opts.expectedPrefix } : {}),
  });
  if (!validated.ok) {
    streams.stderr.write(`  [jellyclaw] ${validated.reason}. Keeping existing key.\n`);
    return { kind: "skipped" };
  }
  streams.stdout.write("  [jellyclaw] key rotated.\n\n");
  return { kind: "ok", value: validated.value };
}
