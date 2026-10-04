#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = process.cwd();
const output = resolve(process.env.DEVFLOW_BUILD_OUTDIR || "dist");
function fingerprint() {
  const digest = createHash("sha256");
  function visit(path) {
    const absolute = join(root, path);
    if (!existsSync(absolute)) return;
    for (const entry of readdirSync(absolute, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (["node_modules", ".devflow", ".git"].includes(entry.name) || entry.isSymbolicLink()) continue;
      const file = join(path, entry.name);
      if (entry.isDirectory()) visit(file);
      else { digest.update(file.replaceAll("\\", "/")); digest.update(readFileSync(join(root, file))); }
    }
  }
  for (const path of ["apps", "packages", "scripts"]) visit(path);
  for (const path of ["package.json", "pnpm-lock.yaml", "tsconfig.json", "tsconfig.build.json"]) {
    digest.update(path); digest.update(readFileSync(join(root, path)));
  }
  return digest.digest("hex");
}
const sourceHash = fingerprint();
const revision = "workspace-" + sourceHash.slice(0, 20);
const env = { ...process.env, DEVFLOW_BUILD_REVISION: revision };
function run(file, args) {
  execFileSync(process.execPath, [resolve(file), ...args], { cwd: root, env, windowsHide: true, stdio: "inherit" });
}
run("node_modules/typescript/bin/tsc", ["-p", "tsconfig.build.json", "--outDir", output]);
run("node_modules/vite/bin/vite.js", ["build", "--config", "apps/web/vite.config.ts", "--outDir", join(output, "web")]);
if (fingerprint() !== sourceHash) throw new Error("Source changed during build; rebuild before deployment");
const target = join(output, "packages/installer/src/entry-template.mjs");
mkdirSync(dirname(target), { recursive: true });
cpSync(resolve("packages/installer/src/entry-template.mjs"), target);
writeFileSync(join(output, "build-info.json"), JSON.stringify({
  application_version: JSON.parse(readFileSync("package.json", "utf8")).version,
  build_revision: revision, service_protocol_version: "1", source_hash: sourceHash, built_at: new Date().toISOString(),
}, null, 2) + "\n");
console.log("Built " + revision + " at " + output);
