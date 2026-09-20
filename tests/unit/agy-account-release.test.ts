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
});
