import { it, expect } from "vitest";
import {
  reviewOutputSchema,
  parseReviewOutput,
  ReviewModelOutputSchema,
} from "../../packages/contracts/src/review-output.js";

it("UT01: new review schema excludes audit/evidence fields and satisfies closed wire object rules", () => {
  const schema = reviewOutputSchema(["main", "api"]);
  const jsonStr = JSON.stringify(schema);
  expect(jsonStr).not.toContain("propertyNames");
  expect(jsonStr).not.toContain("tests_validity_checked");
  expect(jsonStr).not.toContain("completion_evidence");
  expect(jsonStr).not.toContain("document_hash");
  expect(jsonStr).not.toContain("document_revision");

  // Schema properties keys
  const properties = schema.properties ?? {};
  expect(properties).toHaveProperty("verdict");
  expect(properties).toHaveProperty("findings");
  expect(properties).toHaveProperty("repair_document");
  expect(properties).not.toHaveProperty("coverage");

  const walk = (node: any) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "object") {
      expect(node.additionalProperties).toBe(false);
      expect(node.required).toEqual(Object.keys(node.properties ?? {}));
    }
    for (const value of Object.values(node))
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === "object") walk(value);
  };
  walk(schema);
});

it("UT02: parses new model outputs (passed, changes_required, need_user) retaining quality impact and notes", () => {
  // passed
  const passedResult = parseReviewOutput({
    verdict: "passed",
    summary: "代码质量满足要求",
    notes: "非必需建议：后续可优化变量命名",
    quality: {
      function_impact: "none",
      summary: "无功能影响",
      notes: "已检查必要上下游",
    },
  });
  expect(passedResult.verdict).toBe("passed");
  expect(passedResult.findings).toEqual([]);
  expect(passedResult.quality?.function_impact).toBe("none");
  expect(passedResult.notes).toContain("非必需建议");

  // changes_required with findings & repair_document
  const changesResult = parseReviewOutput({
    verdict: "changes_required",
    summary: "发现参数传递遗漏",
    findings: [
      {
        path: "packages/core/src/service.ts",
        line: 42,
        category: "logic_error",
        severity: "P1",
        message: "缺少对 options.timeout 的传递",
        suggested_fix: "透传 options.timeout",
      },
    ],
    repair_document: "请在 service.ts 第 42 行透传 options.timeout 参数",
  });
  expect(changesResult.verdict).toBe("changes_required");
  expect(changesResult.findings).toHaveLength(1);
  expect(changesResult.findings?.[0]?.message).toContain("options.timeout");
  expect(changesResult.repair_document).toContain("透传");

  // need_user with unresolved questions
  const needUserResult = parseReviewOutput({
    verdict: "need_user",
    summary: "需要确认业务预期",
    unresolved_questions: ["是否需要兼容旧版本数据？"],
  });
  expect(needUserResult.verdict).toBe("need_user");
  expect(needUserResult.unresolved_questions).toContain("是否需要兼容旧版本数据？");
});

it("UT03: backwards compatibility parses legacy review structure with coverage and null repair_plan", () => {
  const legacyInput = {
    verdict: "passed",
    summary: "历史复核结果",
    coverage: {
      tests_validity_checked: true,
      test_runs_analyzed: 3,
      untested_changes: [],
    },
    repair_plan: null,
    quality: {
      verdict: "passed",
      function_impact: "none",
    },
  };
  const parsed = parseReviewOutput(legacyInput);
  expect(parsed.verdict).toBe("passed");
  expect(parsed.coverage?.tests_validity_checked).toBe(true);

  // Missing legacy validity check field should not fail parsing
  const modernLegacy = {
    verdict: "passed",
    summary: "缺少旧字段的历史记录",
  };
  const parsedModern = parseReviewOutput(modernLegacy);
  expect(parsedModern.verdict).toBe("passed");
});
