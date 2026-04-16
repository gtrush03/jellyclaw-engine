/**
 * Bordered tool-call card.
 *
 * Renders a single `ToolCallMessage` with header (tool name + status glyph),
 * stringified input body, optional collapsed output / error rows, and a
 * duration footer. Long output snaps to its first 6 lines with a soft
 * `… (N more lines)` tail so bash-noisy sessions stay readable.
 *
 * Status glyph:
 *   - pending → amber `◐◓◑◒` rotating quarter (via <ToolSpinner />)
 *   - ok      → green `✓`
 *   - error   → red `✗`
 *
 * Frame colour is the per-session `tool` accent (typically amber, occasionally
 * blush).
 */

import { Box, Text } from "ink";
import type { ToolCallMessage } from "../state/types.js";
import { brand } from "../theme/brand.js";
import { ToolSpinner } from "./tool-spinner.js";

const MAX_LEN = 600;
const COLLAPSE_LINES = 6;

export interface ToolCallProps {
  message: ToolCallMessage;
  /** Per-session accent; defaults to amber. */
  accentColor?: string;
  reducedMotion?: boolean;
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

function collapseLines(s: string, max = COLLAPSE_LINES): {
  readonly body: string;
  readonly extra: number;
} {
  const lines = s.split("\n");
  if (lines.length <= max) return { body: s, extra: 0 };
  return { body: lines.slice(0, max).join("\n"), extra: lines.length - max };
}

export function ToolCall(props: ToolCallProps): JSX.Element {
  const { message } = props;
  const accent = props.accentColor ?? brand.amberEye;
  const inputBody = truncate(stringify(message.input));

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={accent} paddingX={1} marginY={0}>
      <Box>
        <Text bold color={accent}>
          {"\u25C7 tool "}
        </Text>
        <Text bold color={brand.foam}>
          {message.toolName}
        </Text>
        <Text color={brand.tidewaterDim}>{"  "}</Text>
        {message.status === "pending" ? (
          <ToolSpinner color={brand.amberEye} reducedMotion={props.reducedMotion === true} />
        ) : message.status === "ok" ? (
          <Text color={brand.success} bold>
            {"\u2713"}
          </Text>
        ) : (
          <Text color={brand.error} bold>
            {"\u2717"}
          </Text>
        )}
        {message.durationMs !== undefined ? (
          <>
            <Text color={brand.tidewaterDim}>{"  \u00B7  "}</Text>
            <Text color={brand.tidewaterDim}>{`${message.durationMs}ms`}</Text>
          </>
        ) : null}
      </Box>
      <Text color={brand.tidewater}>{inputBody}</Text>
      {message.output !== undefined ? (() => {
        const full = truncate(stringify(message.output));
        const collapsed = collapseLines(full);
        return (
          <Box flexDirection="column">
            {collapsed.body.split("\n").map((line, idx) => (
              <Text key={`out-${idx}`} color={brand.foam}>
                {idx === 0 ? "\u2192 " : "  "}
                {line}
              </Text>
            ))}
            {collapsed.extra > 0 ? (
              <Text color={brand.tidewaterDim} italic>
                {`  \u2026 (${collapsed.extra} more line${collapsed.extra === 1 ? "" : "s"})`}
              </Text>
            ) : null}
          </Box>
        );
      })() : null}
      {message.errorCode !== undefined || message.errorMessage !== undefined ? (
        <Text color={brand.error}>{`\u2192 ${message.errorCode ?? "error"}: ${message.errorMessage ?? ""}`}</Text>
      ) : null}
    </Box>
  );
}
