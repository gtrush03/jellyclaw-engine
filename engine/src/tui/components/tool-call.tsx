/**
 * Bordered tool-call card.
 *
 * Renders a single `ToolCallMessage` with header (tool name + status glyph),
 * stringified input body, optional output / error rows, and a duration footer.
 * Long values truncate to 400 chars to prevent transcript blowup.
 *
 * Frame colour is the per-session `tool` accent (typically amber, occasionally
 * blush). Status glyphs use the semantic palette: cyan pending, green ok, red
 * error.
 */

import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import type { ToolCallMessage } from "../state/types.js";
import { brand } from "../theme/brand.js";

const MAX_LEN = 400;

export interface ToolCallProps {
  message: ToolCallMessage;
  /** Per-session accent; defaults to amber. */
  accentColor?: string;
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

export function ToolCall(props: ToolCallProps): JSX.Element {
  const { message } = props;
  const accent = props.accentColor ?? brand.amberEye;
  const inputBody = truncate(stringify(message.input));

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={accent} paddingX={1} marginY={0}>
      <Box>
        <Text bold color={accent}>
          {"\u25C7 tool: "}
        </Text>
        <Text bold color={brand.foam}>
          {message.toolName}
        </Text>
        <Text> </Text>
        {message.status === "pending" ? (
          <Text color={brand.jellyCyan}>
            <Spinner type="dots" />
          </Text>
        ) : message.status === "ok" ? (
          <Text color={brand.success}>{"\u2713"}</Text>
        ) : (
          <Text color={brand.error}>{"\u2717"}</Text>
        )}
      </Box>
      <Text color={brand.foam}>{inputBody}</Text>
      {message.output !== undefined ? (
        <Text color={brand.tidewater}>{`\u2192 ${truncate(stringify(message.output))}`}</Text>
      ) : null}
      {message.errorCode !== undefined || message.errorMessage !== undefined ? (
        <Text color={brand.error}>{`\u2192 ${message.errorCode ?? "error"}: ${message.errorMessage ?? ""}`}</Text>
      ) : null}
      {message.durationMs !== undefined ? (
        <Text color={brand.tidewaterDim}>{`\u2014 ${message.durationMs}ms`}</Text>
      ) : null}
    </Box>
  );
}
