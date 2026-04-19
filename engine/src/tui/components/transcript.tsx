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
import { unifiedDiff } from "../lib/diff.js";
import type { ToolCallMessage, TranscriptItem, UiStatus } from "../state/types.js";
import { brand, GRADIENT_JELLY, gradient, pickRowAccents } from "../theme/brand.js";
import { density } from "../theme/density.js";
import { typography } from "../theme/typography.js";
import { DiffView } from "./diff-view.js";
import { Markdown } from "./markdown.js";
import { Thinking } from "./thinking.js";
import { ToolCall } from "./tool-call.js";

export interface TranscriptProps {
  items: readonly TranscriptItem[];
  /**
   * Max visible rows (layout height). Excess rows crop from the top — older
   * rows are not re-rendered so they stay in the terminal's native scroll-back
   * buffer (akin to a `useMaxHeight()` render budget).
   */
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
    // Route Edit/Write/NotebookEdit through DiffView
    const diffView = tryRenderDiffView(item, props.toolColor);
    if (diffView !== null) {
      return <Box marginTop={density.gap.md}>{diffView}</Box>;
    }

    return (
      <Box marginTop={density.gap.md}>
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
      <Box marginTop={density.gap.md}>
        <Text color={brand.error}>{"\u2502 "}</Text>
        <Text bold color={brand.error}>
          {`\u2717 ${item.code}`}
        </Text>
        <Text color={brand.tidewater}>{" \u00B7 "}</Text>
        <Text wrap="wrap" color={brand.foam}>
          {item.message}
        </Text>
      </Box>
    );
  }

  if (item.role === "system") {
    return (
      <Box marginTop={density.gap.md}>
        <Text
          color={brand.tidewaterDim}
          italic={typography.emphasis.italic ?? true}
          dimColor={typography.caption.dim}
          wrap="wrap"
        >
          {"\u00B7 "}
          {item.text}
        </Text>
      </Box>
    );
  }

  if (item.role === "user") {
    // Row layout: <accent-bar> <role-prefix> <content> with density.md spacing.
    return (
      <Box flexDirection="column" marginTop={density.gap.md}>
        <Box>
          <Text color={props.userColor} bold>
            {"\u2502 "}
          </Text>
          <Text color={brand.tidewaterDim}>{"you \u203A "}</Text>
          <Text wrap="wrap" color={brand.foam}>
            {item.text}
          </Text>
        </Box>
      </Box>
    );
  }

  // assistant — routes body through Markdown renderer for rich formatting
  const isStreamingThisRow = props.isLast && props.status === "streaming" && item.done === false;
  return (
    <Box flexDirection="column" marginTop={density.gap.md}>
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
        <Box marginLeft={density.padX.md}>
          <Markdown source={item.text} accentColor={props.assistantColor} />
        </Box>
      ) : null}
      {isStreamingThisRow && item.text.length > 0 ? (
        <Box marginLeft={density.padX.md}>
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

// ---------------------------------------------------------------------------
// Diff view routing for Edit/Write/NotebookEdit
// ---------------------------------------------------------------------------

const DIFF_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);

/**
 * Try to render a tool call as a DiffView. Returns null if:
 * - The tool is not Edit/Write/NotebookEdit
 * - The input cannot be parsed for diff computation
 */
function tryRenderDiffView(item: ToolCallMessage, borderColor: string): JSX.Element | null {
  if (!DIFF_TOOLS.has(item.toolName)) {
    return null;
  }

  try {
    const input = item.input as Record<string, unknown>;
    let oldText = "";
    let newText = "";
    let filePath: string | undefined;

    if (item.toolName === "Edit") {
      // Edit has old_string and new_string
      oldText = typeof input.old_string === "string" ? input.old_string : "";
      newText = typeof input.new_string === "string" ? input.new_string : "";
      filePath = typeof input.file_path === "string" ? input.file_path : undefined;
    } else if (item.toolName === "Write") {
      // Write has file_path and content; old is always empty (new file or overwrite)
      oldText = "";
      newText = typeof input.content === "string" ? input.content : "";
      filePath = typeof input.file_path === "string" ? input.file_path : undefined;
    } else if (item.toolName === "NotebookEdit") {
      // NotebookEdit has old_source and new_source
      oldText = typeof input.old_source === "string" ? input.old_source : "";
      newText = typeof input.new_source === "string" ? input.new_source : "";
      filePath = typeof input.notebook_path === "string" ? input.notebook_path : undefined;
    }

    const diff = unifiedDiff(oldText, newText);
    return (
      <DiffView
        diff={diff}
        borderColor={borderColor}
        {...(filePath !== undefined ? { filePath } : {})}
      />
    );
  } catch {
    // Fall back to regular ToolCall on parse error
    return null;
  }
}
