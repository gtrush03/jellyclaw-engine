/**
 * T4-07: npm pack validation tests
 *
 * Verifies that `npm pack` produces a valid tarball with:
 * - All three bin entries (jellyclaw, jellyclaw-serve, jellyclaw-daemon)
 * - Size under 30MB
 * - Required package.json fields
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ENGINE_DIR = path.resolve(__dirname, "../../engine");
const MAX_SIZE_MB = 30;

describe("npm-pack-valid", () => {
  let tarballPath = "";

  beforeAll(() => {
    // Run npm pack in engine directory
    const result = execSync("npm pack", {
      cwd: ENGINE_DIR,
      encoding: "utf-8",
    });
    tarballPath = path.join(ENGINE_DIR, result.trim());
  });

  afterAll(() => {
    // Cleanup tarball
    if (tarballPath && fs.existsSync(tarballPath)) {
      fs.unlinkSync(tarballPath);
    }
  });

  it("produces a tarball", () => {
    expect(tarballPath).toBeTruthy();
    expect(fs.existsSync(tarballPath)).toBe(true);
  });

  it("tarball is under 30MB", () => {
    const stats = fs.statSync(tarballPath);
    const sizeMB = stats.size / (1024 * 1024);
    expect(sizeMB).toBeLessThan(MAX_SIZE_MB);
  });

  it("contains bin/jellyclaw", () => {
    const contents = execSync(`tar -tzf "${tarballPath}"`, {
      encoding: "utf-8",
    });
    expect(contents).toContain("package/bin/jellyclaw");
  });

  it("contains bin/jellyclaw-serve", () => {
    const contents = execSync(`tar -tzf "${tarballPath}"`, {
      encoding: "utf-8",
    });
    expect(contents).toContain("package/bin/jellyclaw-serve");
  });

  it("contains bin/jellyclaw-daemon", () => {
    const contents = execSync(`tar -tzf "${tarballPath}"`, {
      encoding: "utf-8",
    });
    expect(contents).toContain("package/bin/jellyclaw-daemon");
  });

  it("contains dist/ directory", () => {
    const contents = execSync(`tar -tzf "${tarballPath}"`, {
      encoding: "utf-8",
    });
    expect(contents).toContain("package/dist/");
  });

  it("contains package.json with required fields", () => {
    // Extract and read package.json from tarball
    const tmpDir = fs.mkdtempSync("/tmp/jc-npm-test-");
    try {
      execSync(`tar -xzf "${tarballPath}" -C "${tmpDir}"`, {
        encoding: "utf-8",
      });
      const pkgPath = path.join(tmpDir, "package", "package.json");
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as Record<string, unknown>;
      const bin = pkg.bin as Record<string, string>;
      const engines = pkg.engines as Record<string, string> | undefined;

      expect(pkg.name).toBe("@jellyclaw/engine");
      expect(bin).toBeDefined();
      expect(bin.jellyclaw).toBe("./bin/jellyclaw");
      expect(bin["jellyclaw-serve"]).toBe("./bin/jellyclaw-serve");
      expect(bin["jellyclaw-daemon"]).toBe("./bin/jellyclaw-daemon");
      expect(engines?.node).toMatch(/>=20/);
      expect(pkg.author).toBeTruthy();
      expect(pkg.homepage).toBeTruthy();
      expect(pkg.repository).toBeTruthy();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not contain test files", () => {
    const contents = execSync(`tar -tzf "${tarballPath}"`, {
      encoding: "utf-8",
    });
    expect(contents).not.toMatch(/\.test\.(ts|js)/);
    expect(contents).not.toMatch(/\.spec\.(ts|js)/);
  });

  it("does not contain desktop/ directory", () => {
    const contents = execSync(`tar -tzf "${tarballPath}"`, {
      encoding: "utf-8",
    });
    expect(contents).not.toContain("package/desktop/");
  });
});
