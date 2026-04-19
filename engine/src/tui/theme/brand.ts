/**
 * jellyjelly brand tokens — single source of truth for the Ink TUI skin.
 *
 * Pulls the jellyjelly.com palette (raw/candid, aquatic, playful jellyfish
 * motif) on top of the existing deep-sea foundation from the TUI brand brief:
 *
 *   - Jelly Cyan   `#3BA7FF` — bell/dome, primary focus, user accent
 *   - Medusa Violet `#9E7BFF` — tentacle glow, assistant accent
 *   - Amber Eye    `#FFB547` — heartbeat, warning, tool emphasis
 *   - Blush Pink   `#FF6FB5` — jellyjelly "candid" highlight (rim accent)
 *   - Foam         `#E8ECF5` — primary text on abyss backgrounds
 *   - Abyss        `#0A1020` — main background
 *   - Tidewater    `#5A6B8C` — muted / borderSubtle
 *
 * v2.0 additions (T6-04-DESIGN-BRIEF.md):
 *   - Neutral Bridge `#A8B5CA` — secondary text, disabled states (AA 4.8:1)
 *   - Foam Dark     `#D1D5E1` — metadata, timestamps (AAA 7.2:1)
 *   - Abyss Light   `#161E3A` — nested panels, modal overlays
 *
 * Per-session variance: hashing the session id picks one of 4 preset accent
 * rotations so each session looks visually distinct without straying from the
 * palette. The variant only rotates the *row-accent* trio (user / assistant /
 * tool); the base palette (bg, text, borders) is stable across sessions.
 *
 * All tokens are plain hex strings — Ink's `<Text color=>` prop accepts any
 * 6-digit hex. No runtime deps.
 */

/** Palette version — bump minor for additive changes, major for breaking. */
export const PALETTE_VERSION = "2.0.0";

export interface BrandPalette {
  readonly jellyCyan: string;
  readonly medusaViolet: string;
  readonly amberEye: string;
  readonly blushPink: string;
  readonly foam: string;
  /** Secondary text for metadata, timestamps — AAA 7.2:1 against abyss. */
  readonly foamDark: string;
  readonly abyss: string;
  /** Nested panels, modal overlays — second surface tier. */
  readonly abyssLight: string;
  readonly panel: string;
  readonly tidewater: string;
  readonly tidewaterDim: string;
  /** Secondary text, disabled states — AA 4.8:1 against abyss. */
  readonly neutralBridge: string;
  readonly success: string;
  readonly error: string;
  /** Diff view: added lines — gold-tinted green. */
  readonly diffAdd: string;
  /** Diff view: deleted lines — muted rust. */
  readonly diffDel: string;
}

export const brand: BrandPalette = {
  jellyCyan: "#3BA7FF",
  medusaViolet: "#9E7BFF",
  amberEye: "#FFB547",
  blushPink: "#FF6FB5",
  foam: "#E8ECF5",
  foamDark: "#D1D5E1",
  abyss: "#0A1020",
  abyssLight: "#161E3A",
  panel: "#0E1830",
  tidewater: "#5A6B8C",
  tidewaterDim: "#3B475F",
  neutralBridge: "#A8B5CA",
  success: "#4ADE80",
  error: "#FF5577",
  diffAdd: "#5A8C66",
  diffDel: "#8C5A5A",
};

/**
 * Row-accent trio — the three colours applied as the user prompt prefix,
 * assistant reply prefix, and tool-call border. Each session rotates one of
 * these, deterministically keyed on the session id.
 */
export interface RowAccents {
  readonly user: string;
  readonly assistant: string;
  readonly tool: string;
  /** Human-readable tag for debugging / tests. */
  readonly name: string;
}

