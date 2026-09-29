// Compatibility entry for isolated native candidate acceptance on the current platform.
// This runs real installation/upgrade/failure rollback only when explicitly invoked.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
process.env.RELEASE_TAG ??= `v${pkg.version}`;
process.env.RELEASE_GIT_SHA ??= execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true }).trim();
process.argv[2] ??= "dist/release";
await import("../../scripts/release/validate-candidate.mjs");
