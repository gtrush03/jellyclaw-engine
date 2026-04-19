/**
 * Bordered tool-call card (T1-03 polish).
 *
 * Renders a single `ToolCallMessage` with a banner, a 2-line JSON arg summary,
 * an optionally-collapsed output block, and a duration footer. Long output
 * snaps to its first 10 lines (per spec) with a soft
 * `… (N more lines) [?] show more` hint so bash-noisy sessions stay readable.
 *
 * Banner: `[tool] <tool-name> … <spinner|✔|✖>` on one line.
 *
 * Status glyph + colour:
 *   - pending → `amberEye` + rotating quarter spinner (via <ToolSpinner />)
 *   - ok      → `success` green `✓`
 *   - error   → `error` red `✗`
 *
 * Frame colour is the per-session `tool` accent (typically amber, occasionally
 * blush). Press `?` over a tool-call row to expand/collapse detailed output
 * (keymap bound via `useInput`).
 */

import { Box, Text, useInput } from "ink";
import { useState } from "react";
import type { ToolCallMessage } from "../state/types.js";
import { borders } from "../theme/borders.js";
import { brand } from "../theme/brand.js";
import { density } from "../theme/density.js";
import { typography } from "../theme/typography.js";
import { ToolSpinner } from "./tool-spinner.js";

/** Max chars for stringified input/output before truncation. */
const MAX_LEN = 600;
/** Collapse output to first N lines (per spec: ≤ 10 lines). */
const COLLAPSE_LINES = 10;
/** Summary lines for collapsed JSON args. */
const ARGS_SUMMARY_LINES = 2;

export interface ToolCallProps {
  message: ToolCallMessage;
  /** Per-session accent; defaults to amber. */
  accentColor?: string;
  reducedMotion?: boolean;
  /** If true, attach `useInput` for `?` expand/collapse. Off in tests. */
  interactive?: boolean;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncate(s: string, max = MAX_LEN): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}\u2026`;
}

function collapseLines(
  s: string,
  max = COLLAPSE_LINES,
): {
  readonly body: string;
  readonly extra: number;
} {
  const lines = s.split("\n");
  if (lines.length <= max) return { body: s, extra: 0 };
  return { body: lines.slice(0, max).join("\n"), extra: lines.length - max };
}

/** Summarize JSON args to first N lines for collapsed view. */
function summarizeArgs(value: unknown, maxLines = ARGS_SUMMARY_LINES): string {
  const full = truncate(stringify(value));
  const collapsed = collapseLines(full, maxLines);
  if (collapsed.extra > 0) {
    return `${collapsed.body}\u2026`;
  }
  return collapsed.body;
}

/** Status colour — running/ok/error → amber/success/error. */
function statusColor(status: ToolCallMessage["status"]): string {
  if (status === "ok") return brand.success;
  if (status === "error") return brand.error;
  return brand.amberEye;
}

export function ToolCall(props: ToolCallProps): JSX.Element {
  const { message } = props;
  const accent = props.accentColor ?? brand.amberEye;
  const [expanded, setExpanded] = useState(false);

  const interactive = props.interactive === true;
  useInput(
    (input) => {
      if (input === "?") {
        setExpanded((prev) => !prev);
      }
    },
    { isActive: interactive },
  );

  // Summarize args (JSON, 2-line summary per spec). When expanded, show full.
  const fullArgs = truncate(stringify(message.input));
  const inputBody = expanded ? fullArgs : summarizeArgs(message.input, ARGS_SUMMARY_LINES);

  const statusTint = statusColor(message.status);

  return (
    <Box
      flexDirection="column"
      borderStyle={borders.round.style}
      borderColor={accent}
      paddingX={density.padX.sm}
      marginY={density.gap.xs}
    >
      {/* Banner: [tool] <tool-name> … <spinner|✔|✖> */}
      <Box>
        <Text bold color={accent}>
          {"[tool] "}
        </Text>
        <Text bold color={brand.foam}>
          {message.toolName}
        </Text>
        <Text color={brand.tidewaterDim}>{" \u2026 "}</Text>
        {message.status === "pending" ? (
          <ToolSpinner color={statusTint} reducedMotion={props.reducedMotion === true} />
        ) : message.status === "ok" ? (
          <Text color={statusTint} bold>
            {"\u2713"}
          </Text>
        ) : (
          <Text color={statusTint} bold>
            {"\u2717"}
          </Text>
        )}
        {message.durationMs !== undefined ? (
          <>
            <Text color={brand.tidewaterDim}>{"  \u00B7  "}</Text>
            <Text color={brand.foamDark} dimColor={typography.caption.dim}>
              {`${message.durationMs}ms`}
            </Text>
          </>
        ) : null}
      </Box>
      {/* Args summary (2-line JSON summary; full on expand) */}
      <Text color={brand.tidewater}>{inputBody}</Text>
      {/* Output (truncated to ≤ COLLAPSE_LINES; hint to expand when collapsed) */}
      {message.output !== undefined
        ? (() => {
            const full = truncate(stringify(message.output));
            const collapsed = collapseLines(full);
            const lines = expanded ? full.split("\n") : collapsed.body.split("\n");
            const extra = expanded ? 0 : collapsed.extra;
            return (
              <Box flexDirection="column">
                {lines.map((line, idx) => (
                  <Text key={`out-${idx}-${line.slice(0, 24)}`} color={brand.foam}>
                    {idx === 0 ? "\u2192 " : "  "}
                    {line}
                  </Text>
                ))}
                {extra > 0 ? (
                  <Text color={brand.tidewaterDim} italic dimColor={typography.caption.dim}>
                    {`  \u2026 (${extra} more line${extra === 1 ? "" : "s"}) [?] show more`}
                  </Text>
                ) : null}
              </Box>
            );
          })()
        : null}
      {/* Error display */}
      {message.errorCode !== undefined || message.errorMessage !== undefined ? (
        <Text color={brand.error}>
          {`\u2192 ${message.errorCode ?? "error"}: ${message.errorMessage ?? ""}`}
        </Text>
      ) : null}
    </Box>
  );
}
