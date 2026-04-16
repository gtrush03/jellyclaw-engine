/**
 * Scrolling transcript pane.
 *
 * Premium row layout: each transcript item gets an optional 1-row top margin,
 * a short left-rule glyph in a per-role accent, a small role prefix, and body
 * content that (for assistant messages) is routed through the Markdown
 * renderer so headings / code / lists / quotes / links appear formatted rather
 * than printed as raw syntax.
 *
 *   user       → cyan `│ you ›` rule + plain foam body
 *   assistant  → violet `│ 🪼 jc` rule + markdown body
 *   tool       → amber bordered card (see <ToolCall />)
 *   system     → dim tidewater italic, no prefix rule
 *   error      → red `│ ✗ code` rule + message
 *
 * Accents rotate per-session via `pickRowAccents`, so repeat sessions feel
 * distinct while staying on-palette.
 */

import { Box, Text } from "ink";
import type { TranscriptItem, UiStatus } from "../state/types.js";
import { brand, GRADIENT_JELLY, gradient, pickRowAccents } from "../theme/brand.js";
import { Markdown } from "./markdown.js";
import { Thinking } from "./thinking.js";
import { ToolCall } from "./tool-call.js";

export interface TranscriptProps {
  items: readonly TranscriptItem[];
  /** Max visible lines (layout height). Excess rows crop from the top. */
  rows: number;
  /** Session id threaded in so row accents rotate per-session. */
  sessionId?: string | null;
  /** UI status — drives the in-line thinking indicator. */
  status?: UiStatus;
  /** If true, static frames only. */
  reducedMotion?: boolean;
}

export function Transcript(props: TranscriptProps): JSX.Element {
  const slice = sliceForRows(props.items, props.rows);
  const accents = pickRowAccents(props.sessionId ?? null);
  return (
    <Box flexDirection="column">
      {slice.map((item, idx) => (
        <TranscriptRow
          key={item.id}
          item={item}
          userColor={accents.user}
          assistantColor={accents.assistant}
          toolColor={accents.tool}
          isLast={idx === slice.length - 1}
          status={props.status ?? "idle"}
          reducedMotion={props.reducedMotion === true}
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
  isLast: boolean;
  status: UiStatus;
  reducedMotion: boolean;
}

function TranscriptRow(props: RowProps): JSX.Element {
  const { item } = props;

  if (item.kind === "tool") {
    return (
      <Box marginTop={1}>
        <ToolCall
          message={item}
          accentColor={props.toolColor}
          reducedMotion={props.reducedMotion}
        />
      </Box>
    );
  }

  if (item.kind === "error") {
    return (
      <Box marginTop={1}>
        <Text color={brand.error}>{"\u2502 "}</Text>
        <Text bold color={brand.error}>
          {`\u2717 ${item.code}`}
        </Text>
        <Text color={brand.tidewater}>{" \u00B7 "}</Text>
        <Text color={brand.foam}>{item.message}</Text>
      </Box>
    );
  }

  if (item.role === "system") {
    return (
      <Box marginTop={1}>
        <Text color={brand.tidewaterDim} italic>
          {"\u00B7 "}
          {item.text}
        </Text>
      </Box>
    );
  }

  if (item.role === "user") {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Box>
          <Text color={props.userColor} bold>
            {"\u2502 "}
          </Text>
          <Text color={brand.tidewaterDim}>{"you \u203A "}</Text>
          <Text color={brand.foam}>{item.text}</Text>
        </Box>
      </Box>
    );
  }

  // assistant
  const isStreamingThisRow = props.isLast && props.status === "streaming" && item.done === false;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text color={props.assistantColor} bold>
          {"\u2502 "}
        </Text>
        <Text>{gradient("\u{1FABC} jc", GRADIENT_JELLY)}</Text>
        <Text color={brand.tidewaterDim}>{"  "}</Text>
        {isStreamingThisRow && item.text.length === 0 ? (
          <Thinking accentColor={props.assistantColor} reducedMotion={props.reducedMotion} />
        ) : null}
      </Box>
      {item.text.length > 0 ? (
        <Box marginLeft={2}>
          <Markdown source={item.text} accentColor={props.assistantColor} />
        </Box>
      ) : null}
      {isStreamingThisRow && item.text.length > 0 ? (
        <Box marginLeft={2}>
          <Thinking
            accentColor={props.assistantColor}
            reducedMotion={props.reducedMotion}
            showLabel={false}
          />
        </Box>
      ) : null}
    </Box>
  );
}
