// completion-log.mjs — multi-line COMPLETION-LOG.md writer for the autobuild rig.
//
// The rig runs SUB-PROMPTS (e.g. T0-01 within phase-99b-unfucking-v2). So the
// log entry model is two-level:
//
//   1. Top-level "Phase checklist" list item for the autobuild phase (created
//      once, updated with a per-pass sub-prompt counter in the title).
//   2. A "### Phase <id> — <name>" block in "## Phase completion details"
//      containing a markdown table logging each sub-prompt pass.
//
// Guarantees:
//   - Idempotent: running twice for the same (phase-id, prompt-id) does not
//     duplicate a row.
//   - Atomic: write via tmp → rename.
//   - Preserves hand-edited content: read, locate insertion points, splice.

import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";

const DETAILS_HEADING = "## Phase completion details";
const CHECKLIST_HEADING = "## Phase checklist";
const PHASE_HEADING_RE = /^###\s+Phase\s+([^\s—-]+)\s*—\s*(.+?)\s*$/;
const SUBPROMPT_LOG_HEADING = "#### Sub-prompt log";

/**
 * Public API. Append a sub-prompt pass to COMPLETION-LOG.md, creating the
 * phase section if missing.
 *
 * @param {object} opts
 * @param {string} opts.logPath            — absolute path to COMPLETION-LOG.md
 * @param {string} opts.phaseId            — e.g. "99b-unfucking-v2"
 * @param {string} [opts.phaseName]        — e.g. "Unfucking v2 (autobuild-driven)"
 * @param {string} opts.promptId           — e.g. "T0-01-fix-serve-shim"
 * @param {string} opts.promptTitle        — frontmatter title
 * @param {string} opts.endedAtIso         — ISO-8601 timestamp of pass completion
 * @param {string} [opts.startedAtIso]     — ISO-8601 timestamp of spawn; used for duration
 * @param {string[]} [opts.commits]        — short SHA list
 * @param {object} opts.tests              — { passed, total }
 * @param {boolean} [opts.phaseComplete]   — flip status to ✅ and set Completed date
 * @returns {{ created: boolean, appended: boolean, duplicate: boolean }}
 */
export function appendCompletionLogEntry(opts) {
  const {
    logPath,
    phaseId,
    phaseName = "Unfucking v2 (autobuild-driven)",
    promptId,
    promptTitle,
    endedAtIso,
    startedAtIso,
    commits = [],
    tests = { passed: 0, total: 0 },
    phaseComplete = false,
  } = opts;

  if (!logPath) throw new Error("appendCompletionLogEntry: logPath required");
  if (!phaseId) throw new Error("appendCompletionLogEntry: phaseId required");
  if (!promptId) throw new Error("appendCompletionLogEntry: promptId required");

  // If the file does not exist we create a minimal skeleton. (In production
  // COMPLETION-LOG.md is committed to the repo — this branch is for tests.)
  let content;
  if (!existsSync(logPath)) {
    content = buildSkeleton();
  } else {
    content = readFileSync(logPath, "utf8");
  }

  const date = endedAtIso ? endedAtIso.slice(0, 10) : new Date().toISOString().slice(0, 10);
  const row = buildRow({ promptId, promptTitle, endedAtIso, startedAtIso, commits, tests });

  // 1. Ensure phase block exists in "## Phase completion details".
  const phaseKey = `Phase ${phaseId}`;
  const present = findPhaseSection(content, phaseKey);
  let created = false;
  if (!present) {
    content = insertPhaseSection(content, {
      phaseId,
      phaseName,
      startedDate: date,
    });
    created = true;
  }

  // 2. Check for duplicate row in the phase section.
  const duplicate = phaseSectionHasRow(content, phaseKey, promptId);

  // 3. Append the row (idempotent).
  let appended = false;
  if (!duplicate) {
    content = appendRowToPhase(content, phaseKey, row);
    content = incrementPhaseCounters(content, phaseKey, {
      addSessions: 1,
      addTestsPassed: Number(tests.passed || 0),
      addTestsTotal: Number(tests.total || 0),
      lastUpdatedDate: date,
      phaseComplete,
      completedDate: phaseComplete ? date : null,
    });
    appended = true;
  }

  // 4. Ensure a matching checklist entry exists (top-of-file list).
  content = upsertChecklistEntry(content, {
    phaseId,
    phaseName,
    phaseComplete,
    passCount: countSubpromptRows(content, phaseKey),
  });

  // 5. Atomic write.
  if (appended || created) {
    atomicWrite(logPath, content);
  }

  return { created, appended, duplicate };
}

