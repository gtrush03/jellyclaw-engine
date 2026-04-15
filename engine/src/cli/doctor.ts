/**
 * Phase 10.01 — `jellyclaw doctor`.
 *
 * Diagnoses a jellyclaw installation by running a fixed set of checks
 * and rendering the results as an ASCII table to stdout. Returns a
 * numeric exit code; the main.ts layer is responsible for the actual
 * `process.exit`.
 *
 * Design:
 *   - `runChecks(deps)` is the pure core — the tests inject stub
 *     implementations for every check and assert on the result list.
 *   - `doctorAction({ stdout, paths? })` wires the real-world checks and
 *     renders the table. It returns 0 (all pass, warnings allowed) or 2
 *     (one or more fatal failures).
 *   - No check ever throws out of the dispatcher: every check returns a
 *     `CheckResult` and is wrapped in a try/catch so a broken probe
 *     degrades to a failed row instead of crashing the diagnostic.
 */

import { existsSync, constants as fsConstants, promises as fsp } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";

import type { McpServerConfig } from "../mcp/types.js";
import { SessionPaths } from "../session/paths.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type CheckStatus = "pass" | "warn" | "fail";

export interface CheckResult {
  readonly name: string;
  readonly status: CheckStatus;
  readonly detail: string;
  /** Populated only when status === "fail"; surfaced in the "Fixes:" block. */
  readonly remediation?: string;
}

export interface DoctorDeps {
  readonly checkNodeVersion: () => Promise<CheckResult>;
  readonly checkOpencodePin: () => Promise<CheckResult>;
  readonly checkPatchSentinels: () => Promise<CheckResult>;
  readonly checkJellyclawHome: () => Promise<CheckResult>;
  readonly checkApiKey: () => Promise<CheckResult>;
  readonly checkMcpServers: () => Promise<CheckResult>;
  readonly checkSqliteIntegrity: () => Promise<CheckResult>;
  readonly checkRuntime: () => Promise<CheckResult>;
}

export interface DoctorActionOptions {
  readonly stdout?: NodeJS.WritableStream;
  /** Test/DI seam: inject a preconfigured `SessionPaths`. */
  readonly paths?: SessionPaths;
  /** Test/DI seam: inject custom deps to bypass real-world probes. */
  readonly deps?: DoctorDeps;
}

// ---------------------------------------------------------------------------
// Core dispatcher
// ---------------------------------------------------------------------------

const CHECK_ORDER: ReadonlyArray<keyof DoctorDeps> = [
  "checkNodeVersion",
  "checkRuntime",
  "checkOpencodePin",
  "checkPatchSentinels",
  "checkJellyclawHome",
  "checkApiKey",
  "checkMcpServers",
  "checkSqliteIntegrity",
];

