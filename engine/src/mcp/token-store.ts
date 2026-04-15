/**
 * MCP OAuth token store (Phase 07 Prompt 02).
 *
 * Generic on-disk `{ server → tokens }` map with strict file-mode invariants.
 * The OAuth layer owns refresh/expiry semantics; this module only persists.
 *
 * Security invariants (see SECURITY.md §2.4, §3):
 *  - File lives under `~/.jellyclaw/mcp-tokens.json`, directory created 0o700.
 *  - Load refuses any file with group/world permission bits set; the check
 *    runs on `fs.stat` BEFORE the contents are read, so a world-readable
 *    token file is never opened.
 *  - Writes go through `<path>.tmp` + rename + explicit chmod(0o600). The
 *    extra chmod defends against edge cases where rename preserves a
 *    pre-existing, less-strict mode.
 *  - Error messages never contain raw token material; the internal scrubber
 *    replaces any known token substring with `[REDACTED]`.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export interface StoredTokens {
  readonly accessToken: string;
  readonly refreshToken?: string;
  /** Epoch ms. Absent = non-expiring (treat as expired after 55 min default). */
  readonly expiresAt?: number;
  readonly scope?: string;
  readonly tokenType?: string;
}

export interface TokenStoreOptions {
  /** Override path (defaults to ~/.jellyclaw/mcp-tokens.json). Used for tests. */
  readonly path?: string;
  /** Injectable clock. Defaults to Date.now. */
  readonly now?: () => number;
}

export class TokenStoreInsecureError extends Error {
  override readonly name = "TokenStoreInsecureError";
  constructor(
    readonly path: string,
    readonly mode: number,
  ) {
    super(
      `refusing to load world/group-readable MCP tokens at ${path} (mode=0${mode.toString(8).padStart(3, "0")})`,
    );
  }
}

const REDACTED = "[REDACTED]";
const NOT_LOADED = "TokenStore: load() must be called first";

function defaultPath(): string {
  return path.join(os.homedir(), ".jellyclaw", "mcp-tokens.json");
}

/** Build a redaction function over every token string we know about. */
function buildRedactor(entries: ReadonlyMap<string, StoredTokens>): (s: string) => string {
  const secrets = new Set<string>();
  for (const t of entries.values()) {
    if (t.accessToken.length > 0) secrets.add(t.accessToken);
    if (t.refreshToken && t.refreshToken.length > 0) secrets.add(t.refreshToken);
  }
  if (secrets.size === 0) return (s) => s;
  return (s) => {
    let out = s;
    for (const secret of secrets) {
      out = out.split(secret).join(REDACTED);
    }
    return out;
  };
}

function scrubError(err: unknown, redact: (s: string) => string): Error {
  if (err instanceof Error) {
    const scrubbed = redact(err.message);
    if (scrubbed === err.message) return err;
    const copy = new Error(scrubbed);
    copy.name = err.name;
    return copy;
  }
  return new Error(redact(String(err)));
}

export class TokenStore {
  readonly path: string;
  readonly #now: () => number;
  #entries: Map<string, StoredTokens> = new Map();
  #loaded = false;

  constructor(opts: TokenStoreOptions = {}) {
    this.path = opts.path ?? defaultPath();
    this.#now = opts.now ?? Date.now;
  }

  async load(): Promise<void> {
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(this.path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.#entries = new Map();
        this.#loaded = true;
        return;
      }
      throw err;
    }

    // Mode check MUST precede any read of the file contents.
    const perm = stat.mode & 0o777;
    if ((perm & 0o077) !== 0) {
      throw new TokenStoreInsecureError(this.path, perm);
    }

    const raw = await fs.readFile(this.path, "utf8");
    const parsed: unknown = raw.trim().length === 0 ? {} : JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`TokenStore: invalid shape at ${this.path} (expected object)`);
    }

    const next = new Map<string, StoredTokens>();
    for (const [server, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`TokenStore: invalid entry for '${server}' at ${this.path}`);
      }
      const v = value as Record<string, unknown>;
      if (typeof v.accessToken !== "string") {
        throw new Error(`TokenStore: entry '${server}' missing accessToken`);
      }
      const entry: StoredTokens = {
        accessToken: v.accessToken,
        ...(typeof v.refreshToken === "string" ? { refreshToken: v.refreshToken } : {}),
        ...(typeof v.expiresAt === "number" ? { expiresAt: v.expiresAt } : {}),
        ...(typeof v.scope === "string" ? { scope: v.scope } : {}),
        ...(typeof v.tokenType === "string" ? { tokenType: v.tokenType } : {}),
      };
      next.set(server, entry);
    }
    this.#entries = next;
    this.#loaded = true;
  }

  /** Injected clock. Not consulted by the store; exposed for upstream refresh tests. */
  now(): number {
    return this.#now();
  }

  get(server: string): Promise<StoredTokens | undefined> {
    if (!this.#loaded) return Promise.reject(new Error(NOT_LOADED));
    return Promise.resolve(this.#entries.get(server));
  }

  async set(server: string, tokens: StoredTokens): Promise<void> {
    if (!this.#loaded) throw new Error(NOT_LOADED);
    const next = new Map(this.#entries);
    next.set(server, tokens);
    await this.#persist(next);
    this.#entries = next;
  }

  async delete(server: string): Promise<void> {
    if (!this.#loaded) throw new Error(NOT_LOADED);
    if (!this.#entries.has(server)) return;
    const next = new Map(this.#entries);
    next.delete(server);
    await this.#persist(next);
    this.#entries = next;
  }

  async #persist(entries: ReadonlyMap<string, StoredTokens>): Promise<void> {
    const redact = buildRedactor(entries);
    const dir = path.dirname(this.path);
    const tmp = `${this.path}.tmp`;
    const obj: Record<string, StoredTokens> = {};
    for (const [k, v] of entries) obj[k] = v;
    const data = JSON.stringify(obj, null, 2);

    try {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      await fs.writeFile(tmp, data, { mode: 0o600 });
      await fs.rename(tmp, this.path);
      // Rename may preserve an older less-strict mode on some filesystems.
      await fs.chmod(this.path, 0o600);
    } catch (err) {
      // Best-effort cleanup of the tmp file.
      // Best-effort cleanup; if tmp is absent (ENOENT) or another error
      // occurs we still surface the original failure.
      await fs.unlink(tmp).catch(() => undefined);
      throw scrubError(err, redact);
    }
  }
}
