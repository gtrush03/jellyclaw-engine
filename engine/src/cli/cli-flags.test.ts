/**
 * Phase 10.01 — Commander parse-only tests for the `run` subcommand.
 *
 * These tests exercise the CLI surface without spawning a subprocess. We
 * replace the real `run` action on the Commander command so the engine never
 * boots. Assertions focus on: validation, conflicts, CSV parsing, variadic
 * options, and stdin piping logic (via the action factory).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CommanderError } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentEvent } from "../events.js";
import { openDb } from "../session/db.js";
import { WishLedger } from "../session/idempotency.js";
import { SessionPaths } from "../session/paths.js";
import { buildProgram } from "./main.js";
import type { OutputWriter } from "./output-types.js";
import { createRunAction, parseCsv, type RunActionDeps, type RunCliOptions } from "./run.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a program whose `run` action is replaced by the provided spy. */
function programWithRunSpy(
  spy: (prompt: string | undefined, options: RunCliOptions) => Promise<void> | void,
): ReturnType<typeof buildProgram> {
  const program = buildProgram();
  const run = program.commands.find((c) => c.name() === "run");
  if (!run) throw new Error("run subcommand not registered");
  run.action(async (prompt: string | undefined, options: RunCliOptions) => {
    await spy(prompt, options);
  });
  return program;
}

// ---------------------------------------------------------------------------
// Flag parsing
// ---------------------------------------------------------------------------

describe("run: flag parsing", () => {
  it("rejects invalid --output-format values via commander .choices()-style validation", async () => {
    // output-format uses a free string at Commander level; validation happens
    // in run.ts via resolveOutputFormat. Verify it throws ExitError(2).
    const deps = makeStubDeps();
    const action = createRunAction(deps);
    await expect(action("hi", { outputFormat: "junk" } as RunCliOptions)).rejects.toThrow(
      /invalid --output-format/,
    );
  });

  it("propagates --permission-mode plan into options", async () => {
    let captured: RunCliOptions | undefined;
    const program = programWithRunSpy((_p, o) => {
      captured = o;
    });
    await program.parseAsync(
      ["run", "hello", "--permission-mode", "plan", "--model", "claude-opus"],
      { from: "user" },
    );
    expect(captured?.permissionMode).toBe("plan");
    expect(captured?.model).toBe("claude-opus");
  });

  it("rejects --permission-mode with an unknown value via commander .choices()", async () => {
    const program = programWithRunSpy(() => {
      /* unused */
    });
    await expect(
      program.parseAsync(["run", "hi", "--permission-mode", "nope"], { from: "user" }),
    ).rejects.toBeInstanceOf(CommanderError);
  });

  it("rejects --provider with an unknown value", async () => {
    const program = programWithRunSpy(() => {
      /* unused */
    });
    await expect(
      program.parseAsync(["run", "hi", "--provider", "bogus"], { from: "user" }),
    ).rejects.toBeInstanceOf(CommanderError);
  });

  it("--resume conflicts with --continue (commander .conflicts())", async () => {
    const program = programWithRunSpy(() => {
      /* unused */
    });
    await expect(
      program.parseAsync(["run", "--resume", "abc", "--continue"], { from: "user" }),
    ).rejects.toBeInstanceOf(CommanderError);
  });

  it("--add-dir accumulates across multiple invocations", async () => {
    let captured: RunCliOptions | undefined;
    const program = programWithRunSpy((_p, o) => {
      captured = o;
    });
    await program.parseAsync(
      ["run", "hi", "--add-dir", "one", "--add-dir", "two", "--add-dir", "three"],
      { from: "user" },
    );
    expect(captured?.addDir).toEqual(["one", "two", "three"]);
  });

  it("preserves mcp__server__tool names through --allowed-tools CSV", () => {
    const parsed = parseCsv("Read,mcp__playwright__navigate,Bash");
    expect(parsed).toEqual(["Read", "mcp__playwright__navigate", "Bash"]);
  });

  it("trims whitespace but keeps double underscores in --allowed-tools", () => {
    const parsed = parseCsv(" Read , mcp__playwright__navigate ,Bash ");
    expect(parsed).toEqual(["Read", "mcp__playwright__navigate", "Bash"]);
  });
});

// ---------------------------------------------------------------------------
// --max-turns / --max-cost-usd validation
// ---------------------------------------------------------------------------

describe("run: numeric validation", () => {
  it("rejects --max-turns that isn't an integer", async () => {
    const deps = makeStubDeps();
    const action = createRunAction(deps);
    await expect(action("hi", { maxTurns: "banana" } as RunCliOptions)).rejects.toThrow(
      /--max-turns/,
    );
  });

  it("rejects --max-cost-usd that isn't a number", async () => {
    const deps = makeStubDeps();
    const action = createRunAction(deps);
    await expect(action("hi", { maxCostUsd: "banana" } as RunCliOptions)).rejects.toThrow(
      /--max-cost-usd/,
    );
  });

  it("rejects negative --max-cost-usd", async () => {
    const deps = makeStubDeps();
    const action = createRunAction(deps);
    await expect(action("hi", { maxCostUsd: "-1.5" } as RunCliOptions)).rejects.toThrow(
      /--max-cost-usd/,
    );
  });
});

