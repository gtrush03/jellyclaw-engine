/**
 * Tests for useReconnect hook (T3-09).
 */

import { describe, expect, it } from "vitest";
import { calculateDelay } from "./use-reconnect.js";

describe("exponential-backoff", () => {
  it("calculates exponential delays: 1s, 2s, 4s, 8s, 16s", () => {
    // Use fixed jitter of 0 for deterministic testing
    const baseMs = 1000;
    const capMs = 30_000;
    const jitterRatio = 0;

    // Mock Math.random to return 0.5 (which gives jitter factor of 1.0 when jitterRatio is 0)
    const originalRandom = Math.random;
    Math.random = () => 0.5;

    try {
      expect(calculateDelay(1, baseMs, capMs, jitterRatio)).toBe(1000); // 1000 * 2^0 = 1000
      expect(calculateDelay(2, baseMs, capMs, jitterRatio)).toBe(2000); // 1000 * 2^1 = 2000
      expect(calculateDelay(3, baseMs, capMs, jitterRatio)).toBe(4000); // 1000 * 2^2 = 4000
      expect(calculateDelay(4, baseMs, capMs, jitterRatio)).toBe(8000); // 1000 * 2^3 = 8000
      expect(calculateDelay(5, baseMs, capMs, jitterRatio)).toBe(16000); // 1000 * 2^4 = 16000
    } finally {
      Math.random = originalRandom;
    }
  });

  it("caps delay at capMs (30s by default)", () => {
    const baseMs = 1000;
    const capMs = 30_000;
    const jitterRatio = 0;

    const originalRandom = Math.random;
    Math.random = () => 0.5;

    try {
      // Attempt 6: 1000 * 2^5 = 32000 -> capped to 30000
      expect(calculateDelay(6, baseMs, capMs, jitterRatio)).toBe(30000);
      // Attempt 7: 1000 * 2^6 = 64000 -> capped to 30000
      expect(calculateDelay(7, baseMs, capMs, jitterRatio)).toBe(30000);
      // Attempt 10: 1000 * 2^9 = 512000 -> capped to 30000
      expect(calculateDelay(10, baseMs, capMs, jitterRatio)).toBe(30000);
    } finally {
      Math.random = originalRandom;
    }
  });

  it("applies jitter within ±jitterRatio range", () => {
    const baseMs = 1000;
    const capMs = 30_000;
    const jitterRatio = 0.2;

    // Test with jitter at minimum (Math.random returns 0)
    const originalRandom = Math.random;
    Math.random = () => 0;
    try {
      // jitter = 1 + (0 * 2 - 1) * 0.2 = 1 - 0.2 = 0.8
      const minDelay = calculateDelay(1, baseMs, capMs, jitterRatio);
      expect(minDelay).toBe(800); // 1000 * 0.8
    } finally {
      Math.random = originalRandom;
    }

    // Test with jitter at maximum (Math.random returns 1)
    Math.random = () => 1;
    try {
      // jitter = 1 + (1 * 2 - 1) * 0.2 = 1 + 0.2 = 1.2
      const maxDelay = calculateDelay(1, baseMs, capMs, jitterRatio);
      expect(maxDelay).toBe(1200); // 1000 * 1.2
    } finally {
      Math.random = originalRandom;
    }
  });

  it("respects custom baseMs", () => {
    const baseMs = 500;
    const capMs = 30_000;
    const jitterRatio = 0;

    const originalRandom = Math.random;
    Math.random = () => 0.5;

    try {
      expect(calculateDelay(1, baseMs, capMs, jitterRatio)).toBe(500);
      expect(calculateDelay(2, baseMs, capMs, jitterRatio)).toBe(1000);
      expect(calculateDelay(3, baseMs, capMs, jitterRatio)).toBe(2000);
    } finally {
      Math.random = originalRandom;
    }
  });

  it("respects custom capMs", () => {
    const baseMs = 1000;
    const capMs = 5000;
    const jitterRatio = 0;

    const originalRandom = Math.random;
    Math.random = () => 0.5;

    try {
      expect(calculateDelay(1, baseMs, capMs, jitterRatio)).toBe(1000);
      expect(calculateDelay(2, baseMs, capMs, jitterRatio)).toBe(2000);
      expect(calculateDelay(3, baseMs, capMs, jitterRatio)).toBe(4000);
      // Attempt 4: 1000 * 2^3 = 8000 -> capped to 5000
      expect(calculateDelay(4, baseMs, capMs, jitterRatio)).toBe(5000);
    } finally {
      Math.random = originalRandom;
    }
  });
});
