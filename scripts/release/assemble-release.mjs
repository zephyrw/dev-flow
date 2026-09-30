#!/usr/bin/env node
/**
 * Release assembly script (DFP-03 / assemble-release.mjs).
 *
 * Collects per-platform release-*.json manifests from dist/release/ (or given dir),
 * verifies git_revision, tag and version alignment, rejects duplicates and unknown
 * platforms, and writes the unified `release.json` (and `release.json.sha256`).
 * Also ensures bound install.sh and install.ps1 are validated.
 */
import { existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  assembleManifests,
  validateBootstrapAssets,
  RELEASE_PLATFORMS,
} from "./release-lib.mjs";

export function assembleRelease(releaseDir, options = {}) {
  const abs = resolve(releaseDir);
  if (!existsSync(abs)) throw new Error(`Release directory not found: ${abs}`);

  const manifests = [];
  for (const name of readdirSync(abs)) {
    if (name.startsWith("release-") && name.endsWith(".json")) {
      const content = JSON.parse(readFileSync(join(abs, name), "utf8"));
      manifests.push(content);
    }
  }

  if (manifests.length === 0) {
    throw new Error(`No platform manifests found in ${abs}`);
  }

  const assembled = assembleManifests(manifests, {
    expectedPlatforms: options.expectedPlatforms ?? RELEASE_PLATFORMS,
    allowPartial: options.allowPartial ?? true, // When building single or partial platforms
  });

  const outPath = join(abs, "release.json");
  const jsonText = JSON.stringify(assembled, null, 2);
  writeFileSync(outPath, jsonText);
  const digest = createHash("sha256").update(jsonText).digest("hex");
  writeFileSync(join(abs, "release.json.sha256"), `${digest}  release.json\n`);

  // Verify that any generated bootstrap assets have placeholders properly replaced
  validateBootstrapAssets(abs);

  return { assembled, path: outPath, digest };
}

export function main() {
  const args = process.argv.slice(2);
  let dir = "dist/release";
  let allowPartial = true;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dir" || args[i] === "-d") dir = args[++i];
    else if (args[i] === "--strict-all-platforms") allowPartial = false;
  }

  console.log(`Assembling release manifests from ${dir}...`);
  const result = assembleRelease(dir, { allowPartial });
  console.log(`✓ Assembled ${result.assembled.platforms.length} platform(s): ${result.assembled.platforms.join(", ")}`);
  console.log(`✓ Unified release manifest written to ${result.path} (sha256: ${result.digest})`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
    process.exit(0);
  } catch (err) {
    console.error(`Assembly FAILED: ${err.message || err}`);
    process.exit(1);
  }
}
