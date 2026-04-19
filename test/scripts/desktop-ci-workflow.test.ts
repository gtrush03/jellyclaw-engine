/**
 * Tests for desktop CI workflow YAML (T4-06).
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";
import * as yaml from "yaml";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Schema for GitHub Actions workflow
// ---------------------------------------------------------------------------

const WorkflowSchema = z.object({
  name: z.string(),
  on: z
    .object({
      push: z
        .object({
          tags: z.array(z.string()).optional(),
        })
        .optional(),
      workflow_dispatch: z
        .object({
          inputs: z.record(z.any()).optional(),
        })
        .optional(),
    })
    .passthrough(),
  env: z.record(z.string()).optional(),
  jobs: z.record(
    z
      .object({
        name: z.string().optional(),
        "runs-on": z.string(),
        steps: z.array(
          z
            .object({
              name: z.string().optional(),
              uses: z.string().optional(),
              run: z.string().optional(),
              env: z.record(z.any()).optional(),
              with: z.record(z.any()).optional(),
              if: z.string().optional(),
            })
            .passthrough(),
        ),
        env: z.record(z.any()).optional(),
      })
      .passthrough(),
  ),
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("desktop-ci-workflow-valid", () => {
  const workflowPath = path.resolve(process.cwd(), ".github/workflows/desktop-build.yml");

  it("workflow file exists", () => {
    expect(fs.existsSync(workflowPath)).toBe(true);
  });

  it("parses as valid YAML", () => {
    const content = fs.readFileSync(workflowPath, "utf8");
    const parsed = yaml.parse(content);
    expect(parsed).toBeDefined();
    expect(typeof parsed).toBe("object");
  });

  it("conforms to GitHub Actions workflow schema", () => {
    const content = fs.readFileSync(workflowPath, "utf8");
    const parsed = yaml.parse(content);
    const result = WorkflowSchema.safeParse(parsed);

    if (!result.success) {
      console.error("Schema validation errors:", result.error.issues);
    }

    expect(result.success).toBe(true);
  });

  it("triggers on version tags", () => {
    const content = fs.readFileSync(workflowPath, "utf8");
    const parsed = yaml.parse(content);

    expect(parsed.on.push?.tags).toBeDefined();
    expect(parsed.on.push.tags).toContain("v*.*.*");
  });

  it("has workflow_dispatch trigger", () => {
    const content = fs.readFileSync(workflowPath, "utf8");
    const parsed = yaml.parse(content);

    expect(parsed.on.workflow_dispatch).toBeDefined();
  });

  it("uses macos-14 runner (ARM64)", () => {
    const content = fs.readFileSync(workflowPath, "utf8");
    const parsed = yaml.parse(content);

    const macosJob = parsed.jobs["build-macos"];
    expect(macosJob).toBeDefined();
    expect(macosJob["runs-on"]).toBe("macos-14");
  });

  it("declares all required Apple secrets", () => {
    const content = fs.readFileSync(workflowPath, "utf8");

    // Check that all four required secrets are referenced
    const requiredSecrets = [
      "APPLE_DEVELOPER_CERT_P12_BASE64",
      "APPLE_DEVELOPER_CERT_PASSWORD",
      "APPLE_ID",
      "APPLE_TEAM_ID",
      "APPLE_APP_PASSWORD",
    ];

    for (const secret of requiredSecrets) {
      expect(content).toContain(`secrets.${secret}`);
    }
  });

  it("has certificate import step", () => {
    const content = fs.readFileSync(workflowPath, "utf8");
    const parsed = yaml.parse(content);

    const macosJob = parsed.jobs["build-macos"];
    const certStep = macosJob.steps.find(
      (s: { name?: string }) => s.name?.includes("certificate") || s.name?.includes("signing"),
    );

    expect(certStep).toBeDefined();
  });

  it("uploads DMG as artifact", () => {
    const content = fs.readFileSync(workflowPath, "utf8");
    const parsed = yaml.parse(content);

    const macosJob = parsed.jobs["build-macos"];
    const uploadStep = macosJob.steps.find((s: { uses?: string }) =>
      s.uses?.includes("upload-artifact"),
    );

    expect(uploadStep).toBeDefined();
  });

  it("cleans up keychain on completion", () => {
    const content = fs.readFileSync(workflowPath, "utf8");
    const parsed = yaml.parse(content);

    const macosJob = parsed.jobs["build-macos"];
    const cleanupStep = macosJob.steps.find((s: { name?: string }) =>
      s.name?.toLowerCase().includes("cleanup"),
    );

    expect(cleanupStep).toBeDefined();
    expect(cleanupStep.if).toBe("always()");
  });
});
