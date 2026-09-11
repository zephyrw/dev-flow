import { describe, it, expect, afterEach } from "vitest";
import { ConfigSchema } from "../../packages/contracts/src/config.js";
import { RelativePath } from "../../packages/contracts/src/index.js";
import { validatePlan } from "../../packages/plans/src/validate.js";
import { objectHash, redact } from "../../packages/core/src/util.js";
import { plan, setup } from "../helpers.js";
import {
  JsonLines,
  AgyProtocol,
} from "../../packages/adapters/agy/src/protocol.js";
import {
  evaluateReport,
  parseReport,
} from "../../packages/evidence/src/parse.js";
describe("配置与计划合同", () => {
  it("UT-01 rejects unknown keys and invalid model substitutions", () => {
    expect(() => ConfigSchema.parse({ unknown: true })).toThrow();
    expect(() =>
      ConfigSchema.parse({ models: { executor: "other" } }),
    ).toThrow();
    expect(ConfigSchema.parse({}).scheduler.executors).toBe(3);
  });
  it("UT-02 canonical hash is independent of object key order", () =>
    expect(objectHash({ a: 1, b: 2 })).toBe(objectHash({ b: 2, a: 1 })));
  it("UT-06 validates DAG, test links, layers and diagrams", () => {
    const p = plan("config", "a".repeat(40));
    expect(validatePlan(p).diagrams).toHaveLength(1);
    p.tasks[0]!.depends_on = ["T01"];
    expect(() => validatePlan(p)).toThrow(/环/);
    p.tasks[0]!.depends_on = [];
    p.tests[0]!.task_ids = ["missing"];
    expect(() => validatePlan(p)).toThrow(/缺失任务/);
  });
  it("UT-06 rejects absent diagrams and unresolved decisions", () => {
    const p = plan("config", "a".repeat(40));
    p.markdown = p.markdown.replace("```mermaid", "```text");
    expect(() => validatePlan(p)).toThrow(/图解/);
    expect(() =>
      validatePlan({
        ...plan("config", "a".repeat(40)),
        unresolved_decisions: ["业务未知"],
      }),
    ).toThrow();
  });
  it("UT-07 blocks traversal and Windows alternate stream paths", () => {
    for (const p of ["../x", "a/../x", "C:/x", "a\\b", "a:b", "/x"])
      expect(RelativePath.safeParse(p).success).toBe(false);
  });
  it("UT-10 parses fragmented multibyte JSONL and final non-newline result", () => {
    const events: unknown[] = [];
    const parser = new JsonLines((e) => events.push(e));
    const bytes = Buffer.from('{"text":"你好"}\n{"done":true}');
    for (const b of bytes) parser.push(Buffer.from([b]));
    parser.finish();
    expect(events).toEqual([{ text: "你好" }, { done: true }]);
  });
  it("UT-10 rejects invalid and oversized events", () => {
    expect(() => new JsonLines(() => {}).push("invalid\n")).toThrow();
    expect(() => new JsonLines(() => {}, 5).push("123456")).toThrow();
  });
  it("UT-11 binds model and conversation and requires exit success", () => {
    const p = new AgyProtocol("gemini-3.7-flash-high", "c1");
    p.accept({
      event: "init",
      conversation_id: "c1",
      init: { model: "gemini-3.7-flash-high" },
    });
    p.accept({
      event: "result",
      result: { status: "SUCCESS", conversation_id: "c1" },
    });
    expect(p.success(0)).toBe(true);
    expect(p.success(1)).toBe(false);
    expect(() =>
      p.accept({
        event: "result",
        result: { status: "SUCCESS", conversation_id: "c2" },
      }),
    ).toThrow();
  });
  it("UT-13 rejects zero tests, skipped tests and missing expected assertions", () => {
    expect(evaluateReport({ cases: [] }, ["test"], 0).status).toBe("failed");
    expect(
      evaluateReport(
        { cases: [{ id: "test", status: "skipped" }] },
        ["test"],
        0,
      ).status,
    ).toBe("failed");
    expect(
      evaluateReport(
        { cases: [{ id: "different", status: "passed" }] },
        ["test"],
        0,
      ).status,
    ).toBe("failed");
  });
  it("UT-13 parses real report shapes", () => {
    expect(
      parseReport(
        "vitest_json",
        JSON.stringify({
          testResults: [
            { assertionResults: [{ fullName: "a", status: "passed" }] },
          ],
        }),
      ).cases,
    ).toEqual([{ id: "a", status: "passed" }]);
    expect(
      parseReport(
        "junit",
        '<testsuites><testsuite><testcase classname="suite" name="a"/><testcase name="bad"><failure/></testcase></testsuite></testsuites>',
      ).cases[1]?.status,
    ).toBe("failed");
    expect(
      parseReport(
        "playwright_json",
        JSON.stringify({
          suites: [
            {
              specs: [
                { title: "a", tests: [{ results: [{ status: "passed" }] }] },
              ],
            },
          ],
        }),
      ).cases[0]?.status,
    ).toBe("passed");
  });
  it("UT-19 redacts secrets from public logs", () =>
    expect(
      redact("Authorization: Bearer abc123 token=verysecret"),
    ).not.toContain("verysecret"));
});
