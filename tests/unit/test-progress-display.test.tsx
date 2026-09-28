import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { TestResults } from "../../apps/web/src/panels.js";
import { DeliveryStrip } from "../../apps/web/src/workbench.js";

const detail = {
  workflow: { id: "wf-test-progress", state: "EXECUTING" },
  plan: { plan: { task_model: "native-v2" } }, tasks: [], evidence: [],
  native_progress: { tests: [{ command: "pnpm vitest run secret-command", status: "passed" }], running: 1,
    latest_result: { status: "passed", passed: 500, failed: 0 } },
  execution_test_report: { test_executions: [{ command: "mvn test another-command", exit_code: 0 }] },
  test_progress: { total: 4, passed: 1, failed: 1, cases: [
    { id: "U1", test_id: "U", layer: "unit", status: "passed", task_ids: [] },
    { id: "U2", test_id: "U", layer: "unit", status: "not_run", task_ids: [] },
    { id: "I1", test_id: "I", layer: "integration", status: "failed", task_ids: [] },
    { id: "B1", test_id: "B", layer: "e2e", status: "stale", task_ids: [] },
  ] },
};

it("renders categorized reported progress without promoting native command success into completion", () => {
  const html = renderToStaticMarkup(<TestResults detail={detail} />);
  expect(html).toContain("测试进度");
  for (const layer of ["单元测试", "集成测试", "浏览器自动测试"]) expect(html).toContain(layer);
  expect(html).toContain("1 / 2 报告通过");
  expect(html.match(/0 \/ 1 报告通过/g)).toHaveLength(2);
  expect(html).toContain("报告通过");
  expect(html).toContain("未运行");
  expect(html).toContain("待复测");
  expect(html).not.toContain("secret-command");
  expect(html).not.toContain("another-command");
  expect(html).not.toContain("原生自测进度");
});

it("keeps plan progress in the delivery strip and removes all native self-test chips", () => {
  const html = renderToStaticMarkup(<DeliveryStrip detail={detail} />);
  expect(html).toContain("计划用例报告通过");
  expect(html).toContain("1/4");
  for (const text of ["已执行自测", "自测运行中", "最近自测", "500"]) expect(html).not.toContain(text);
});

it("distinguishes missing reports from explicitly unrun tests", () => {
  const cases = detail.test_progress.cases.map((item) => ({ ...item,
    status: item.layer === "unit" ? (item.id === "U1" ? "passed" : "unreported") : "unreported" }));
  const html = renderToStaticMarkup(<TestResults detail={{ ...detail, test_progress: { ...detail.test_progress, cases } }} />);
  expect(html).toContain("1 / 2 报告通过");
  expect(html).toContain("1 项未回传");
  expect(html.match(/尚未收到测试结果/g)).toHaveLength(2);
  expect(html).not.toContain("0 / 1 报告通过");
});

it("replaces the all-unreported top counter without claiming tests were not run", () => {
  const test_progress = { ...detail.test_progress, passed: 0, failed: 0, unreported: 4,
    cases: detail.test_progress.cases.map((c) => ({ ...c, status: "unreported" })) };
  const html = renderToStaticMarkup(<DeliveryStrip detail={{ ...detail, test_progress }} />);
  expect(html).toContain("测试进度：");
  expect(html).toContain("尚未收到逐项结果");
  expect(html).not.toContain("0/4");
  expect(html).not.toContain("测试通过进度");
  const partial = renderToStaticMarkup(<DeliveryStrip detail={{ ...detail,
    test_progress: { ...detail.test_progress, unreported: 2 } }} />);
  expect(partial).toContain("1/4");
  expect(partial).toContain("2 项未回传");
});

it("shows the original executor report time and summary without claiming a fresh rerun", () => {
  const reported_at = "2026-09-28T08:00:00.000Z";
  const cases = [{ ...detail.test_progress.cases[0], report_source: "executor_report", reported_at,
    summary: "该轮单元目标已通过；后续代码变更未在本报告内验证。" }];
  const html = renderToStaticMarkup(<TestResults detail={{ ...detail, test_progress: { cases } }} />);
  expect(html).toContain("执行模型上次报告");
  expect(html).toContain(`dateTime="${reported_at}"`);
  expect(html).toContain(cases[0]!.summary);
  expect(html).not.toContain("最新验证通过");
});
