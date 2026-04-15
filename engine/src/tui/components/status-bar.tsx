/**
 * Phase 99-06 — top status bar.
 *
 * Displays brand glyph, app name, model, short session id, token total, and a
 * status-aware glyph (idle dot, streaming jellyfish spinner, awaiting-permission
 * bang, error cross).
 */

import { Box, Text } from "ink";
import type { UiStatus, UiUsage } from "../state/types.js";
import { Jellyfish } from "./jellyfish.js";

export interface StatusBarProps {
  sessionId: string | null;
  model: string;
  usage: UiUsage;
  status: UiStatus;
  /** Monotonic tick from state — drives spinner frame selection. */
  tick: number;
  reducedMotion: boolean;
}

function formatTokens(usage: UiUsage): string {
  const total = usage.inputTokens + usage.outputTokens;
  if (total >= 1000) {
    const k = Math.round(total / 100) / 10;
    return `${k}k tok`;
  }
  return `${total} tok`;
}

function shortSession(id: string | null): string {
  if (id === null) return "\u2014";
  return id.slice(0, 8);
}

export function StatusBar(props: StatusBarProps): JSX.Element {
  const sep = <Text color="#5A6B8C"> {"\u00B7"} </Text>;
  return (
    <Box
      borderStyle="single"
      borderTop={false}
      borderLeft={false}
      borderRight={false}
      borderColor="#5A6B8C"
      paddingX={1}
    >
      <Text color="#3BA7FF">{"\u25C8 "}</Text>
      <Text>jellyclaw</Text>
      {sep}
      <Text>{props.model}</Text>
      {sep}
      <Text>{shortSession(props.sessionId)}</Text>
      {sep}
      <Text>{formatTokens(props.usage)}</Text>
      {sep}
      <StatusGlyph status={props.status} tick={props.tick} reducedMotion={props.reducedMotion} />
    </Box>
  );
}

interface GlyphProps {
  status: UiStatus;
  tick: number;
  reducedMotion: boolean;
}

function StatusGlyph(props: GlyphProps): JSX.Element {
  switch (props.status) {
    case "streaming":
      return <Jellyfish size="compact" tick={props.tick} reducedMotion={props.reducedMotion} />;
    case "awaiting-permission":
      return <Text color="#FFB547">!</Text>;
    case "error":
      return <Text color="red">{"\u2717"}</Text>;
    default:
      return <Text color="#5A6B8C">{"\u00B7"}</Text>;
  }
}
