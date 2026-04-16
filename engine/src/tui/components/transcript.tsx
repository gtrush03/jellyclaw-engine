/**
 * Scrolling transcript pane.
 *
 * Renders `TranscriptItem[]` top-to-bottom with per-role accent treatment:
 *   - user       → cyan `user ›` prefix
 *   - assistant  → gradient diamond glyph (cyan→violet→blush) + foam body
 *   - system     → dim tidewater middle-dot
 *   - error      → red cross with code
 *
 * Accents rotate per-session via `pickRowAccents`, so repeat sessions feel
 * distinct while staying on-palette.
 */

import { Box, Text } from "ink";
import type { TranscriptItem } from "../state/types.js";
import { brand, GRADIENT_JELLY, gradient, pickRowAccents } from "../theme/brand.js";
import { ToolCall } from "./tool-call.js";

export interface TranscriptProps {
  items: readonly TranscriptItem[];
  /** Max visible lines (layout height). Excess rows crop from the top. */
  rows: number;
  /** Session id threaded in so row accents rotate per-session. */
  sessionId?: string | null;
}

export function Transcript(props: TranscriptProps): JSX.Element {
  const slice = sliceForRows(props.items, props.rows);
  const accents = pickRowAccents(props.sessionId ?? null);
  return (
    <Box flexDirection="column">
      {slice.map((item) => (
        <TranscriptRow
          key={item.id}
          item={item}
          userColor={accents.user}
          assistantColor={accents.assistant}
          toolColor={accents.tool}
        />
      ))}
    </Box>
  );
}

function sliceForRows(items: readonly TranscriptItem[], rows: number): readonly TranscriptItem[] {
  const max = Math.max(1, rows);
  if (items.length <= max) return items;
  return items.slice(items.length - max);
}

interface RowProps {
  item: TranscriptItem;
  userColor: string;
  assistantColor: string;
  toolColor: string;
}

function TranscriptRow(props: RowProps): JSX.Element {
  const { item } = props;
  if (item.kind === "tool") return <ToolCall message={item} accentColor={props.toolColor} />;
  if (item.kind === "error") {
    return (
      <Text>
        <Text color={brand.error}>{`\u2717 ${item.code}: `}</Text>
        <Text color={brand.foam}>{item.message}</Text>
      </Text>
    );
  }
  if (item.role === "user") {
    return (
      <Text>
        <Text color={props.userColor} bold>
          {"user \u203A "}
        </Text>
        <Text color={brand.foam}>{item.text}</Text>
      </Text>
    );
  }
  if (item.role === "assistant") {
    return (
      <Text>
        <Text>{gradient("\u25C8 ", GRADIENT_JELLY)}</Text>
        <Text color={brand.foam}>{item.text}</Text>
      </Text>
    );
  }
  // system
  return (
    <Text color={brand.tidewater}>
      {"\u00B7 "}
      {item.text}
    </Text>
  );
}
