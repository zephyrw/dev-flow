import { afterEach, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Target, RunTargetsSummary } from "../../scripts/ci/run-targets.mjs";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function invoke(targets: Target[], timeoutMs?: number) {
  const root = mkdtempSync(join(tmpdir(), "devflow-ci-delivery-")); roots.push(root);
  const resultFile = join(root, "result.json");
  const script = `import {runTargets} from ${JSON.stringify(pathToFileURL(resolve("scripts/ci/run-targets.mjs")).href)};
    import {writeFileSync} from 'node:fs';
    const summary=await runTargets(${JSON.stringify({ targets, ...(timeoutMs === undefined ? {} : { timeoutMs }) })});
    writeFileSync(${JSON.stringify(resultFile)},JSON.stringify(summary));`;
  const result = await new Promise<{ code: number; stderr: string }>((done) => {
    execFile(process.execPath, ["--input-type=module", "-e", script], {
      cwd: process.cwd(), windowsHide: true, timeout: 240000, maxBuffer: 16 * 1024 * 1024,
    }, (error, _stdout, stderr) => done({ code: error ? typeof error.code === "number" ? error.code : -1 : 0, stderr }));
  });
  if (!existsSync(resultFile)) throw new Error(`CI child did not finish: ${result.stderr.slice(-2000)}`);
  return { code: result.code, summary: JSON.parse(readFileSync(resultFile, "utf8")) as RunTargetsSummary };
}

it("real independent Vitest targets create coverage that the runner cumulatively merges", async () => {
  const result = await invoke([
    { kind: "vitest", file: "tests/unit/round-intent.test.ts" },
    { kind: "vitest", file: "tests/unit/runtime-failure.test.ts" },
  ]);
  expect(result.code).toBe(0);
  expect(result.summary.targets.map(target => target.exit_code)).toEqual([0, 0]);
  expect(result.summary.coverage_merge_exit_code).toBe(0);
  expect(result.summary.coverage_report_path).toBeTruthy();
  const coverage = JSON.parse(readFileSync(result.summary.coverage_report_path!, "utf8"));
  for (const module of ["packages/core/src/round-intent.ts", "packages/contracts/src/runtime-failure.ts"]) {
    const file = Object.keys(coverage).find(path => path.replaceAll("\\", "/").endsWith(module));
    expect(file).toBeDefined();
    expect(Object.values(coverage[file!].s).some(count => typeof count === "number" && count > 0)).toBe(true);
  }
}, 300000);

it("a missing test remains a target failure even when Vitest emits unexecuted coverage", async () => {
  const result = await invoke([{ kind: "vitest", file: "tests/unit/does-not-exist.test.ts" }]);
  expect(result.code).not.toBe(0);
  expect(result.summary.targets[0]!.exit_code).not.toBe(0);
}, 300000);

it("a target killed before emitting coverage remains a target and merge failure", async () => {
  const result = await invoke([{ kind: "vitest", file: "tests/unit/round-intent.test.ts" }], 100);
  expect(result.code).not.toBe(0);
  expect(result.summary.targets[0]!.timed_out).toBe(true);
  expect(result.summary.targets[0]!.exit_code).not.toBe(0);
  expect(result.summary.coverage_merge_exit_code).not.toBe(0);
}, 300000);

it("a failed target is not masked by a subsequent real successful target", async () => {
  const root = mkdtempSync(join(tmpdir(), "devflow-ci-exit-")); roots.push(root);
  const fail = join(root, "failed.test.mjs"); const pass = join(root, "passed.test.mjs");
  writeFileSync(fail, "import{test}from'node:test';test('fails',()=>{throw Error('expected fixture failure')});");
  writeFileSync(pass, "import{test}from'node:test';test('passes',()=>{});");
  const result = await invoke([{ kind: "node", file: fail }, { kind: "node", file: pass }]);
  expect(result.code).not.toBe(0);
  expect(result.summary.targets[0]!.exit_code).not.toBe(0);
  expect(result.summary.targets[1]!.exit_code).toBe(0);
  expect(result.summary.coverage_merge_exit_code).toBe(0);
}, 300000);
