import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateReleaseManifest, type ReleaseManifest } from "./manifest.js";

export interface ExpectedRelease {
  manifestPath: string;
  archivePath: string;
  tag: string;
  url: string;
}

/** Read-only preflight. No installation files or state are created on rejection. */
export function verifyReleaseIdentity(source: string, expected: ExpectedRelease): void {
  const manifest = validateReleaseManifest(JSON.parse(readFileSync(expected.manifestPath, "utf8")) as ReleaseManifest);
  const component = manifest.components[`${process.platform}-${process.arch}`];
  const pkg = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
  const bundled = JSON.parse(readFileSync(join(source, "release-identity.json"), "utf8"));
  if (!component || manifest.tag !== expected.tag || component.url !== expected.url ||
      basename(expected.archivePath) !== component.name || pkg.name !== "devflow" ||
      pkg.version !== manifest.version || bundled.version !== manifest.version ||
      bundled.tag !== manifest.tag || bundled.git_revision !== manifest.git_revision ||
      bundled.platform !== process.platform || bundled.arch !== process.arch ||
      statSync(expected.archivePath).size !== component.size_bytes ||
      createHash("sha256").update(readFileSync(expected.archivePath)).digest("hex") !== component.sha256)
    throw new Error("Release identity mismatch");
}

// Bootstrap preflight uses argv, avoiding Windows PowerShell's native -e quoting rules.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [source, manifestPath, archivePath, tag, url] = process.argv.slice(2);
  if (!source || !manifestPath || !archivePath || !tag || !url) throw new Error("Incomplete release identity");
  verifyReleaseIdentity(source, { manifestPath, archivePath, tag, url });
}