function atomicWrite(path, content) {
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

function buildSkeleton() {
  return [
    "# Jellyclaw Engine — Completion Log",
    "",
    "**Last updated:** " + new Date().toISOString().slice(0, 10),
    "",
    "## Phase checklist",
    "",
    "### Unfucking v2",
    "",
    "## Phase completion details",
    "",
  ].join("\n");
}

function findPhaseSection(content, phaseKey) {
  // Look for a line starting with "### Phase <phaseId> — ..."
  const re = new RegExp(`^###\\s+${escapeRe(phaseKey)}\\s*—`, "m");
  return re.test(content);
}

function insertPhaseSection(content, { phaseId, phaseName, startedDate }) {
  const block = [
    "",
    `### Phase ${phaseId} — ${phaseName}`,
    "",
    "**Status:** 🔄 In progress (autobuild)",
    `**Started:** ${startedDate}`,
    "**Completed:** —",
    "**Duration (actual):** —",
    "**Session count:** 0",
    "**Commits:** —",
    "**Tests passing:** 0/0",
    `**Last updated:** ${startedDate}`,
    "**Notes:** Sub-prompts tracked below.",
    "",
    "#### Sub-prompt log",
    "",
    "| ID | Title | Completed (UTC) | Duration | Commits | Tests |",
    "|---|---|---|---|---|---|",
    "",
  ].join("\n");

  // Insert at end of file. If "## Phase completion details" heading present,
  // append after all existing ### sections (i.e. end of file is fine — phase
  // details run to EOF in the reference file).
  if (content.includes(DETAILS_HEADING)) {
    // Append at end. Make sure there's a trailing newline.
    const sep = content.endsWith("\n") ? "" : "\n";
    return content + sep + block + "\n";
  }
  // No details heading at all — append it.
  const sep = content.endsWith("\n") ? "" : "\n";
  return content + sep + "\n" + DETAILS_HEADING + "\n" + block + "\n";
}

function phaseSectionHasRow(content, phaseKey, promptId) {
  const section = extractPhaseSection(content, phaseKey);
  if (!section) return false;
  // A row looks like: `| T0-01-... | ...`
  const re = new RegExp(`^\\|\\s*${escapeRe(promptId)}\\s*\\|`, "m");
  return re.test(section);
}

function extractPhaseSection(content, phaseKey) {
  const lines = content.split("\n");
  const headerRe = new RegExp(`^###\\s+${escapeRe(phaseKey)}\\s*—`);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headerRe.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;
  // End at next "### " or "## " heading or EOF.
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^###?\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

function appendRowToPhase(content, phaseKey, row) {
  const lines = content.split("\n");
  const headerRe = new RegExp(`^###\\s+${escapeRe(phaseKey)}\\s*—`);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headerRe.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start === -1) return content;
  // End of this phase section.
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^###?\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  // Within this phase section, find the table separator line
  // (the `|---|---|...` line). The row goes immediately after the last
  // existing row (or right after the separator if no rows yet).
  let sepIdx = -1;
  for (let i = start; i < end; i++) {
    if (/^\|[-|\s]+\|$/.test(lines[i])) {
      sepIdx = i;
      break;
    }
  }
  if (sepIdx === -1) return content; // malformed phase block — skip
  // Find last existing data row (lines after sepIdx that start with "|" and
  // are not the separator).
  let insertAt = sepIdx + 1;
  for (let i = sepIdx + 1; i < end; i++) {
    if (lines[i].startsWith("|")) insertAt = i + 1;
    else if (lines[i].trim() === "") continue;
    else break;
  }
  lines.splice(insertAt, 0, row);
  return lines.join("\n");
}

function countSubpromptRows(content, phaseKey) {
  const section = extractPhaseSection(content, phaseKey);
  if (!section) return 0;
  const lines = section.split("\n");
  let count = 0;
  let inTable = false;
  for (const l of lines) {
    if (/^\|[-|\s]+\|$/.test(l)) {
      inTable = true;
      continue;
    }
    if (inTable && l.startsWith("|")) count++;
    else if (inTable && !l.startsWith("|")) inTable = false;
  }
  return count;
}

function incrementPhaseCounters(
  content,
  phaseKey,
  { addSessions, addTestsPassed, addTestsTotal, lastUpdatedDate, phaseComplete, completedDate },
) {
  const lines = content.split("\n");
  const headerRe = new RegExp(`^###\\s+${escapeRe(phaseKey)}\\s*—`);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headerRe.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start === -1) return content;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^###?\s/.test(lines[i])) {
      end = i;
      break;
    }
  }

  for (let i = start; i < end; i++) {
    const line = lines[i];
    let m;

    m = line.match(/^\*\*Session count:\*\*\s+(\d+)\s*$/);
    if (m) {
      const n = parseInt(m[1], 10) + (addSessions || 0);
      lines[i] = `**Session count:** ${n}`;
      continue;
    }

    m = line.match(/^\*\*Tests passing:\*\*\s+(\d+)\/(\d+)\s*$/);
    if (m) {
      const p = parseInt(m[1], 10) + (addTestsPassed || 0);
      const t = parseInt(m[2], 10) + (addTestsTotal || 0);
      lines[i] = `**Tests passing:** ${p}/${t}`;
      continue;
    }

    if (line.startsWith("**Last updated:**") && lastUpdatedDate) {
      lines[i] = `**Last updated:** ${lastUpdatedDate}`;
      continue;
    }

    if (phaseComplete && line.startsWith("**Status:**")) {
      lines[i] = "**Status:** ✅ Complete";
      continue;
    }
    if (phaseComplete && line.startsWith("**Completed:**") && completedDate) {
      lines[i] = `**Completed:** ${completedDate}`;
      continue;
    }
  }

  return lines.join("\n");
}

