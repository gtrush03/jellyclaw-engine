#!/usr/bin/env node
/**
 * jellyclaw smoke-suite runner.
 *
 * Usage:
 *   node engine/test/smoke/run-smoke.mjs [--test <name>] [--verbose]
 *                                        [--parallel|--serial] [--output json|pretty]
 *
 * Discovers `engine/test/smoke/smoke-*.mjs`, default-imports each, and calls
 * the async `run({harness, log})` export. Each test returns
 * { name, passed, duration_ms, details? }. Exit 0 iff every test passed.
 *
 * Results are always written to `engine/test/smoke/results/latest.json`.
 *
 * The autobuild global-regression tester consumes `--output json` and treats
 * `failed > 0` as a hard rollback signal.
 */

import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as harness from "./lib/harness.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SMOKE_DIR = __dirname;
const RESULTS_DIR = join(SMOKE_DIR, "results");

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    test: null,
    verbose: false,
    parallel: true,
    output: "pretty",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--test") {
      args.test = argv[++i] ?? null;
    } else if (a === "--verbose") {
      args.verbose = true;
    } else if (a === "--parallel") {
      args.parallel = true;
    } else if (a === "--serial") {
      args.parallel = false;
    } else if (a === "--output") {
      args.output = argv[++i] ?? "pretty";
    } else if (a === "--help" || a === "-h") {
      process.stdout.write(
        "usage: run-smoke.mjs [--test <name>] [--verbose] [--parallel|--serial] [--output json|pretty]\n",
      );
      process.exit(0);
    } else {
      process.stderr.write(`run-smoke: unknown arg: ${a}\n`);
      process.exit(2);
    }
  }
  if (args.output !== "json" && args.output !== "pretty") {
    process.stderr.write(`run-smoke: --output must be json|pretty (got ${args.output})\n`);
    process.exit(2);
  }
  return args;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

function discoverTests(filter) {
  const entries = readdirSync(SMOKE_DIR, { withFileTypes: true })
    .filter((d) => d.isFile() && /^smoke-.*\.mjs$/.test(d.name))
    .map((d) => d.name)
    .sort();
  if (filter) {
    return entries.filter(
      (n) => n === filter || n === `${filter}.mjs` || n.startsWith(`${filter}-`) || n.includes(filter),
    );
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  grey: "\x1b[90m",
};

function colorize(s, style) {
  if (process.stdout.isTTY === false) return s;
  return `${ANSI[style] ?? ""}${s}${ANSI.reset}`;
}

async function runOne(filename, { verbose }) {
  const full = resolve(SMOKE_DIR, filename);
  const modUrl = pathToFileURL(full).href;
  const logs = [];
  const log = verbose
    ? (msg) => {
        logs.push(msg);
        process.stderr.write(`[${filename}] ${msg}\n`);
      }
    : (msg) => {
        logs.push(msg);
      };

  const started = Date.now();
  let mod;
  try {
    mod = await import(modUrl);
  } catch (err) {
    return {
      name: filename.replace(/\.mjs$/, ""),
      passed: false,
      duration_ms: Date.now() - started,
      error: { message: `import failed: ${err?.message ?? err}`, stack: err?.stack },
      logs,
    };
  }
  if (typeof mod.default !== "function") {
    return {
      name: filename.replace(/\.mjs$/, ""),
      passed: false,
      duration_ms: Date.now() - started,
      error: { message: "module has no default async function export" },
      logs,
    };
  }

  try {
    const result = await mod.default({ harness, log });
    return {
      name: result?.name ?? filename.replace(/\.mjs$/, ""),
      passed: result?.passed !== false,
      duration_ms: result?.duration_ms ?? Date.now() - started,
      details: result?.details,
      logs,
    };
  } catch (err) {
    return {
      name: filename.replace(/\.mjs$/, ""),
      passed: false,
      duration_ms: Date.now() - started,
      error: {
        message: err?.message ?? String(err),
        label: err?.label,
        stack: err?.stack,
      },
      logs,
    };
  }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function reportPretty(summary) {
  const pad = (s, n) => (s.length >= n ? s : s + " ".repeat(n - s.length));
  const lines = [];
  lines.push(
    colorize(
      `\njellyclaw smoke-suite — ${summary.passed}/${summary.total} passed (${summary.duration_ms}ms)`,
      "bold",
    ),
  );
  lines.push(colorize("─".repeat(72), "grey"));
  for (const t of summary.tests) {
    const mark = t.passed ? colorize("PASS", "green") : colorize("FAIL", "red");
    const name = pad(t.name, 32);
    const dur = colorize(`${t.duration_ms}ms`, "dim");
    lines.push(`  ${mark}  ${name}  ${dur}`);
    if (!t.passed && t.error) {
      lines.push(
        colorize(
          `        ↳ ${t.error.label ? `[${t.error.label}] ` : ""}${t.error.message}`,
          "red",
        ),
      );
    }
    if (t.details && typeof t.details === "object") {
      const flat = JSON.stringify(t.details);
      if (flat.length < 300) lines.push(colorize(`        ${flat}`, "dim"));
    }
  }
  lines.push(colorize("─".repeat(72), "grey"));
  if (summary.failed === 0) {
    lines.push(colorize(`  all green — ${summary.passed} tests ok.`, "green"));
  } else {
    lines.push(colorize(`  ${summary.failed} test(s) failed.`, "red"));
  }
  process.stdout.write(lines.join("\n") + "\n");
}

function reportJson(summary) {
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
}

function writeLatest(summary) {
  try {
    mkdirSync(RESULTS_DIR, { recursive: true });
    writeFileSync(join(RESULTS_DIR, "latest.json"), JSON.stringify(summary, null, 2) + "\n");
  } catch (err) {
    process.stderr.write(`run-smoke: failed to write latest.json: ${err?.message ?? err}\n`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const files = discoverTests(args.test);
  if (files.length === 0) {
    process.stderr.write(`run-smoke: no matching tests (filter=${args.test ?? "none"})\n`);
    process.exit(2);
  }

  const suiteStart = Date.now();
  let results;

  if (args.parallel) {
    results = await Promise.all(files.map((f) => runOne(f, { verbose: args.verbose })));
  } else {
    results = [];
    for (const f of files) {
      // eslint-disable-next-line no-await-in-loop
      results.push(await runOne(f, { verbose: args.verbose }));
    }
  }

  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;

  const summary = {
    total: results.length,
    passed,
    failed,
    duration_ms: Date.now() - suiteStart,
    parallel: args.parallel,
    tests: results.map((r) => ({
      name: r.name,
      passed: r.passed,
      duration_ms: r.duration_ms,
      ...(r.details !== undefined ? { details: r.details } : {}),
      ...(r.error !== undefined ? { error: r.error } : {}),
      ...(args.verbose && r.logs && r.logs.length > 0 ? { logs: r.logs } : {}),
    })),
    ts: new Date().toISOString(),
  };

  writeLatest(summary);

  if (args.output === "json") reportJson(summary);
  else reportPretty(summary);

  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`run-smoke: fatal: ${err?.stack ?? err}\n`);
  process.exit(2);
});
