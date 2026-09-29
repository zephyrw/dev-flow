import { readdirSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name).replaceAll("\\", "/")]);
}
export function discoverTargets() {
  return [
    ...["tests/unit", "tests/integration"].flatMap((directory) => files(directory)
      .filter((file) => /\.test\.tsx?$/.test(file)).map((file) => ({ kind: "vitest", file }))),
    { kind: "node", file: "scripts/install-skills.test.mjs" },
    ...files("tests/e2e").filter((file) => /\.spec\.ts$/.test(file)).map((file) => ({ kind: "playwright", file })),
  ].sort((a, b) => a.file.localeCompare(b.file));
}
export async function runTargets() {
  const { DiagnosticStreamRedactor } = await import("../../dist/packages/presentation/src/secret-redactor.js");
  const safeLog = (text) => {
    const redactor = new DiagnosticStreamRedactor();
    let safe = "";
    for (let offset = 0; offset < text.length; offset += 16384) safe += redactor.push(text.slice(offset, offset + 16384));
    return safe + redactor.push("", true);
  };
  const reportRoot = resolve(".cache/quality");
  mkdirSync(reportRoot, { recursive: true });
  const root = mkdtempSync(join(reportRoot, "run-"));
  const blobs = join(root, "blobs");
  mkdirSync(blobs, { recursive: true });
  const targets = discoverTargets();
  const results = [];
  const vitest = join(dirname(require.resolve("vitest/package.json")), "vitest.mjs");
  const playwright = require.resolve("@playwright/test/cli");
  const invoke = (args, env) => {
    const result = spawnSync(process.execPath, args, {
      env: { ...process.env, ...env }, encoding: "utf8", windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
      timeout: 20 * 60 * 1000,
    });
    process.stdout.write(safeLog(result.stdout ?? ""));
    process.stderr.write(safeLog(result.stderr ?? ""));
    return result.status ?? 1;
  };
  for (const [index, target] of targets.entries()) {
    const directory = join(root, `target-${index}`);
    mkdirSync(directory, { recursive: true });
    let args;
    if (target.kind === "vitest") args = [vitest, "run", target.file, "--coverage", "--maxWorkers=1",
      "--reporter=default", "--reporter=blob", `--outputFile.blob=${join(blobs, `${index}.json`)}`,
      `--coverage.reportsDirectory=${join(directory, "coverage")}`];
    else if (target.kind === "node") args = ["--test", target.file];
    else args = [playwright, "test", target.file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$"];
    // Exactly one enumerated target per test process, including on Windows (no shell).
    const exitCode = invoke(args, { DEVFLOW_TEST_RUN_DIR: join(directory, "instance") });
    results.push({ ...target, exit_code: exitCode, sha: process.env.QUALITY_SHA ?? null, platform: `${process.platform}-${process.arch}` });
  }
  // Vitest merges its own raw blob coverage; node:test and Playwright stay separate.
  const mergeExit = invoke([vitest, "--merge-reports", blobs, "--coverage", "--reporter=default",
    `--coverage.reportsDirectory=${join(root, "coverage")}`]);
  writeFileSync(join(root, "results.json"), JSON.stringify({ targets: results, coverage_merge_exit_code: mergeExit }, null, 2));
  process.exitCode = mergeExit || results.some((item) => item.exit_code !== 0) ? 1 : 0;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await runTargets();