export async function runChecks(deps: DoctorDeps): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const key of CHECK_ORDER) {
    const probe = deps[key];
    try {
      results.push(await probe());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({
        name: key,
        status: "fail",
        detail: `probe threw: ${message}`,
        remediation: "file a bug — doctor probes must not throw",
      });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Real-world checks
// ---------------------------------------------------------------------------

const REQUIRED_NODE_MAJOR = 20;
const REQUIRED_NODE_MINOR = 6;

function parseNodeVersion(raw: string): {
  major: number;
  minor: number;
  patch: number;
} {
  const [major = "0", minor = "0", patch = "0"] = raw.split(".");
  return {
    major: Number.parseInt(major, 10),
    minor: Number.parseInt(minor, 10),
    patch: Number.parseInt(patch, 10),
  };
}

// biome-ignore lint/suspicious/useAwait: DoctorDeps probes return Promise<CheckResult>; body is sync today.
export async function defaultCheckRuntime(): Promise<CheckResult> {
  const bunVer = (process.versions as Record<string, string | undefined>).bun;
  if (bunVer !== undefined) {
    return {
      name: "runtime",
      status: "warn",
      detail: `bun ${bunVer} — limitations: 'jellyclaw serve' (SSE/chunked-encoding), better-sqlite3. Use 'jellyclaw-serve' (node) for the HTTP server.`,
    };
  }
  return {
    name: "runtime",
    status: "pass",
    detail: `node ${process.versions.node}`,
  };
}

// biome-ignore lint/suspicious/useAwait: DoctorDeps probes return Promise<CheckResult>; body is sync today.
export async function defaultCheckNodeVersion(): Promise<CheckResult> {
  const raw = process.versions.node;
  const { major, minor } = parseNodeVersion(raw);
  const ok =
    major > REQUIRED_NODE_MAJOR || (major === REQUIRED_NODE_MAJOR && minor >= REQUIRED_NODE_MINOR);
  if (ok) {
    return {
      name: "node version",
      status: "pass",
      detail: `node ${raw} (>= ${REQUIRED_NODE_MAJOR}.${REQUIRED_NODE_MINOR})`,
    };
  }
  return {
    name: "node version",
    status: "fail",
    detail: `node ${raw} is below ${REQUIRED_NODE_MAJOR}.${REQUIRED_NODE_MINOR}`,
    remediation: `upgrade via \`nvm install ${REQUIRED_NODE_MAJOR}\``,
  };
}

interface PackageJsonShape {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly version?: string;
}

async function readJson(path: string): Promise<PackageJsonShape> {
  const raw = await fsp.readFile(path, "utf8");
  return JSON.parse(raw) as PackageJsonShape;
}

function stripRange(spec: string): string {
  // package.json often carries a range specifier ("^1.4.5", "~1.4.5",
  // ">=1.4.4 <2"). We only care about the first concrete version number
  // when comparing against `require.resolve`'s package.json.
  const match = spec.match(/\d+\.\d+\.\d+/);
  return match ? match[0] : spec;
}

export async function defaultCheckOpencodePin(): Promise<CheckResult> {
  try {
    const enginePkgPath = resolvePath(process.cwd(), "engine", "package.json");
    const pkg = await readJson(enginePkgPath);
    const pinnedRaw = pkg.dependencies?.["opencode-ai"];
    if (!pinnedRaw) {
      return {
        name: "opencode-ai pin",
        status: "fail",
        detail: "engine/package.json missing dependencies.opencode-ai",
        remediation: "add opencode-ai to engine/package.json dependencies",
      };
    }
    const pinned = stripRange(pinnedRaw);

    const requireFn = createRequire(import.meta.url);
    const installedPath = requireFn.resolve("opencode-ai/package.json");
    const installed = await readJson(installedPath);
    const installedVersion = installed.version ?? "unknown";

    if (installedVersion !== pinned) {
      return {
        name: "opencode-ai pin",
        status: "fail",
        detail: `installed ${installedVersion}, pinned ${pinned}`,
        remediation: `run \`bun install\` to sync to ${pinned}`,
      };
    }
    return {
      name: "opencode-ai pin",
      status: "pass",
      detail: `opencode-ai ${installedVersion}`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      name: "opencode-ai pin",
      status: "fail",
      detail: `unable to resolve opencode-ai: ${message}`,
      remediation: "run `bun install` in the repo root",
    };
  }
}

const PATCH_SENTINELS: readonly string[] = [
  "patches/001-subagent-hook-fire.patch",
  "patches/002-bind-localhost-only.patch",
  "patches/003-secret-scrub-tool-results.patch",
];

// biome-ignore lint/suspicious/useAwait: DoctorDeps probes return Promise<CheckResult>; body is sync existsSync checks.
export async function defaultCheckPatchSentinels(): Promise<CheckResult> {
  const missing = PATCH_SENTINELS.filter((p) => !existsSync(p));
  if (missing.length === 0) {
    return {
      name: "patch sentinels",
      status: "pass",
      detail: `all ${PATCH_SENTINELS.length} sentinels present`,
    };
  }
  return {
    name: "patch sentinels",
    status: "fail",
    detail: `missing ${missing.length}: ${missing.join(", ")}`,
    remediation: "restore patches/ from git — patches protect against known CVEs",
  };
}

export async function defaultCheckJellyclawHome(paths: SessionPaths): Promise<CheckResult> {
  const root = paths.root();
  // Create if missing — this is an auto-fix, not a failure.
  let autoFixed = false;
  if (!existsSync(root)) {
    await fsp.mkdir(root, { recursive: true, mode: 0o700 });
    autoFixed = true;
  }

  const stat = await fsp.stat(root);
  if (!stat.isDirectory()) {
    return {
      name: "~/.jellyclaw",
      status: "fail",
      detail: `${root} exists but is not a directory`,
      remediation: `remove ${root} and re-run doctor`,
    };
  }

  // Check writability.
  try {
    await fsp.access(root, fsConstants.W_OK);
  } catch {
    return {
      name: "~/.jellyclaw",
      status: "fail",
      detail: `${root} not writable`,
      remediation: `chmod u+w ${root}`,
    };
  }

  const mode = stat.mode & 0o777;
  // Mode must forbid group + other access entirely: `(mode & 0o077) === 0`.
  if ((mode & 0o077) !== 0) {
    return {
      name: "~/.jellyclaw",
      status: "fail",
      detail: `${root} mode ${mode.toString(8)} too permissive`,
      remediation: `chmod 700 ${root}`,
    };
  }

  return {
    name: "~/.jellyclaw",
    status: "pass",
    detail: autoFixed ? `${root} created (mode 0700)` : `${root} (mode ${mode.toString(8)})`,
  };
}

// biome-ignore lint/suspicious/useAwait: DoctorDeps probes return Promise<CheckResult>; env var reads are sync.
export async function defaultCheckApiKey(): Promise<CheckResult> {
  const hasAnthropic = Boolean(process.env.ANTHROPIC_API_KEY);
  const hasOpenRouter = Boolean(process.env.OPENROUTER_API_KEY);
  if (hasAnthropic) {
    return {
      name: "ANTHROPIC_API_KEY",
      status: "pass",
      detail: "ANTHROPIC_API_KEY set",
    };
  }
  if (hasOpenRouter) {
    return {
      name: "ANTHROPIC_API_KEY",
      status: "warn",
      detail: "ANTHROPIC_API_KEY unset; OPENROUTER_API_KEY present",
    };
  }
  return {
    name: "ANTHROPIC_API_KEY",
    status: "warn",
    detail: "ANTHROPIC_API_KEY not set (secondary provider may still work)",
  };
}

/**
 * Minimal local shape for the `mcp.json` config file. Kept local to
 * doctor rather than reused from `mcp/types.ts` because the doctor only
 * cares about a handful of fields and must be tolerant of partial data.
 */
interface DoctorMcpEntry {
  readonly name: string;
  readonly required: boolean;
  readonly config: McpServerConfig;
}

export interface McpProbeDep {
  /** Returns true if the server was reachable within the timeout. */
  readonly probe: (entry: DoctorMcpEntry, signal: AbortSignal) => Promise<void>;
  readonly timeoutMs: number;
  readonly loadConfigs: () => Promise<DoctorMcpEntry[]>;
}

export async function defaultCheckMcpServers(dep: McpProbeDep): Promise<CheckResult> {
  const entries = await dep.loadConfigs();
  if (entries.length === 0) {
    return {
      name: "MCP servers",
      status: "pass",
      detail: "no MCP servers configured",
    };
  }

  const unreachable: string[] = [];
  const unreachableRequired: string[] = [];
  for (const entry of entries) {
    const signal = AbortSignal.timeout(dep.timeoutMs);
    try {
      await dep.probe(entry, signal);
    } catch {
      unreachable.push(entry.name);
      if (entry.required) unreachableRequired.push(entry.name);
    }
  }

  if (unreachableRequired.length > 0) {
    return {
      name: "MCP servers",
      status: "fail",
      detail: `required servers unreachable: ${unreachableRequired.join(", ")}`,
      remediation: "check MCP server configuration in ~/.jellyclaw/mcp.json and retry",
    };
  }
  if (unreachable.length > 0) {
    return {
      name: "MCP servers",
      status: "warn",
      detail: `${entries.length - unreachable.length}/${entries.length} reachable; unreachable: ${unreachable.join(", ")}`,
    };
  }
  return {
    name: "MCP servers",
    status: "pass",
    detail: `${entries.length}/${entries.length} reachable`,
  };
}

export interface SqlitePragmaDep {
  readonly integrityCheck: () => Promise<string>;
}

export async function defaultCheckSqliteIntegrity(dep: SqlitePragmaDep): Promise<CheckResult> {
  try {
    const value = await dep.integrityCheck();
    if (value === "ok") {
      return {
        name: "sqlite integrity",
        status: "pass",
        detail: "integrity_check = ok",
      };
    }
    return {
      name: "sqlite integrity",
      status: "fail",
      detail: `integrity_check = ${value}`,
      remediation: "quarantine ~/.jellyclaw/sessions/index.sqlite and let jellyclaw rebuild",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      name: "sqlite integrity",
      status: "fail",
      detail: `unable to run integrity_check: ${message}`,
      remediation: "check ~/.jellyclaw/sessions/ permissions",
    };
  }
}

// ---------------------------------------------------------------------------
// Default dep wiring (called by `doctorAction`)
// ---------------------------------------------------------------------------

async function loadMcpConfigsFromDisk(paths: SessionPaths): Promise<DoctorMcpEntry[]> {
  const configPath = join(paths.root(), "mcp.json");
  try {
    const raw = await fsp.readFile(configPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return [];
    const servers = (parsed as { servers?: unknown }).servers;
    if (!servers || typeof servers !== "object") return [];
    const out: DoctorMcpEntry[] = [];
    for (const [name, value] of Object.entries(servers as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const obj = value as { required?: unknown } & McpServerConfig;
      out.push({
        name,
        required: obj.required === true,
        config: obj,
      });
    }
    return out;
  } catch {
    return [];
  }
}

async function defaultMcpProbe(entry: DoctorMcpEntry, signal: AbortSignal): Promise<void> {
  // Lazily import the registry to avoid loading MCP plumbing when the
  // check isn't needed (unit tests always inject a stub).
  const { McpRegistry } = await import("../mcp/registry.js");
  const { createLogger } = await import("../logger.js");
  const registry = new McpRegistry({
    connectTimeoutMs: 5000,
    logger: createLogger({ name: "doctor-mcp", level: "silent" }),
  });
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = (): void => {
      reject(new Error("mcp probe timed out"));
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([registry.start([entry.config]), aborted]);
  } finally {
    await registry.stop().catch(() => undefined);
  }
}

async function defaultSqliteIntegrity(paths: SessionPaths): Promise<string> {
  const { openDb } = await import("../session/db.js");
  const db = await openDb({ paths });
  try {
    const rows = db.raw.pragma("integrity_check") as Array<{
      integrity_check: string;
    }>;
    return rows[0]?.integrity_check ?? "unknown";
  } finally {
    db.close();
  }
}

function buildDefaultDeps(paths: SessionPaths): DoctorDeps {
  return {
    checkNodeVersion: defaultCheckNodeVersion,
    checkRuntime: defaultCheckRuntime,
    checkOpencodePin: defaultCheckOpencodePin,
    checkPatchSentinels: defaultCheckPatchSentinels,
    checkJellyclawHome: () => defaultCheckJellyclawHome(paths),
    checkApiKey: defaultCheckApiKey,
    checkMcpServers: () =>
      defaultCheckMcpServers({
        loadConfigs: () => loadMcpConfigsFromDisk(paths),
        probe: defaultMcpProbe,
        timeoutMs: 5000,
      }),
    checkSqliteIntegrity: () =>
      defaultCheckSqliteIntegrity({
        integrityCheck: () => defaultSqliteIntegrity(paths),
      }),
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const STATUS_GLYPH: Record<CheckStatus, string> = {
  pass: "\u2713", // ✓
  warn: "\u26A0", // ⚠
  fail: "\u2717", // ✗
};

function pad(text: string, width: number): string {
  if (text.length >= width) return text;
  return text + " ".repeat(width - text.length);
}

export function renderTable(results: readonly CheckResult[]): string {
  const headers = ["Check", "Status", "Detail"];
  const rows = results.map((r) => [r.name, STATUS_GLYPH[r.status], r.detail]);
  const widths = headers.map((h, i) => {
    let w = h.length;
    for (const row of rows) {
      const cell = row[i] ?? "";
      if (cell.length > w) w = cell.length;
    }
    return w;
  });
  const sep = `+-${widths.map((w) => "-".repeat(w)).join("-+-")}-+`;
  const lines: string[] = [];
  lines.push(sep);
  lines.push(`| ${headers.map((h, i) => pad(h, widths[i] ?? h.length)).join(" | ")} |`);
  lines.push(sep);
  for (const row of rows) {
    lines.push(`| ${row.map((c, i) => pad(c, widths[i] ?? c.length)).join(" | ")} |`);
  }
  lines.push(sep);
  return `${lines.join("\n")}\n`;
}

function renderFixes(results: readonly CheckResult[]): string {
  const fails = results.filter((r) => r.status === "fail" && r.remediation !== undefined);
  if (fails.length === 0) return "";
  const lines = ["", "Fixes:"];
  for (const f of fails) {
    lines.push(`  - ${f.name}: ${f.remediation ?? ""}`);
  }
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Action entry point
// ---------------------------------------------------------------------------

export async function doctorAction(opts: DoctorActionOptions = {}): Promise<number> {
  const stdout = opts.stdout ?? process.stdout;
  const paths = opts.paths ?? new SessionPaths({ home: homedir() });
  const deps = opts.deps ?? buildDefaultDeps(paths);

  const results = await runChecks(deps);
  const table = renderTable(results);
  const fixes = renderFixes(results);

  stdout.write(table);
  if (fixes.length > 0) stdout.write(fixes);

  const anyFail = results.some((r) => r.status === "fail");
  return anyFail ? 2 : 0;
}
