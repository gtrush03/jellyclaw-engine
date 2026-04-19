/**
 * Theme token snapshot tests.
 *
 * Captures the current theme state as a baseline so T1-02/03/04
 * can't accidentally drift tokens.
 */

import { describe, expect, it } from "vitest";
import {
  borders,
  brand,
  DEFAULT_ROW_ACCENTS,
  density,
  GRADIENT_BELL,
  GRADIENT_HEAT,
  GRADIENT_JELLY,
  PALETTE_VERSION,
  pickBorderForTerm,
  pickRowAccents,
  typography,
} from "./index.js";

describe("theme tokens", () => {
  describe("brand palette", () => {
    it("matches snapshot", () => {
      expect(brand).toMatchSnapshot();
    });

    it("has correct palette version", () => {
      expect(PALETTE_VERSION).toBe("2.0.0");
    });

    it("exports all required tokens", () => {
      expect(brand.jellyCyan).toBe("#3BA7FF");
      expect(brand.medusaViolet).toBe("#9E7BFF");
      expect(brand.amberEye).toBe("#FFB547");
      expect(brand.blushPink).toBe("#FF6FB5");
      expect(brand.foam).toBe("#E8ECF5");
      expect(brand.foamDark).toBe("#D1D5E1");
      expect(brand.abyss).toBe("#0A1020");
      expect(brand.abyssLight).toBe("#161E3A");
      expect(brand.panel).toBe("#0E1830");
      expect(brand.tidewater).toBe("#5A6B8C");
      expect(brand.tidewaterDim).toBe("#3B475F");
      expect(brand.neutralBridge).toBe("#A8B5CA");
      expect(brand.success).toBe("#4ADE80");
      expect(brand.error).toBe("#FF5577");
      expect(brand.diffAdd).toBe("#5A8C66");
      expect(brand.diffDel).toBe("#8C5A5A");
    });
  });

  describe("row accents", () => {
    it("has default row accents", () => {
      expect(DEFAULT_ROW_ACCENTS.name).toBe("classic");
      expect(DEFAULT_ROW_ACCENTS.user).toBe(brand.jellyCyan);
      expect(DEFAULT_ROW_ACCENTS.assistant).toBe(brand.medusaViolet);
      expect(DEFAULT_ROW_ACCENTS.tool).toBe(brand.amberEye);
    });

    it("picks accents deterministically", () => {
      const accents1 = pickRowAccents("session-123");
      const accents2 = pickRowAccents("session-123");
      expect(accents1).toEqual(accents2);
    });

    it("returns default for null/empty session", () => {
      expect(pickRowAccents(null)).toBe(DEFAULT_ROW_ACCENTS);
      expect(pickRowAccents("")).toBe(DEFAULT_ROW_ACCENTS);
    });
  });

  describe("gradients", () => {
    it("exports gradient presets", () => {
      expect(GRADIENT_JELLY).toEqual([brand.jellyCyan, brand.medusaViolet, brand.blushPink]);
      expect(GRADIENT_BELL).toEqual([brand.jellyCyan, brand.medusaViolet]);
      expect(GRADIENT_HEAT).toEqual([brand.amberEye, brand.blushPink]);
    });
  });

  describe("typography", () => {
    it("matches snapshot", () => {
      expect(typography).toMatchSnapshot();
    });

    it("has all required styles", () => {
      expect(typography.heading.bold).toBe(true);
      expect(typography.body.bold).toBe(false);
      expect(typography.mono.bold).toBe(false);
      expect(typography.caption.dim).toBe(true);
      expect(typography.pill.bold).toBe(true);
      expect(typography.emphasis.italic).toBe(true);
    });
  });

  describe("density", () => {
    it("matches snapshot", () => {
      expect(density).toMatchSnapshot();
    });

    it("has all required scales", () => {
      expect(density.padX).toEqual({ none: 0, sm: 1, md: 2, lg: 3 });
      expect(density.padY).toEqual({ none: 0, sm: 0, md: 1, lg: 2 });
      expect(density.gap).toEqual({ xs: 0, sm: 1, md: 1, lg: 2 });
    });
  });

  describe("borders", () => {
    it("matches snapshot", () => {
      expect(borders).toMatchSnapshot();
    });

    it("has all variants", () => {
      expect(borders.round.style).toBe("round");
      expect(borders.single.style).toBe("single");
      expect(borders.ascii.style).toBe("classic");
    });

    it("uses tidewaterDim for all border colors", () => {
      expect(borders.round.color).toBe(brand.tidewaterDim);
      expect(borders.single.color).toBe(brand.tidewaterDim);
      expect(borders.ascii.color).toBe(brand.tidewaterDim);
    });
  });

  describe("pickBorderForTerm", () => {
    it("returns ascii for dumb terminal", () => {
      expect(pickBorderForTerm("dumb")).toBe("ascii");
    });

    it("returns ascii for linux console", () => {
      expect(pickBorderForTerm("linux")).toBe("ascii");
    });

    it("returns ascii when LANG lacks UTF-8", () => {
      expect(pickBorderForTerm("xterm-256color", "C")).toBe("ascii");
      expect(pickBorderForTerm("xterm-256color", "POSIX")).toBe("ascii");
    });

    it("returns round for modern terminals with UTF-8", () => {
      expect(pickBorderForTerm("xterm-256color", "en_US.UTF-8")).toBe("round");
      expect(pickBorderForTerm("xterm-256color", "en_US.utf8")).toBe("round");
    });

    it("returns round when LANG is empty (defaults to UTF-8 assumption)", () => {
      expect(pickBorderForTerm("xterm-256color", "")).toBe("round");
    });
  });
});
