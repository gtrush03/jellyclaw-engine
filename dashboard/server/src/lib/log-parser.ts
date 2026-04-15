import fs from "node:fs/promises";
import { COMPLETION_LOG, STATUS_FILE } from "./paths.js";
import type { PhaseStatus, SessionLogRow, StatusSnapshot } from "../types.js";

export interface CompletionLogParsed {
  currentPhase: string | null;
  progressPercent: number;
  phaseStatus: Record<string, PhaseStatus>;
  sessionLog: SessionLogRow[];
  blockers: string[];
}

const PHASE_CHECK_RE = /^- \[( |x|X)\]\s*(?:🟡\s*|✅\s*)?Phase\s+(\d+(?:\.\d+)?)\b/;
// "[██░░...] 3/21 phases complete (15%)"
const PROGRESS_RE = /(\d+)\s*\/\s*(\d+)\s+phases\s+complete/i;
const CURRENT_PHASE_RE = /\*\*Current phase:\*\*\s*(.+?)\s*$/mi;

/**
 * Parse COMPLETION-LOG.md into structured state. Resilient to missing sections.
 */
export async function parseCompletionLog(): Promise<CompletionLogParsed> {
  let raw: string;
  try {
    raw = await fs.readFile(COMPLETION_LOG, "utf8");
  } catch {
    return {
      currentPhase: null,
      progressPercent: 0,
      phaseStatus: {},
      sessionLog: [],
      blockers: [],
    };
  }

  const phaseStatus: Record<string, PhaseStatus> = {};
  for (const line of raw.split("\n")) {
    const m = line.match(PHASE_CHECK_RE);
    if (!m) continue;
    const checked = m[1].toLowerCase() === "x";
    // Decimal phase ids (e.g. "10.5") are preserved as-is; integer ids are
    // zero-padded to two digits ("5" → "05") to match the on-disk phase-id
    // convention used by the rest of the dashboard.
    const raw2 = m[2];
    const num = raw2.includes(".") ? raw2 : raw2.padStart(2, "0");
    phaseStatus[num] = checked ? "complete" : "not-started";
  }

  // Detect in-progress phases by splitting on `### Phase N —` sections and
  // inspecting each block independently (avoids greedy matches across phases).
  const sectionRe = /^###\s+Phase\s+(\d+(?:\.\d+)?)\s+—/gm;
  const sectionStarts: Array<{ phase: string; start: number }> = [];
  let sm: RegExpExecArray | null;
  while ((sm = sectionRe.exec(raw)) !== null) {
    const raw2 = sm[1];
    sectionStarts.push({
      phase: raw2.includes(".") ? raw2 : raw2.padStart(2, "0"),
      start: sm.index,
    });
  }
  for (let i = 0; i < sectionStarts.length; i++) {
    const { phase: num, start } = sectionStarts[i];
    const end =
      i + 1 < sectionStarts.length ? sectionStarts[i + 1].start : raw.length;
    const section = raw.slice(start, end);
    if (
      /\*\*Status:\*\*\s*🔄\s*In progress/i.test(section) &&
      phaseStatus[num] !== "complete"
    ) {
      phaseStatus[num] = "in-progress";
    }
  }

  // Current phase
  const cp = raw.match(CURRENT_PHASE_RE);
  const currentPhase = cp ? cp[1].trim() : null;

  // Progress
  let progressPercent = 0;
  const pm = raw.match(PROGRESS_RE);
  if (pm) {
    const done = Number(pm[1]);
    const total = Number(pm[2]);
    if (total > 0) progressPercent = Math.round((done / total) * 100);
  }

  // Session log table
  const sessionLog = parseSessionLog(raw);

  // Blockers — take any bulleted items under "## Blockers" (before next `## `)
  const blockers = parseBulletSection(raw, /^##\s+Blockers.*$/im);

  return { currentPhase, progressPercent, phaseStatus, sessionLog, blockers };
}

function parseSessionLog(raw: string): SessionLogRow[] {
  const idx = raw.search(/^##\s+Session\s+log/mi);
  if (idx < 0) return [];
  const tail = raw.slice(idx);
  const lines = tail.split("\n");
  const rows: SessionLogRow[] = [];
  let inTable = false;
  let headerSeen = false;
  for (const line of lines) {
    if (!inTable) {
      if (line.trim().startsWith("|")) inTable = true;
      else continue;
    }
    if (!line.trim().startsWith("|")) {
      if (inTable && headerSeen) break;
      continue;
    }
    // Skip header + separator rows
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length < 5) continue;
    if (!headerSeen) {
      // This is the header
      headerSeen = true;
      continue;
    }
    if (/^-{2,}/.test(cells[0])) continue; // separator row
    rows.push({
      date: cells[0] ?? "",
      sessionNumber: cells[1] ?? "",
      phase: cells[2] ?? "",
      subPrompt: cells[3] ?? "",
      outcome: cells[4] ?? "",
    });
  }
  return rows;
}

function parseBulletSection(raw: string, headingRe: RegExp): string[] {
  const match = raw.match(headingRe);
  if (!match || match.index === undefined) return [];
  const start = match.index + match[0].length;
  const after = raw.slice(start);
  const nextHeading = after.search(/^##\s+/m);
  const slice = nextHeading >= 0 ? after.slice(0, nextHeading) : after;
  const items: string[] = [];
  for (const line of slice.split("\n")) {
    const bullet = line.match(/^\s*-\s+(.+?)\s*$/);
    if (bullet) {
      const txt = bullet[1];
      if (/^none$/i.test(txt)) continue;
      items.push(txt);
    }
  }
  return items;
}

export interface StatusParsed {
  lastUpdated: string | null;
  currentPhase: string | null;
  testsPassing: number;
  testsFailing: number;
  burnRateTotal: string | null;
  blockers: string[];
}

export async function parseStatus(): Promise<StatusParsed> {
  let raw: string;
  try {
    raw = await fs.readFile(STATUS_FILE, "utf8");
  } catch {
    return {
      lastUpdated: null,
      currentPhase: null,
      testsPassing: 0,
      testsFailing: 0,
      burnRateTotal: null,
      blockers: [],
    };
  }

  const lastUpdatedMatch = raw.match(/\*\*Last updated:\*\*\s*(.+?)\s*$/mi);
  const currentPhaseMatch = raw.match(/\*\*Current phase:\*\*\s*(.+?)\s*$/mi);

  // Tests table: rows like "| Unit tests passing | 6 |"
  const testsPassing = parseTableInt(raw, /unit tests passing/i);
  const testsFailing = parseTableInt(raw, /unit tests failing/i);

  // Burn rate total: row starting with "| **Total**"
  const burnRow = raw.match(/^\|\s*\*\*Total\*\*\s*\|([^|]+)\|([^|]+)\|/m);
  const burnRateTotal = burnRow ? burnRow[2].trim() : null;

  const blockers = parseBulletSection(raw, /^##\s+Blockers.*$/im);

  return {
    lastUpdated: lastUpdatedMatch ? lastUpdatedMatch[1].trim() : null,
    currentPhase: currentPhaseMatch ? currentPhaseMatch[1].trim() : null,
    testsPassing,
    testsFailing,
    burnRateTotal,
    blockers,
  };
}

function parseTableInt(raw: string, labelRe: RegExp): number {
  for (const line of raw.split("\n")) {
    if (!line.trim().startsWith("|")) continue;
    if (!labelRe.test(line)) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length < 2) continue;
    const n = Number(cells[1]);
    if (!Number.isNaN(n)) return n;
  }
  return 0;
}

/**
 * Union of both files into one status snapshot for GET /api/status.
 */
export async function buildStatusSnapshot(): Promise<StatusSnapshot> {
  const [clog, stat] = await Promise.all([parseCompletionLog(), parseStatus()]);
  const blockers = Array.from(
    new Set([...(clog.blockers ?? []), ...(stat.blockers ?? [])]),
  );
  return {
    lastUpdated: stat.lastUpdated,
    currentPhase: stat.currentPhase ?? clog.currentPhase,
    progressPercent: clog.progressPercent,
    testsPassing: stat.testsPassing,
    testsFailing: stat.testsFailing,
    burnRateTotal: stat.burnRateTotal,
    blockers,
    phaseStatus: clog.phaseStatus,
    sessionLog: clog.sessionLog,
  };
}
