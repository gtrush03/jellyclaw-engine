/**
 * Phase 99-06 — scrolling transcript pane.
 *
 * Renders `TranscriptItem[]` top-to-bottom. Crops from the top using a shallow
 * heuristic (slice last `rows` items) — Phase 99-06 does not need pixel-precise
 * row math; that responsibility falls to the layout owner (Agent D) once
 * Dockview-style measurement lands.
 */

import { Box, Text } from "ink";
import type { TranscriptItem } from "../state/types.js";
import { ToolCall } from "./tool-call.js";

export interface TranscriptProps {
  items: readonly TranscriptItem[];
  /** Max visible lines (layout height). Excess rows crop from the top. */
  rows: number;
}

export function Transcript(props: TranscriptProps): JSX.Element {
  const slice = sliceForRows(props.items, props.rows);
  return (
    <Box flexDirection="column">
      {slice.map((item) => (
        <TranscriptRow key={item.id} item={item} />
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
}

function TranscriptRow(props: RowProps): JSX.Element {
  const { item } = props;
  if (item.kind === "tool") return <ToolCall message={item} />;
  if (item.kind === "error") {
    return (
      <Text>
        <Text color="red">{`\u2717 ${item.code}: `}</Text>
        {item.message}
      </Text>
    );
  }
  if (item.role === "user") {
    return (
      <Text>
        <Text color="cyan">{"user \u203A "}</Text>
        {item.text}
      </Text>
    );
  }
  if (item.role === "assistant") {
    return (
      <Text>
        <Text color="#3BA7FF">{"\u25C8 "}</Text>
        {item.text}
      </Text>
    );
  }
  // system
  return (
    <Text color="#5A6B8C">
      {"\u00B7 "}
      {item.text}
    </Text>
  );
}