function buildRow({ promptId, promptTitle, endedAtIso, startedAtIso, commits, tests }) {
  const safeTitle = String(promptTitle || "").replace(/\|/g, "\\|");
  const completedUtc = endedAtIso || "";
  const duration = formatDuration(startedAtIso, endedAtIso);
  const shaList = (commits || []).filter(Boolean).join(", ") || "—";
  const testsCell =
    tests && Number.isFinite(tests.total)
      ? `${tests.passed ?? 0}/${tests.total ?? 0}`
      : "—";
  return `| ${promptId} | ${safeTitle} | ${completedUtc} | ${duration} | ${shaList} | ${testsCell} |`;
}

function formatDuration(startedAt, endedAt) {
  if (!startedAt || !endedAt) return "—";
  const t0 = Date.parse(startedAt);
  const t1 = Date.parse(endedAt);
  if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 < t0) return "—";
  const secs = Math.round((t1 - t0) / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  if (mins < 60) return `${mins}m${remSecs ? ` ${remSecs}s` : ""}`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hrs}h${remMins ? ` ${remMins}m` : ""}`;
}

function upsertChecklistEntry(content, { phaseId, phaseName, phaseComplete, passCount }) {
  // We look for existing entry whose line includes `Phase <phaseId>`; if found
  // we update the pass counter; if not we insert under "### Unfucking v2"
  // (creating that subhead right before "## Phase completion details" if it
  // doesn't exist).
  const lines = content.split("\n");
  const entryRe = new RegExp(`^- \\[[x\\s]\\].*Phase\\s+${escapeRe(phaseId)}\\b`);
  const mark = phaseComplete ? "[x]" : "[ ]";
  const icon = phaseComplete ? "✅" : "🔄";
  const counterSuffix = passCount > 0 ? ` (${passCount} sub-prompt${passCount === 1 ? "" : "s"})` : "";
  const desired = `- ${mark} ${icon} Phase ${phaseId} — ${phaseName}${counterSuffix}`;

  for (let i = 0; i < lines.length; i++) {
    if (entryRe.test(lines[i])) {
      lines[i] = desired;
      return lines.join("\n");
    }
  }

  // Not found — insert under "### Unfucking v2". Create subhead if needed.
  const checklistIdx = lines.findIndex((l) => l.trim() === CHECKLIST_HEADING);
  if (checklistIdx === -1) {
    // No checklist heading at all — prepend a minimal one.
    const block = [
      "",
      CHECKLIST_HEADING,
      "",
      "### Unfucking v2",
      desired,
      "",
    ];
    // Insert right before "## Phase completion details" if present, else at EOF.
    const detailsIdx = lines.findIndex((l) => l.trim() === DETAILS_HEADING);
    if (detailsIdx !== -1) {
      lines.splice(detailsIdx, 0, ...block);
    } else {
      lines.push(...block);
    }
    return lines.join("\n");
  }

  // Find an existing "### Unfucking v2" subhead after the checklist, before the next "## ".
  let subheadIdx = -1;
  for (let i = checklistIdx + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) break;
    if (lines[i].trim() === "### Unfucking v2") {
      subheadIdx = i;
      break;
    }
  }

  if (subheadIdx !== -1) {
    // Insert under this subhead — after the last existing `- [ ]` line that
    // follows the subhead (stop at blank line or next heading).
    let insertAt = subheadIdx + 1;
    for (let i = subheadIdx + 1; i < lines.length; i++) {
      if (/^-\s/.test(lines[i])) insertAt = i + 1;
      else if (/^##?\s/.test(lines[i])) break;
      else if (lines[i].trim() === "" && i > insertAt) break;
    }
    lines.splice(insertAt, 0, desired);
    return lines.join("\n");
  }

  // Create "### Unfucking v2" right before "## Phase completion details".
  const detailsIdx = lines.findIndex((l) => l.trim() === DETAILS_HEADING);
  const insertBefore = detailsIdx === -1 ? lines.length : detailsIdx;
  const block = ["### Unfucking v2", desired, ""];
  lines.splice(insertBefore, 0, ...block);
  return lines.join("\n");
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
