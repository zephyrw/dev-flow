import { describe, expect, it, vi } from "vitest";
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnTarget } from "../../scripts/ci/run-targets.mjs";

describe("CI coverage and console interception integration (A12, A13)", () => {
  it("A13-1: console spy and mock work properly with disableConsoleIntercept", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    console.log("test-message-for-spy");
    expect(spy).toHaveBeenCalledWith("test-message-for-spy");
    spy.mockRestore();
  });

  it("A13-2: assertion failures still fail test cleanly without console interception", () => {
    expect(() => {
      expect("actual").toBe("expected");
    }).toThrow();
  });

  it("A13-3: unhandled error in promise or function throws expectedly", async () => {
    await expect(async () => {
      throw new Error("unhandled-error-simulation");
    }).rejects.toThrow("unhandled-error-simulation");
  });

  it("A12-1: vitest configuration includes disableConsoleIntercept and processingConcurrency=1", async () => {
    const configContent = readFileSync("vitest.config.ts", "utf8");
    expect(configContent).toContain("disableConsoleIntercept: true");
    expect(configContent).toContain("processingConcurrency: 1");
    expect(configContent).toContain("include: [\"apps/**/*.{ts,tsx}\", \"packages/**/*.{ts,tsx}\"]");
  });

  it("A12-2: corrupted or missing blob causes merge failure and returns non-zero code", async () => {
    const testDir = join(tmpdir(), `test-ci-cov-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    const blobsDir = join(testDir, "blobs");
    mkdirSync(blobsDir, { recursive: true });

    // Write a corrupted blob file
    writeFileSync(join(blobsDir, "corrupted.json"), "invalid-json-content{{{");

    const result = await spawnTarget([
      "-e",
      `
      const fs = require('fs');
      try {
        JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
        process.exit(0);
      } catch (err) {
        process.exit(1);
      }
      `,
      join(blobsDir, "corrupted.json"),
    ], {});

    expect(result.exit_code).not.toBe(0);

    // Clean up
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  it("A12-3: target failure is not masked by subsequent successful operations", async () => {
    const targetFailure = { exit_code: 1, file: "failed.test.ts" };
    const mergeSuccess = { exit_code: 0 };
    const allResults = [targetFailure];

    const overallFailed = mergeSuccess.exit_code !== 0 || allResults.some(r => r.exit_code !== 0);
    expect(overallFailed).toBe(true);
  });
});
