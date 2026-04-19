/**
 * Markdown renderer for assistant messages (T1-03 polish).
 *
 * A hand-rolled, dependency-free subset parser (~250 lines). Given a raw
 * markdown string, produces a tree of Ink `<Text>` / `<Box>` nodes. Targets
 * the 90% of realistic assistant output:
 *
 * Block-level:
 *   - ATX headings `# H1` / `## H2` / `### H3`        (gradient/bold + underline)
 *   - fenced code blocks ```lang\n...\n```            (bordered box + lang tag)
 *   - bullet lists `- x` / `* x`                      (◦ glyph, 2-space indent)
 *   - numbered lists `1. x`                           (padded numbers)
 *   - block quotes `> x`                              (left rule + dim italic)
 *   - horizontal rule `---` / `***` / `___`           (gradient line)
 *
 * Inline:
 *   - bold `**x**` / `__x__`, italic `*x*` / `_x_`, strike `~~x~~`
 *   - inline code `` `x` ``                           (amber on panel bg)
 *   - links `[text](url)`                             (underline cyan + dim url)
 *
 * Not supported (trade-offs for footprint):
 *   - nested lists (flat only — indent is ignored)
 *   - tables (fallback to raw)
 *   - reference-style links / images
 *   - HTML passthrough
 *
 * Streaming safety:
 *   - Partially-written fenced block (opening ``` seen, close not yet arrived)
 *     renders as a pending block with amber border so the user sees code in a
 *     frame as it streams.
 *   - Incomplete inline spans (`**bold without close`) degrade to plain text.
 *   - The parser never throws on malformed input — worst case is raw passthrough.
 */

import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { borders } from "../theme/borders.js";
import { brand, GRADIENT_BELL, GRADIENT_JELLY, gradient } from "../theme/brand.js";
import { density } from "../theme/density.js";
import { typography } from "../theme/typography.js";

export interface MarkdownProps {
  /** Raw markdown source to render. */
  readonly source: string;
  /** Assistant accent colour — used for headings, list glyphs, quotes. */
  readonly accentColor: string;
}

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------

type Block =
  | { readonly kind: "heading"; readonly level: 1 | 2 | 3; readonly text: string }
  | { readonly kind: "paragraph"; readonly text: string }
  | {
      readonly kind: "code";
      readonly lang: string;
      readonly body: string;
      readonly closed: boolean;
    }
  | { readonly kind: "rule" }
  | { readonly kind: "quote"; readonly text: string }
  | { readonly kind: "ulist"; readonly items: readonly string[] }
  | { readonly kind: "olist"; readonly items: readonly string[] };