const ROW_ACCENT_VARIANTS: readonly RowAccents[] = [
  // Classic jellyclaw — cyan user, violet assistant, amber tool.
  { name: "classic", user: brand.jellyCyan, assistant: brand.medusaViolet, tool: brand.amberEye },
  // Blush — cyan user, blush assistant, amber tool (jellyjelly signature).
  { name: "blush", user: brand.jellyCyan, assistant: brand.blushPink, tool: brand.amberEye },
  // Dusk — violet user, blush assistant, amber tool.
  { name: "dusk", user: brand.medusaViolet, assistant: brand.blushPink, tool: brand.amberEye },
  // Reef — cyan user, violet assistant, blush tool.
  { name: "reef", user: brand.jellyCyan, assistant: brand.medusaViolet, tool: brand.blushPink },
  // Amber — amber user, cyan assistant, violet tool (rare — warmer session).
  { name: "amber", user: brand.amberEye, assistant: brand.jellyCyan, tool: brand.medusaViolet },
];

export const DEFAULT_ROW_ACCENTS: RowAccents = ROW_ACCENT_VARIANTS[0] as RowAccents;

/**
 * Deterministic hash → variant. djb2-style; good enough for 4-5 buckets and
 * avoids pulling in `node:crypto` on the TUI hot path.
 */
export function pickRowAccents(sessionId: string | null): RowAccents {
  if (sessionId === null || sessionId.length === 0) return DEFAULT_ROW_ACCENTS;
  let h = 5381;
  for (let i = 0; i < sessionId.length; i += 1) {
    h = ((h << 5) + h + sessionId.charCodeAt(i)) | 0;
  }
  const idx = Math.abs(h) % ROW_ACCENT_VARIANTS.length;
  return ROW_ACCENT_VARIANTS[idx] as RowAccents;
}

/**
 * ANSI truecolor gradient helper — paints `text` across a list of hex stops,
 * one character at a time. Returns a string with embedded ANSI escape codes
 * suitable for Ink `<Text>` (Ink passes strings through unchanged).
 *
 * Degrades gracefully: on a 2-stop input this is a linear fade; on a 1-stop
 * input it paints flat. Empty `text` returns empty string.
 */
export function gradient(text: string, stops: readonly string[]): string {
  if (text.length === 0 || stops.length === 0) return text;
  if (stops.length === 1) return `\u001b[38;2;${rgb(stops[0] as string)}m${text}\u001b[39m`;
  const chars = [...text];
  const out: string[] = [];
  for (let i = 0; i < chars.length; i += 1) {
    const t = chars.length === 1 ? 0 : i / (chars.length - 1);
    const hex = interpolateStops(stops, t);
    out.push(`\u001b[38;2;${rgb(hex)}m${chars[i] as string}`);
  }
  out.push("\u001b[39m");
  return out.join("");
}

function rgb(hex: string): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `${r};${g};${b}`;
}

function interpolateStops(stops: readonly string[], t: number): string {
  if (stops.length === 1) return stops[0] as string;
  const clamped = Math.max(0, Math.min(1, t));
  const segment = clamped * (stops.length - 1);
  const i = Math.min(Math.floor(segment), stops.length - 2);
  const local = segment - i;
  return lerpHex(stops[i] as string, stops[i + 1] as string, local);
}

function lerpHex(a: string, b: string, t: number): string {
  const ah = a.replace("#", "");
  const bh = b.replace("#", "");
  const ar = parseInt(ah.slice(0, 2), 16);
  const ag = parseInt(ah.slice(2, 4), 16);
  const ab = parseInt(ah.slice(4, 6), 16);
  const br = parseInt(bh.slice(0, 2), 16);
  const bg = parseInt(bh.slice(2, 4), 16);
  const bb = parseInt(bh.slice(4, 6), 16);
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return `#${hex2(r)}${hex2(g)}${hex2(bl)}`;
}

function hex2(n: number): string {
  return n.toString(16).padStart(2, "0");
}

/**
 * Preset gradient: cyan → violet → blush pink. Used for the JELLYCLAW splash
 * wordmark and the assistant prefix glow.
 */
export const GRADIENT_JELLY = [brand.jellyCyan, brand.medusaViolet, brand.blushPink] as const;

/** Cyan → violet only. Status bar accent strip. */
export const GRADIENT_BELL = [brand.jellyCyan, brand.medusaViolet] as const;

/** Amber → blush. Tool-call frame emphasis. */
export const GRADIENT_HEAT = [brand.amberEye, brand.blushPink] as const;
