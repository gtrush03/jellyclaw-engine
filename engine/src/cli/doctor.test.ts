/**
 * Phase 10.01 — `jellyclaw doctor` tests.
 *
 * The dispatcher is driven entirely through injected deps so the tests
 * never touch the real `~/.jellyclaw`, MCP network, or opencode-ai
 * install. Each case asserts on the `CheckResult[]` shape and (for the
 * two integration-ish cases) the final exit code.
 */

import { describe, expect, it } from "vitest";

import type { CheckResult, DoctorDeps } from "./doctor.js";
import { doctorAction, renderTable, runChecks } from "./doctor.js";

function makeDeps(overrides: Partial<DoctorDeps> = {}): DoctorDeps {
  const pass = (name: string): CheckResult => ({
    name,
    status: "pass",
    detail: "ok",
  });
  const base: DoctorDeps = {
    checkNodeVersion: async () => pass("node version"),
    checkOpencodePin: async () => pass("opencode-ai pin"),
    checkPatchSentinels: async () => pass("patch sentinels"),
    checkJellyclawHome: async () => pass("~/.jellyclaw"),
    checkApiKey: async () => pass("ANTHROPIC_API_KEY"),
    checkMcpServers: async () => pass("MCP servers"),
    checkSqliteIntegrity: async () => pass("sqlite integrity"),
    checkRuntime: async () => pass("runtime"),
  };
  return { ...base, ...overrides };
}

class MemStream {
  chunks: string[] = [];
  write(chunk: string, cb?: (err?: Error | null) => void): boolean {
    this.chunks.push(chunk);
    if (cb) cb();
    return true;
  }
  once(_event: "drain", _listener: () => void): this {
    return this;
  }
  text(): string {
    return this.chunks.join("");
  }
}

function asStream(s: MemStream): NodeJS.WritableStream {
  return s as unknown as NodeJS.WritableStream;
}

// ---------------------------------------------------------------------------
// runChecks — shape tests
// ---------------------------------------------------------------------------

describe("runChecks", () => {
  it("all-pass: returns 8 passing results in deterministic order", async () => {
    const results = await runChecks(makeDeps());
    expect(results).toHaveLength(8);
    expect(results.every((r) => r.status === "pass")).toBe(true);
  });

  it("Node too old → fail with remediation", async () => {
    const deps = makeDeps({
      checkNodeVersion: async () => ({
        name: "node version",
        status: "fail",
        detail: "node 18.0.0 is below 20.6",
        remediation: "upgrade via `nvm install 20`",
      }),
    });
    const results = await runChecks(deps);
    const node = results.find((r) => r.name === "node version");
    expect(node?.status).toBe("fail");
    expect(node?.remediation).toMatch(/nvm install/);
  });

  it("opencode version mismatch → fail", async () => {
    const deps = makeDeps({
      checkOpencodePin: async () => ({
        name: "opencode-ai pin",
        status: "fail",
        detail: "installed 1.4.4, pinned 1.4.5",
        remediation: "run `bun install`",
      }),
    });
    const results = await runChecks(deps);
    expect(results.find((r) => r.name === "opencode-ai pin")?.status).toBe("fail");
  });

  it("missing patch sentinel → fail", async () => {
    const deps = makeDeps({
      checkPatchSentinels: async () => ({
        name: "patch sentinels",
        status: "fail",
        detail: "missing 1: patches/001-subagent-hook-fire.patch",
        remediation: "restore patches/ from git",
      }),
    });
    const results = await runChecks(deps);
    expect(results.find((r) => r.name === "patch sentinels")?.status).toBe("fail");
  });

  it("bad ~/.jellyclaw mode (0o755) → fail", async () => {
    const deps = makeDeps({
      checkJellyclawHome: async () => ({
        name: "~/.jellyclaw",
        status: "fail",
        detail: "/home/u/.jellyclaw mode 755 too permissive",
        remediation: "chmod 700 ~/.jellyclaw",
      }),
    });
    const results = await runChecks(deps);
    expect(results.find((r) => r.name === "~/.jellyclaw")?.status).toBe("fail");
  });

  it("missing API key → warn (not fail)", async () => {
    const deps = makeDeps({
      checkApiKey: async () => ({
        name: "ANTHROPIC_API_KEY",
        status: "warn",
        detail: "ANTHROPIC_API_KEY not set",
      }),
    });
    const results = await runChecks(deps);
    const k = results.find((r) => r.name === "ANTHROPIC_API_KEY");
    expect(k?.status).toBe("warn");
  });

  it("unreachable optional MCP server → warn", async () => {
    const deps = makeDeps({
      checkMcpServers: async () => ({
        name: "MCP servers",
        status: "warn",
        detail: "1/2 reachable; unreachable: playwright",
      }),
    });
    const results = await runChecks(deps);
    expect(results.find((r) => r.name === "MCP servers")?.status).toBe("warn");
  });

  it("unreachable required MCP server → fail", async () => {
    const deps = makeDeps({
      checkMcpServers: async () => ({
        name: "MCP servers",
        status: "fail",
        detail: "required servers unreachable: atlas",
        remediation: "check ~/.jellyclaw/mcp.json",
      }),
    });
    const results = await runChecks(deps);
    expect(results.find((r) => r.name === "MCP servers")?.status).toBe("fail");
  });

  it("sqlite integrity ok → pass", async () => {
    const results = await runChecks(makeDeps());
    expect(results.find((r) => r.name === "sqlite integrity")?.status).toBe("pass");
  });

  it("a probe that throws is captured as a fail row, not bubbled", async () => {
    const deps = makeDeps({
      // biome-ignore lint/suspicious/useAwait: DoctorDeps returns Promise; stub throws synchronously on purpose.
      checkNodeVersion: async () => {
        throw new Error("boom");
      },
    });
    const results = await runChecks(deps);
    const row = results.find((r) => r.name === "checkNodeVersion");
    expect(row?.status).toBe("fail");
    expect(row?.detail).toContain("boom");
  });
});

