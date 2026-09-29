import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
describe("account release preflight", () => {
  it("rejects an incomplete account payload before git, package installation or archive work", async () => {
    const modulePath = pathToFileURL(
      resolve("scripts/release/build-release.mjs"),
    ).href;
    const release = await import(modulePath);
    const root = mkdtempSync(join(tmpdir(), "devflow-account-release-"));
    try {
      expect(() => release.validateAccountReleaseInputs(root)).toThrow(
        "Missing account release input: dist/apps/api/src/accounts-main.js",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("verifies release tag and git SHA chain consistency before packaging", async () => {
    const modulePath = pathToFileURL(
      resolve("scripts/release/build-release.mjs"),
    ).href;
    const release = await import(modulePath);

    // 1. tag与package.json版本一致，通过
    expect(() =>
      release.verifyVersionChain({
        targetTag: "v0.2.0",
        expectedVersion: "0.2.0",
        gitSha: "abcd1234ef5678",
        expectedGitSha: "abcd1234ef5678",
      }),
    ).not.toThrow();

    // 2. tag不一致，拒绝
    expect(() =>
      release.verifyVersionChain({
        targetTag: "v0.2.1",
        expectedVersion: "0.2.0",
      }),
    ).toThrow(/Release tag mismatch/);

    // 3. git SHA不一致，拒绝
    expect(() =>
      release.verifyVersionChain({
        targetTag: "v0.2.0",
        expectedVersion: "0.2.0",
        gitSha: "abcd1234ef5678",
        expectedGitSha: "11112222333344",
      }),
    ).toThrow(/Release git SHA mismatch/);

    // 4. 未指定可选核对目标时，不阻断
    expect(() =>
      release.verifyVersionChain({
        expectedVersion: "0.2.0",
        gitSha: "abcd1234ef5678",
      }),
    ).not.toThrow();
  });
});
