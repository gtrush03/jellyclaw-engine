import { describe, expect, it } from "vitest";

import { supportsEmoji } from "./supports-emoji.js";

describe("supports-emoji", () => {
  it("returns false for TERM=linux (virtual console)", () => {
    expect(supportsEmoji({ TERM: "linux" })).toBe(false);
  });

  it("returns true for iTerm.app", () => {
    expect(supportsEmoji({ TERM_PROGRAM: "iTerm.app" })).toBe(true);
  });

  it("returns true for Apple_Terminal", () => {
    expect(supportsEmoji({ TERM_PROGRAM: "Apple_Terminal" })).toBe(true);
  });

  it("returns true for WezTerm, ghostty, vscode", () => {
    expect(supportsEmoji({ TERM_PROGRAM: "WezTerm" })).toBe(true);
    expect(supportsEmoji({ TERM_PROGRAM: "ghostty" })).toBe(true);
    expect(supportsEmoji({ TERM_PROGRAM: "vscode" })).toBe(true);
  });

  it("returns true when WT_SESSION is set (Windows Terminal)", () => {
    expect(supportsEmoji({ WT_SESSION: "some-guid" })).toBe(true);
  });

  it("defaults to true on unknown but non-linux TERMs", () => {
    expect(supportsEmoji({ TERM: "xterm-256color" })).toBe(true);
  });
});
