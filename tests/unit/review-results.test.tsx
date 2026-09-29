import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ReviewResults } from "../../apps/web/src/components/ReviewResults.js";

it("renders the current review contract without coverage or snapshot and retains every finding and repair instruction", () => {
  const html = renderToStaticMarkup(<ReviewResults review={{ verdict: "changes_required", plan_revision: 1,
    summary: "确认十项需修复的代码问题。", findings: Array.from({ length: 10 }, (_, index) => ({
      id: `R${String(index + 1).padStart(2, "0")}`, severity: "P1", path: `src/fixture-${index}.ts`,
      trigger: "执行原计划场景", evidence: `证据 ${index + 1}`, consequence: "结果不完整", reason: `修复意见 ${index + 1}`,
    })), unresolved_questions: [], repair_document: "## 原计划整改\n\n先修复全部问题，再由执行角色进行测试。",
  }} />);
  expect(html).toContain("需要整改");
  expect(html).toContain("确认十项需修复的代码问题");
  for (let index = 1; index <= 10; index++) {
    expect(html).toContain(`R${String(index).padStart(2, "0")}`);
    expect(html).toContain(`修复意见 ${index}`);
  }
  expect(html).toContain("<h2>原计划整改</h2>");
  expect(html).toContain("整改沿用原批准计划");
  expect(html).not.toContain("重新批准");
  expect(html).not.toContain("快照：");
  expect(html).not.toContain("版计划");
});

it.each([
  ["pass", "通过"], ["passed", "通过"], ["quality_pass", "通过"], ["findings", "发现问题"],
  ["changes_required", "需要整改"], ["incomplete", "验证不完整"], ["need_user", "需要你的处理"],
] as const)("renders %s with the matching label when optional arrays are absent", (verdict, label) => {
  expect(renderToStaticMarkup(<ReviewResults review={{ verdict }} />)).toContain(label);
});

it("preserves historical coverage, snapshot and unresolved questions", () => {
  const html = renderToStaticMarkup(<ReviewResults review={{ stale: true, verdict: "findings", snapshot_id: "snapshot-fixture",
    coverage: { files: ["src/legacy.ts"] } as any, unresolved_questions: ["仍待确认的问题"],
  }} />);
  expect(html).toContain("历史复核已失效");
  expect(html).toContain("snapshot-fixture");
  expect(html).toContain("src/legacy.ts");
  expect(html).toContain("仍待确认的问题");
});

it("renders an absent review without prescribing a workflow stage", () => {
  const html = renderToStaticMarkup(<ReviewResults />);
  expect(html).toContain("尚无独立复核结果");
  expect(html).not.toContain("人工验收通过后");
});
