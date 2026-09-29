import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyReleaseIdentity, type ExpectedRelease } from "../../packages/installer/src/release-identity.js";
import { validateReleaseManifest, type ReleaseManifest } from "../../packages/installer/src/manifest.js";
import { parseInstallerCliArgs, runInstaller } from "../../packages/installer/src/main.js";
import { removeDirWithBoundedRetry } from "../fixtures/isolation.js";

describe("release identity preflight", () => {
  let root: string, source: string, expected: ExpectedRelease, manifest: ReleaseManifest;
  const key = `${process.platform}-${process.arch}`;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "devflow-release-identity-"));
    source = join(root, "source");
    mkdirSync(source);
    const tag = "v1.2.3", version = "1.2.3", revision = "a".repeat(40);
    const name = `devflow-${tag}-${key}.tar.gz`;
    const archivePath = join(root, name);
    writeFileSync(archivePath, "isolated archive content");
    const sha256 = createHash("sha256").update("isolated archive content").digest("hex");
    const url = `https://github.com/zephyrw/dev-flow/releases/download/${tag}/${name}`;
    manifest = { tag, version, git_revision: revision, published_at: "2026-09-28T00:00:00.000Z", components: {
      [key]: { name, version, tag, git_revision: revision, platform: process.platform, arch: process.arch, sha256, size_bytes: 24, url },
    } };
    expected = { manifestPath: join(root, "manifest.json"), archivePath, tag, url };
    writeFileSync(expected.manifestPath, JSON.stringify(manifest));
    writeFileSync(join(source, "package.json"), JSON.stringify({ name: "devflow", version }));
    writeFileSync(join(source, "release-identity.json"), JSON.stringify({ version, tag, git_revision: revision, platform: process.platform, arch: process.arch }));
  });
  afterEach(() => removeDirWithBoundedRetry(root));
  it("accepts the full matching identity", () => expect(() => verifyReleaseIdentity(source, expected)).not.toThrow());
  it.each(["version", "tag", "git_revision", "name", "url", "platform", "sha256"] as const)("rejects changed component %s", (field) => {
    manifest.components[key]![field] = "mismatch";
    expect(() => validateReleaseManifest(manifest)).toThrow();
  });
  it("rejects package tampering before creating installation state", async () => {
    writeFileSync(join(source, "package.json"), JSON.stringify({ name: "devflow", version: "2.0.0" }));
    const installRoot = join(root, "untouched");
    expect(await runInstaller({ sourceDir: source, installRoot, expectedRelease: expected })).toBe(20);
    expect(existsSync(installRoot)).toBe(false);
  });
  it("rejects a truncated download", () => {
    writeFileSync(expected.archivePath, "partial");
    expect(() => verifyReleaseIdentity(source, expected)).toThrow();
  });
  it("rejects partial CLI release identity", () => {
    expect(() => parseInstallerCliArgs(["--release-tag", "v1.2.3"])).toThrow("Incomplete release identity");
  });
});