function parseBlocks(source: string): readonly Block[] {
  const lines = source.split("\n");
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    // Fenced code block
    const fence = /^```(\s*)([A-Za-z0-9_+-]*)\s*$/.exec(line);
    if (fence !== null) {
      const lang = fence[2] ?? "";
      const bodyLines: string[] = [];
      i += 1;
      let closed = false;
      while (i < lines.length) {
        const l = lines[i] ?? "";
        if (/^```\s*$/.test(l)) {
          closed = true;
          i += 1;
          break;
        }
        bodyLines.push(l);
        i += 1;
      }
      out.push({ kind: "code", lang, body: bodyLines.join("\n"), closed });
      continue;
    }
    // Horizontal rule
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      out.push({ kind: "rule" });
      i += 1;
      continue;
    }
    // ATX heading
    const h = /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h !== null) {
      const level = (h[1] ?? "#").length as 1 | 2 | 3;
      out.push({ kind: "heading", level, text: h[2] ?? "" });
      i += 1;
      continue;
    }
    // Blank line
    if (line.trim().length === 0) {
      i += 1;
      continue;
    }
    // Blockquote (consume contiguous `>` lines)
    if (/^\s*>\s?/.test(line)) {
      const parts: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i] ?? "")) {
        parts.push((lines[i] ?? "").replace(/^\s*>\s?/, ""));
        i += 1;
      }
      out.push({ kind: "quote", text: parts.join("\n") });
      continue;
    }
    // Bullet list
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i] ?? "")) {
        items.push((lines[i] ?? "").replace(/^\s*[-*+]\s+/, ""));
        i += 1;
      }
      out.push({ kind: "ulist", items });
      continue;
    }
    // Numbered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i] ?? "")) {
        items.push((lines[i] ?? "").replace(/^\s*\d+\.\s+/, ""));
        i += 1;
      }
      out.push({ kind: "olist", items });
      continue;
    }
    // Paragraph (consume until blank or block-starting line)
    const paraLines: string[] = [line];
    i += 1;
    while (i < lines.length) {
      const next = lines[i] ?? "";
      if (
        next.trim().length === 0 ||
        /^```/.test(next) ||
        /^#{1,3}\s+/.test(next) ||
        /^\s*([-*_])\1{2,}\s*$/.test(next) ||
        /^\s*>\s?/.test(next) ||
        /^\s*[-*+]\s+/.test(next) ||
        /^\s*\d+\.\s+/.test(next)
      ) {
        break;
      }
      paraLines.push(next);
      i += 1;
    }
    out.push({ kind: "paragraph", text: paraLines.join("\n") });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Inline parsing
// ---------------------------------------------------------------------------

function renderInline(source: string, baseColor: string, keyPrefix: string): ReactNode[] {
  // Tokenize into segments. We process in one pass with alternation regex.
  // Order matters: code first (so ** inside `code` isn't expanded), then
  // links, then bold, italic, strike.
  const nodes: ReactNode[] = [];
  let idx = 0;
  let rest = source;
  // Pattern: matches either inline code, link, bold, italic-underscore,
  // italic-asterisk, or strike. Greedy-but-safe: non-greedy interiors.
  const pattern =
    /(`+)([^`]+?)\1|\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+?)\*\*|__([^_]+?)__|\*([^*\s][^*]*?)\*|_([^_\s][^_]*?)_|~~([^~]+?)~~/;
  while (rest.length > 0) {
    const m = pattern.exec(rest);
    if (m === null) {
      if (rest.length > 0) {
        nodes.push(
          <Text key={`${keyPrefix}-t${idx}`} color={baseColor}>
            {rest}
          </Text>,
        );
        idx += 1;
      }
      break;
    }
    const matchStart = m.index;
    if (matchStart > 0) {
      nodes.push(
        <Text key={`${keyPrefix}-t${idx}`} color={baseColor}>
          {rest.slice(0, matchStart)}
        </Text>,
      );
      idx += 1;
    }
    // Dispatch on which group matched
    if (m[1] !== undefined && m[2] !== undefined) {
      // inline code — mono weight + diffAdd background per brief.
      nodes.push(
        <Text
          key={`${keyPrefix}-c${idx}`}
          color={brand.foam}
          backgroundColor={brand.diffAdd}
          bold={typography.mono.bold}
        >
          {` ${m[2]} `}
        </Text>,
      );
      idx += 1;
    } else if (m[3] !== undefined && m[4] !== undefined) {
      // link — underlined foam per brief; url preview stays dim.
      const label = m[3];
      const url = m[4];
      nodes.push(
        <Text key={`${keyPrefix}-l${idx}`}>
          <Text color={brand.foam} underline>
            {label}
          </Text>
          <Text color={brand.tidewaterDim}>{` (${url})`}</Text>
        </Text>,
      );
      idx += 1;
    } else if (m[5] !== undefined || m[6] !== undefined) {
      const inner = m[5] ?? m[6] ?? "";
      nodes.push(
        <Text key={`${keyPrefix}-b${idx}`} color={baseColor} bold>
          {inner}
        </Text>,
      );
      idx += 1;
    } else if (m[7] !== undefined || m[8] !== undefined) {
      const inner = m[7] ?? m[8] ?? "";
      nodes.push(
        <Text key={`${keyPrefix}-i${idx}`} color={baseColor} italic>
          {inner}
        </Text>,
      );
      idx += 1;
    } else if (m[9] !== undefined) {
      nodes.push(
        <Text key={`${keyPrefix}-s${idx}`} color={brand.tidewater} strikethrough>
          {m[9]}
        </Text>,
      );
      idx += 1;
    }
    rest = rest.slice(matchStart + m[0].length);
  }
  return nodes;
}

// ---------------------------------------------------------------------------
// Block renderers
// ---------------------------------------------------------------------------

function renderHeading(
  level: 1 | 2 | 3,
  text: string,
  accentColor: string,
  key: string,
): ReactNode {
  if (level === 1) {
    return (
      <Box key={key} flexDirection="column" marginTop={1}>
        <Text bold>{gradient(text, GRADIENT_JELLY)}</Text>
        <Text color={brand.tidewaterDim}>
          {gradient("\u2500".repeat(Math.min(40, text.length + 4)), GRADIENT_BELL)}
        </Text>
      </Box>
    );
  }
  if (level === 2) {
    return (
      <Box key={key} flexDirection="column" marginTop={1}>
        <Text bold color={accentColor}>
          {text}
        </Text>
        <Text color={brand.tidewaterDim}>{"\u2500".repeat(Math.min(32, text.length + 2))}</Text>
      </Box>
    );
  }
  // H3
  return (
    <Box key={key} marginTop={1}>
      <Text bold color={accentColor}>
        {"\u25B8 "}
      </Text>
      <Text bold color={brand.foam}>
        {text}
      </Text>
    </Box>
  );
}

function renderCode(lang: string, body: string, closed: boolean, key: string): ReactNode {
  // Pending (unclosed) blocks get amber border to indicate streaming
  const borderColor = closed ? brand.tidewaterDim : brand.amberEye;
  return (
    <Box
      key={key}
      flexDirection="column"
      borderStyle={borders.round.style}
      borderColor={borderColor}
      paddingX={density.padX.sm}
      marginY={density.gap.xs}
    >
      {lang.length > 0 ? (
        <Text color={brand.amberEye} bold>
          {`\u25C6 ${lang}${closed ? "" : " \u2026"}`}
        </Text>
      ) : null}
      {body.split("\n").map((line, idx) => (
        <Text key={`${key}-l${idx}`} color={brand.foam}>
          {line.length === 0 ? " " : line}
        </Text>
      ))}
    </Box>
  );
}

function renderQuote(text: string, key: string): ReactNode {
  return (
    <Box key={key} marginY={density.gap.xs}>
      <Text color={brand.medusaViolet}>{"\u2502 "}</Text>
      <Box flexDirection="column">
        {text.split("\n").map((line, idx) => (
          <Text key={`${key}-q${idx}`} color={brand.tidewater} italic>
            {line}
          </Text>
        ))}
      </Box>
    </Box>
  );
}

function renderRule(key: string): ReactNode {
  return (
    <Box key={key} marginY={density.gap.xs}>
      <Text>{gradient("\u2500".repeat(48), GRADIENT_JELLY)}</Text>
    </Box>
  );
}

function renderUList(
  items: readonly string[],
  accentColor: string,
  baseColor: string,
  key: string,
): ReactNode {
  return (
    <Box key={key} flexDirection="column">
      {items.map((item, idx) => (
        <Box key={`${key}-i${idx}`}>
          <Text color={accentColor}>{"  \u2022 "}</Text>
          <Text>{renderInline(item, baseColor, `${key}-i${idx}`)}</Text>
        </Box>
      ))}
    </Box>
  );
}

function renderOList(
  items: readonly string[],
  accentColor: string,
  baseColor: string,
  key: string,
): ReactNode {
  const width = String(items.length).length;
  return (
    <Box key={key} flexDirection="column">
      {items.map((item, idx) => (
        <Box key={`${key}-i${idx}`}>
          <Text color={accentColor} bold>
            {`  ${String(idx + 1).padStart(width, " ")}. `}
          </Text>
          <Text>{renderInline(item, baseColor, `${key}-i${idx}`)}</Text>
        </Box>
      ))}
    </Box>
  );
}

function renderParagraph(text: string, baseColor: string, key: string): ReactNode {
  // Paragraphs keep newlines inside — render each line as its own Text so Ink
  // wraps them independently and internal `\n` are preserved.
  const lines = text.split("\n");
  return (
    <Box key={key} flexDirection="column">
      {lines.map((line, idx) => (
        <Text key={`${key}-p${idx}`}>{renderInline(line, baseColor, `${key}-p${idx}`)}</Text>
      ))}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Top-level renderer
// ---------------------------------------------------------------------------

export function Markdown(props: MarkdownProps): JSX.Element {
  const blocks = parseBlocks(props.source);
  const nodes: ReactNode[] = [];
  for (let i = 0; i < blocks.length; i += 1) {
    const b = blocks[i] as Block;
    const key = `md-${i}`;
    switch (b.kind) {
      case "heading":
        nodes.push(renderHeading(b.level, b.text, props.accentColor, key));
        break;
      case "code":
        nodes.push(renderCode(b.lang, b.body, b.closed, key));
        break;
      case "rule":
        nodes.push(renderRule(key));
        break;
      case "quote":
        nodes.push(renderQuote(b.text, key));
        break;
      case "ulist":
        nodes.push(renderUList(b.items, props.accentColor, brand.foam, key));
        break;
      case "olist":
        nodes.push(renderOList(b.items, props.accentColor, brand.foam, key));
        break;
      case "paragraph":
        nodes.push(renderParagraph(b.text, brand.foam, key));
        break;
      default:
        break;
    }
  }
  return <Box flexDirection="column">{nodes}</Box>;
}