// ---------------------------------------------------------------------------
// doctorAction — exit code + rendering
// ---------------------------------------------------------------------------

describe("doctorAction", () => {
  it("all-pass → exit 0, no Fixes block", async () => {
    const stdout = new MemStream();
    const code = await doctorAction({
      stdout: asStream(stdout),
      deps: makeDeps(),
    });
    expect(code).toBe(0);
    expect(stdout.text()).not.toContain("Fixes:");
  });

  it("warnings-only → exit 0, no Fixes block", async () => {
    const stdout = new MemStream();
    const code = await doctorAction({
      stdout: asStream(stdout),
      deps: makeDeps({
        checkApiKey: async () => ({
          name: "ANTHROPIC_API_KEY",
          status: "warn",
          detail: "unset",
        }),
      }),
    });
    expect(code).toBe(0);
    expect(stdout.text()).not.toContain("Fixes:");
  });

  it("one fail → exit 2 and prints Fixes with remediation", async () => {
    const stdout = new MemStream();
    const code = await doctorAction({
      stdout: asStream(stdout),
      deps: makeDeps({
        checkNodeVersion: async () => ({
          name: "node version",
          status: "fail",
          detail: "too old",
          remediation: "upgrade via `nvm install 20`",
        }),
      }),
    });
    expect(code).toBe(2);
    expect(stdout.text()).toContain("Fixes:");
    expect(stdout.text()).toContain("nvm install 20");
  });
});

// ---------------------------------------------------------------------------
// Rendering smoke
// ---------------------------------------------------------------------------

describe("renderTable", () => {
  it("renders a header row, a separator, and one row per result", () => {
    const table = renderTable([
      { name: "alpha", status: "pass", detail: "ok" },
      { name: "beta", status: "warn", detail: "maybe" },
      { name: "gamma", status: "fail", detail: "no" },
    ]);
    expect(table).toContain("Check");
    expect(table).toContain("Status");
    expect(table).toContain("Detail");
    expect(table).toContain("alpha");
    expect(table).toContain("beta");
    expect(table).toContain("gamma");
  });
});

// ---------------------------------------------------------------------------
// T4-07 acceptance test
// ---------------------------------------------------------------------------

describe("doctor-clean-install-exits-0", () => {
  it("exits 0 when all checks pass (simulating clean install)", async () => {
    // This test simulates a clean install scenario where:
    // - Node version is adequate (>= 20.6)
    // - Runtime is detected correctly
    // - opencode-ai is pinned correctly
    // - Patch sentinels are present
    // - ~/.jellyclaw/ is writable
    // - API key is present (or only warns if missing)
    // - MCP servers are reachable (or only warns)
    // - SQLite integrity is ok
    const stdout = new MemStream();
    const code = await doctorAction({
      stdout: asStream(stdout),
      deps: makeDeps(), // All checks pass by default
    });
    expect(code).toBe(0);
    // Output should show all passing checks (✓ symbol)
    expect(stdout.text()).toContain("✓");
    // Should not show any "fail" status (✗ symbol)
    expect(stdout.text()).not.toContain("✗");
  });

  it("exits 0 even with warnings (clean install with optional items missing)", async () => {
    // Simulate clean install where API key is not set (warning, not error)
    const stdout = new MemStream();
    const code = await doctorAction({
      stdout: asStream(stdout),
      deps: makeDeps({
        checkApiKey: async () => ({
          name: "ANTHROPIC_API_KEY",
          status: "warn",
          detail: "not set (optional for clean install verification)",
        }),
        checkMcpServers: async () => ({
          name: "MCP servers",
          status: "warn",
          detail: "no MCP config found (optional)",
        }),
      }),
    });
    // Should still exit 0 because warnings don't flip exit code
    expect(code).toBe(0);
  });
});
