import { afterEach, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { mergeCoverageReports } from "../../scripts/ci/merge-coverage.mjs";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "devflow-coverage-merge-")); roots.push(root);
  const file = join(root, "app.ts");
  writeFileSync(file, "export function app(flag) {\n if (flag) return 1;\n return 2;\n}\n");
  const loc = (line: number) => ({ start: { line, column: 0 }, end: { line, column: 1 } });
  const record = {
    path: file,
    statementMap: { "0": loc(1), "1": loc(2), "2": loc(3) },
    fnMap: { "0": { name: "app", decl: loc(1), loc: loc(1), line: 1 } },
    branchMap: { "0": { type: "if", loc: loc(2), locations: [loc(2), loc(3)], line: 2 } },
    s: { "0": 1, "1": 0, "2": 0 }, f: { "0": 0 }, b: { "0": [1, 0] },
  };
  const save = (name: string, data: unknown) => { const path = join(root, name); writeFileSync(path, JSON.stringify(data)); return path; };
  return { root, file, loc, record, save };
}

it("merges cumulative statement, function and branch coverage and emits all reports", () => {
  const f = fixture();
  const other = join(f.root, "other.ts"); writeFileSync(other, "export const other = 1;\n");
  const first = f.save("first.json", { [f.file]: f.record });
  const second = f.save("second.json", {
    [f.file]: { ...f.record, s: { "0": 0, "1": 1, "2": 0 }, f: { "0": 1 }, b: { "0": [0, 1] } },
    [other]: { path: other, statementMap: { "0": f.loc(1) }, fnMap: {}, branchMap: {}, s: { "0": 1 }, f: {}, b: {} },
  });
  const output = join(f.root, "coverage");
  expect(mergeCoverageReports([first, second], output)).toEqual({ inputs: 2, files: 2 });
  const result = JSON.parse(readFileSync(join(output, "coverage-final.json"), "utf8"));
  expect(result[f.file].s).toEqual({ "0": 1, "1": 1, "2": 0 });
  expect(result[f.file].f).toEqual({ "0": 1 });
  expect(result[f.file].b).toEqual({ "0": [1, 1] });
  expect(result[other].s).toEqual({ "0": 1 });
  expect(existsSync(join(output, "index.html"))).toBe(true);
});

it("fails closed for missing, corrupt, empty or invalid counter input", () => {
  const f = fixture(); const output = join(f.root, "failed");
  expect(() => mergeCoverageReports([], output)).toThrow(/nonempty/);
  expect(() => mergeCoverageReports([join(f.root, "missing.json")], output)).toThrow();
  const corrupt = join(f.root, "corrupt.json"); writeFileSync(corrupt, "{broken");
  expect(() => mergeCoverageReports([corrupt], output)).toThrow();
  expect(() => mergeCoverageReports([f.save("empty.json", {})], output)).toThrow(/Empty/);
  expect(() => mergeCoverageReports([f.save("counter.json", { [f.file]: { ...f.record, s: {} } })], output)).toThrow(/counter/);
  expect(() => mergeCoverageReports([f.save("branch.json", { [f.file]: { ...f.record, b: { "0": [1] } } })], output)).toThrow(/counter/);
  expect(existsSync(output)).toBe(false);
});

it("preserves a valid implicit else location while refusing negative or nonfinite counters in every map", () => {
  const f = fixture();
  const implicit = { ...f.record, branchMap: { "0": { ...f.record.branchMap["0"], locations: [f.loc(2), { start: {}, end: {} }] } } };
  const output = join(f.root, "implicit-else");
  mergeCoverageReports([f.save("implicit.json", { [f.file]: implicit })], output);
  const merged = JSON.parse(readFileSync(join(output, "coverage-final.json"), "utf8"));
  expect(merged[f.file].b).toEqual({ "0": [1, 0] });
  expect(merged[f.file].branchMap["0"].locations[1]).toEqual({ start: {}, end: {} });
  for (const [index, record] of [
    { ...implicit, b: { "0": [1, -1] } },
    { ...f.record, s: { ...f.record.s, "0": -1 } },
    { ...f.record, f: { "0": -1 } },
    { ...f.record, b: { "0": [Number.NaN, 0] } },
    { ...f.record, s: { ...f.record.s, "0": Number.POSITIVE_INFINITY } },
    { ...f.record, f: { "0": Number.NEGATIVE_INFINITY } },
  ].entries()) {
    expect(() => mergeCoverageReports([f.save(`invalid-${index}.json`, { [f.file]: record })], join(f.root, `invalid-${index}`))).toThrow(/Invalid coverage counter/);
  }
});

it("merges many reports in a child with a fixed heap without retaining every input", () => {
  const f = fixture();
  const count = 6000;
  const statementMap = Object.fromEntries(Array.from({ length: count }, (_, i) => [String(i), {
    start: { line: 1, column: i }, end: { line: 1, column: i + 1 },
  }]));
  writeFileSync(f.file, "x".repeat(count) + "\n");
  const input = f.save("large.json", { [f.file]: { path: f.file, statementMap,
    fnMap: {}, branchMap: {}, s: Object.fromEntries(Array.from({ length: count }, (_, i) => [String(i), 1])), f: {}, b: {} } });
  const inputs = f.save("inputs.json", Array.from({ length: 128 }, () => input));
  const output = join(f.root, "bounded");
  const stdout = execFileSync(process.execPath, ["--max-old-space-size=128", resolve("scripts/ci/merge-coverage.mjs"), inputs, output],
    { encoding: "utf8", windowsHide: true, timeout: 90000 });
  expect(stdout).toContain("Coverage merged: 128 reports, 1 source files");
  const merged = JSON.parse(readFileSync(join(output, "coverage-final.json"), "utf8"));
  expect(Object.keys(merged[f.file].s)).toHaveLength(count);
  expect(Object.values(merged[f.file].s)).toEqual(Array.from({ length: count }, () => 128));
}, 120000);
