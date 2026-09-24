#!/usr/bin/env node
/**
 * Release verification script (DFP-03 / verify-release.mjs).
 *
 * Verifies package directory or tar.gz archive against:
 * 1. Build identity (build-info.json vs package.json vs manifest vs Git HEAD)
 * 2. Runtime and compliance file checklist (runtime-files.json)
 * 3. Negative list: no legacy Host / Go build artifacts
 * 4. Bound bootstrap scripts: no leftover placeholders (@TAG@, @VERSION@)
 * 5. Platform manifest structure, digest and schema validity
 */
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  assertKnownPlatform,
  loadRuntimeFiles,
  readBuildInfo,
  readPackageVersion,
  validateBuildInfo,
  validateManifest,
  validateNoLegacyArtifacts,
  validateRuntimeFiles,
  validateBootstrapAssets,
  sha256File,
} from "./release-lib.mjs";

export function verifyPackageDirectory(pkgDir, options = {}) {
  const abs = resolve(pkgDir);
  if (!existsSync(abs)) throw new Error(`Package directory not found: ${abs}`);

  const buildInfo = readBuildInfo(abs);
  const pkgVersion = readPackageVersion(abs);
  const platformId = options.platformId ?? buildInfo.platform;
  assertKnownPlatform(platformId);

  // 1. Build identity validation
  validateBuildInfo(buildInfo, {
    packageVersion: pkgVersion,
    platformId,
    gitRevision: options.expectedRevision,
  });

  // 2. Negative list: zero legacy Go / Host artifacts
  validateNoLegacyArtifacts(abs);

  // 3. Runtime & compliance manifest check
  const runtimeFiles = loadRuntimeFiles(abs);
  validateRuntimeFiles(abs, platformId, runtimeFiles);

  return {
    verified: true,
    platformId,
    version: pkgVersion,
    revision: buildInfo.build_revision,
  };
}

export function verifyReleaseArchive(archivePath, options = {}) {
  const abs = resolve(archivePath);
  if (!existsSync(abs)) throw new Error(`Release archive not found: ${abs}`);

  const temp = mkdtempSync(join(tmpdir(), "devflow-verify-archive-"));
  try {
    execFileSync("tar", ["-xzf", abs, "-C", temp], { windowsHide: true });
    const payload = join(temp, "devflow");
    const target = existsSync(payload) ? payload : temp;
    return verifyPackageDirectory(target, options);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

export function verifyReleaseManifest(manifestPath, options = {}) {
  const abs = resolve(manifestPath);
  if (!existsSync(abs)) throw new Error(`Manifest not found: ${abs}`);
  const manifest = JSON.parse(readFileSync(abs, "utf8"));
  validateManifest(manifest, options);
  return manifest;
}

export function main() {
  const args = process.argv.slice(2);
  let target = "dist/release";
  let platform = process.platform + "-" + process.arch;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dir" || args[i] === "-d") target = args[++i];
    else if (args[i] === "--platform" || args[i] === "-p") platform = args[++i];
  }

  const resolved = resolve(target);
  console.log(`Verifying release target: ${resolved} (${platform})`);

  if (resolved.endsWith(".tar.gz")) {
    const res = verifyReleaseArchive(resolved, { platformId: platform });
    console.log(`✓ Archive verified: ${res.version} on ${res.platformId}`);
  } else if (existsSync(join(resolved, "package.json"))) {
    const res = verifyPackageDirectory(resolved, { platformId: platform });
    console.log(`✓ Package directory verified: ${res.version} on ${res.platformId}`);
  } else {
    // Treat as release output directory (containing manifest, archives, scripts)
    const manifestName = `release-${platform}.json`;
    const manifestFile = join(resolved, manifestName);
    if (existsSync(manifestFile)) {
      const manifest = verifyReleaseManifest(manifestFile);
      console.log(`✓ Manifest ${manifestName} schema and fields valid`);
      const comp = manifest.components[platform];
      if (comp) {
        const archiveFile = join(resolved, comp.name);
        if (existsSync(archiveFile)) {
          const actualSha = sha256File(archiveFile);
          if (actualSha !== comp.sha256) {
            throw new Error(`Archive checksum mismatch: ${actualSha} != ${comp.sha256}`);
          }
          console.log(`✓ Archive checksum matches manifest`);
          verifyReleaseArchive(archiveFile, { platformId: platform });
          console.log(`✓ Archive internal files and build-info verified`);
        }
      }
    }
    validateBootstrapAssets(resolved);
    console.log(`✓ Bound bootstrap scripts verified without unreplaced tokens`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
    process.exit(0);
  } catch (err) {
    console.error(`Verification FAILED: ${err.message || err}`);
    process.exit(1);
  }
}
