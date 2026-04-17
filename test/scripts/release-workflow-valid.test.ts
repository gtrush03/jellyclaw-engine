/**
 * T4-07: Release workflow validation tests
 *
 * Verifies that .github/workflows/release.yml:
 * - Is valid YAML
 * - Triggers on v* tags
 * - Has required jobs (publish-npm, update-brew-tap)
 * - References expected secrets
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

const WORKFLOW_PATH = path.resolve(__dirname, "../../.github/workflows/release.yml");

describe("release-workflow-valid", () => {
  let workflow: Record<string, unknown>;

  it("exists", () => {
    expect(fs.existsSync(WORKFLOW_PATH)).toBe(true);
  });

  it("is valid YAML", () => {
    const content = fs.readFileSync(WORKFLOW_PATH, "utf-8");
    workflow = parseYaml(content) as Record<string, unknown>;
    expect(workflow).toBeDefined();
    expect(typeof workflow).toBe("object");
  });

  it("triggers on v* tags", () => {
    const content = fs.readFileSync(WORKFLOW_PATH, "utf-8");
    workflow = parseYaml(content) as Record<string, unknown>;

    const on = workflow.on as Record<string, unknown>;
    expect(on).toBeDefined();

    const push = on.push as Record<string, unknown>;
    expect(push).toBeDefined();

    const tags = push.tags as string[];
    expect(tags).toBeDefined();
    expect(tags).toContain("v*");
  });

  it("has build-engine-binary job", () => {
    const content = fs.readFileSync(WORKFLOW_PATH, "utf-8");
    workflow = parseYaml(content) as Record<string, unknown>;

    const jobs = workflow.jobs as Record<string, unknown>;
    expect(jobs).toBeDefined();
    expect(jobs["build-engine-binary"]).toBeDefined();
  });

  it("has build-dmg job", () => {
    const content = fs.readFileSync(WORKFLOW_PATH, "utf-8");
    workflow = parseYaml(content) as Record<string, unknown>;

    const jobs = workflow.jobs as Record<string, unknown>;
    expect(jobs["build-dmg"]).toBeDefined();
  });

  it("has publish-npm job", () => {
    const content = fs.readFileSync(WORKFLOW_PATH, "utf-8");
    workflow = parseYaml(content) as Record<string, unknown>;

    const jobs = workflow.jobs as Record<string, unknown>;
    expect(jobs["publish-npm"]).toBeDefined();
  });

  it("has update-brew-tap job", () => {
    const content = fs.readFileSync(WORKFLOW_PATH, "utf-8");
    workflow = parseYaml(content) as Record<string, unknown>;

    const jobs = workflow.jobs as Record<string, unknown>;
    expect(jobs["update-brew-tap"]).toBeDefined();
  });

  it("has github-release job", () => {
    const content = fs.readFileSync(WORKFLOW_PATH, "utf-8");
    workflow = parseYaml(content) as Record<string, unknown>;

    const jobs = workflow.jobs as Record<string, unknown>;
    expect(jobs["github-release"]).toBeDefined();
  });

  it("references NPM_TOKEN secret", () => {
    const content = fs.readFileSync(WORKFLOW_PATH, "utf-8");
    expect(content).toContain("secrets.NPM_TOKEN");
  });

  it("references BREW_TAP_TOKEN secret", () => {
    const content = fs.readFileSync(WORKFLOW_PATH, "utf-8");
    expect(content).toContain("secrets.BREW_TAP_TOKEN");
  });

  it("references Apple signing secrets", () => {
    const content = fs.readFileSync(WORKFLOW_PATH, "utf-8");
    expect(content).toContain("secrets.APPLE_SIGNING_IDENTITY");
  });

  it("publish-npm depends on build-engine-binary", () => {
    const content = fs.readFileSync(WORKFLOW_PATH, "utf-8");
    workflow = parseYaml(content) as Record<string, unknown>;

    const jobs = workflow.jobs as Record<string, unknown>;
    const publishNpm = jobs["publish-npm"] as Record<string, unknown>;
    expect(publishNpm.needs).toContain("build-engine-binary");
  });

  it("update-brew-tap depends on build-dmg", () => {
    const content = fs.readFileSync(WORKFLOW_PATH, "utf-8");
    workflow = parseYaml(content) as Record<string, unknown>;

    const jobs = workflow.jobs as Record<string, unknown>;
    const updateBrewTap = jobs["update-brew-tap"] as Record<string, unknown>;
    expect(updateBrewTap.needs).toContain("build-dmg");
  });
});