// ---------------------------------------------------------------------------
// Wish idempotency short-circuit
// ---------------------------------------------------------------------------

describe("run: --wish-id short-circuit", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "jellyclaw-cli-flags-"));
    process.env.JELLYCLAW_HOME = tmp;
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    delete process.env.JELLYCLAW_HOME;
  });

  it("returns cached output without invoking runFn when wish is done", async () => {
    // Seed a completed wish in the ledger.
    const paths = new SessionPaths({ home: tmp });
    const db = await openDb({ paths });
    const ledger = new WishLedger(paths, db);
    const wishId = "wish-xyz";
    await ledger.begin({ wishId });
    await ledger.complete(wishId, "cached-result-body");
    db.close();

    // Collect writer output.
    const events: AgentEvent[] = [];
    const runFn = vi.fn(function* () {
      // Should never run.
      yield {} as AgentEvent;
    });
    const deps: RunActionDeps = {
      runFn,
      createWriter: (): OutputWriter => ({
        write: (ev) => {
          events.push(ev);
          return Promise.resolve();
        },
        finish: () => Promise.resolve(),
      }),
      openWishLedger: async () => {
        const p = new SessionPaths({ home: tmp });
        const d = await openDb({ paths: p });
        return { ledger: new WishLedger(p, d), close: () => d.close() };
      },
      readStdin: () => Promise.resolve(""),
      isStdinTty: () => true,
      isStdoutTty: () => false,
      stdout: process.stdout,
      stderr: process.stderr,
    };
    const action = createRunAction(deps);
    await action("hi", { wishId } as RunCliOptions);

    expect(runFn).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("session.completed");
  });
});

// ---------------------------------------------------------------------------
// Stdin piping
// ---------------------------------------------------------------------------

describe("run: stdin piping", () => {
  it("reads stdin when no positional prompt and stdin is not a TTY", async () => {
    const deps: RunActionDeps = {
      runFn: async function* () {
        /* no events */
      },
      createWriter: () => ({
        write: async () => {
          /* noop */
        },
        finish: async () => {
          /* noop */
        },
      }),
      openWishLedger: async () => null,
      readStdin: async () => "piped prompt body\n",
      isStdinTty: () => false,
      isStdoutTty: () => false,
      stdout: process.stdout,
      stderr: process.stderr,
    };
    const action = createRunAction(deps);
    const runFnSpy = vi.spyOn(deps, "runFn");

    await action(undefined, {} as RunCliOptions);

    expect(runFnSpy).toHaveBeenCalledOnce();
    const callArg = runFnSpy.mock.calls[0]?.[0];
    expect(callArg?.wish).toBe("piped prompt body");
  });

  it("fails with exit-2 when no prompt, TTY stdin, and no session anchor", async () => {
    const deps = makeStubDeps({ isStdinTty: () => true });
    const action = createRunAction(deps);
    await expect(action(undefined, {} as RunCliOptions)).rejects.toThrow(/missing <prompt>/);
  });
});

// ---------------------------------------------------------------------------
// --version / --help
// ---------------------------------------------------------------------------

describe("program: top-level", () => {
  it("responds to --version", async () => {
    const program = buildProgram();
    await expect(program.parseAsync(["--version"], { from: "user" })).rejects.toMatchObject({
      code: "commander.version",
    });
  });

  it("responds to --help", async () => {
    const program = buildProgram();
    // Suppress help output noise in test logs.
    program.configureOutput({
      writeOut: () => {
        /* noop */
      },
      writeErr: () => {
        /* noop */
      },
    });
    await expect(program.parseAsync(["--help"], { from: "user" })).rejects.toMatchObject({
      code: expect.stringMatching(/commander\.(help|helpDisplayed)/),
    });
  });

  it("lists all Phase-10.01 subcommands", () => {
    const program = buildProgram();
    const names = program.commands.map((c) => c.name()).sort();
    expect(names).toEqual(
      [
        "agents",
        "attach",
        "config",
        "continue",
        "doctor",
        "mcp",
        "resume",
        "run",
        "serve",
        "sessions",
        "skills",
        "tui",
      ].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// Stub deps helper
// ---------------------------------------------------------------------------

function makeStubDeps(overrides: Partial<RunActionDeps> = {}): RunActionDeps {
  return {
    runFn: async function* () {
      /* yields nothing */
    },
    createWriter: () => ({
      write: async () => {
        /* noop */
      },
      finish: async () => {
        /* noop */
      },
    }),
    openWishLedger: async () => null,
    readStdin: async () => "",
    isStdinTty: () => true,
    isStdoutTty: () => false,
    stdout: process.stdout,
    stderr: process.stderr,
    ...overrides,
  };
}
