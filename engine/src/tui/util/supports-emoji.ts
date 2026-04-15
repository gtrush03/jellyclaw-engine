/**
 * Heuristic detection for whether the active terminal can render modern
 * emoji (e.g. the jellyfish glyph 🪼, Unicode 14, 2021).
 *
 * Conservative: we only return `true` for terminals we know render it, and
 * always return `false` for the Linux virtual console which famously tofu's
 * most emoji. Everything else defaults to `true` — modern default.
 *
 * Callers should still honor a user override env var (e.g.
 * `JELLYCLAW_BRAND_GLYPH`) so a user on an unknown terminal with bad font
 * coverage can pick their own ASCII bullet.
 */

const KNOWN_EMOJI_CAPABLE_TERM_PROGRAMS = new Set<string>([
  "iTerm.app",
  "Apple_Terminal",
  "WezTerm",
  "ghostty",
  "vscode",
  "Hyper",
  "Alacritty",
  "kitty",
  "Tabby",
]);

export interface SupportsEmojiEnv {
  readonly TERM_PROGRAM?: string | undefined;
  readonly TERM?: string | undefined;
  readonly WT_SESSION?: string | undefined;
}

export function supportsEmoji(env: SupportsEmojiEnv = process.env): boolean {
  // Linux virtual console cannot render emoji — hard-negative.
  if (env.TERM === "linux") return false;

  // Windows Terminal sets WT_SESSION and renders emoji fine.
  if (env.WT_SESSION !== undefined && env.WT_SESSION !== "") return true;

  const termProgram = env.TERM_PROGRAM;
  if (typeof termProgram === "string" && KNOWN_EMOJI_CAPABLE_TERM_PROGRAMS.has(termProgram)) {
    return true;
  }

  // Default-open: modern terminals (alacritty via TERM=xterm-256color, tmux,
  // generic SSH sessions) render emoji. The JELLYCLAW_BRAND_GLYPH override
  // exists precisely for the long tail where this guess is wrong.
  return true;
}
