/**
 * Phase 99-06 — bordered tool-call card.
 *
 * Renders a single `ToolCallMessage` with header (tool name + status glyph),
 * stringified input body, optional output / error rows, and a duration footer.
 * Long values truncate to 400 chars to prevent transcript blowup.
 */

import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import type { ToolCallMessage } from "../state/types.js";

const MAX_LEN = 400;

export interface ToolCallProps {
  message: ToolCallMessage;
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
  const inputBody = truncate(stringify(message.input));

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="#5A6B8C" paddingX={1} marginY={0}>
      <Box>
        <Text bold>tool: {message.toolName}</Text>
        <Text> </Text>
        {message.status === "pending" ? (
          <Text color="#3BA7FF">
            <Spinner type="dots" />
          </Text>
        ) : message.status === "ok" ? (
          <Text color="green">{"\u2713"}</Text>
        ) : (
          <Text color="red">{"\u2717"}</Text>
        )}
      </Box>
      <Text>{inputBody}</Text>
      {message.output !== undefined ? (
        <Text color="#5A6B8C">{`\u2192 ${truncate(stringify(message.output))}`}</Text>
      ) : null}
      {message.errorCode !== undefined || message.errorMessage !== undefined ? (
        <Text color="red">{`\u2192 ${message.errorCode ?? "error"}: ${message.errorMessage ?? ""}`}</Text>
      ) : null}
      {message.durationMs !== undefined ? (
        <Text color="#5A6B8C">{`\u2014 ${message.durationMs}ms`}</Text>
      ) : null}
    </Box>
  );
}
