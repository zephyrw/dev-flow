import { XMLParser } from "fast-xml-parser";
import { FlowError } from "../../contracts/src/index.js";
export interface ParsedReport {
  cases: { id: string; status: "passed" | "failed" | "skipped" }[];
}
type Obj = Record<string, unknown>;
const obj = (x: unknown): Obj => (x && typeof x === "object" ? (x as Obj) : {});
const array = (x: unknown): unknown[] =>
  Array.isArray(x) ? x : x === undefined ? [] : [x];
export function parseReport(parser: string, raw: string): ParsedReport {
  const cases: ParsedReport["cases"] = [];
  if (parser === "junit") {
    const d = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@",
    }).parse(raw) as Obj;
    const suites = [obj(d.testsuites), ...array(d.testsuite)];
    const visit = (s: unknown) => {
      for (const c of array(obj(s).testcase)) {
        const t = obj(c);
        cases.push({
          id: [t["@classname"], t["@name"]].filter(Boolean).join(" "),
          status:
            "failure" in t || "error" in t
              ? "failed"
              : "skipped" in t
                ? "skipped"
                : "passed",
        });
      }
      for (const child of array(obj(s).testsuite)) visit(child);
    };
    suites.forEach(visit);
  } else {
    const d = obj(JSON.parse(raw));
    if (parser === "vitest_json") {
      for (const r of array(d.testResults))
        for (const a of array(obj(r).assertionResults)) {
          const t = obj(a);
          cases.push({
            id: String(t.fullName ?? t.title ?? ""),
            status:
              t.status === "passed"
                ? "passed"
                : ["pending", "skipped", "todo", "disabled"].includes(
                      String(t.status),
                    )
                  ? "skipped"
                  : "failed",
          });
        }
    } else if (parser === "playwright_json") {
      const visit = (suite: unknown) => {
        const s = obj(suite);
        for (const spec of array(s.specs)) {
          const p = obj(spec);
          for (const test of array(p.tests)) {
            const t = obj(test);
            const results = array(t.results);
            const last = obj(results.at(-1));
            cases.push({
              id: String(p.title),
              status:
                last.status === "passed"
                  ? "passed"
                  : last.status === "skipped"
                    ? "skipped"
                    : "failed",
            });
          }
        }
        for (const child of array(s.suites)) visit(child);
      };
      array(d.suites).forEach(visit);
    } else throw new FlowError("REPORT_FORMAT", "不支持的报告格式");
  }
  return { cases };
}
export function evaluateReport(
  parsed: ParsedReport,
  expected: string[],
  exit: number,
) {
  const ids = parsed.cases.map((c) => c.id);
  const missing = expected.filter((e) => !ids.includes(e));
  if (new Set(ids).size !== ids.length)
    throw new FlowError("DUPLICATE_CASE", "报告用例 ID 重复，无法唯一追踪");
  const failed = parsed.cases.filter((c) => c.status === "failed").length,
    skipped = parsed.cases.filter((c) => c.status === "skipped").length,
    passed = parsed.cases.filter((c) => c.status === "passed").length;
  return {
    status:
      exit === 0 &&
      expected.length > 0 &&
      missing.length === 0 &&
      failed === 0 &&
      skipped === 0 &&
      passed > 0
        ? ("passed" as const)
        : ("failed" as const),
    case_ids: ids,
    discovered: ids.length,
    passed,
    failed,
    skipped,
    missing,
  };
}
