import { describe, it, expect } from "vitest";
import {
  PlanSchema,
  QualityReviewResultSchema,
  QualityFindingSchema,
  QualityRepairItemSchema,
  resolveTaskModel,
} from "../../packages/contracts/src/index.js";

describe("devflow-v2-contracts: 精简计划分型、配置与质量整改严格合同测试 (RQ-04, RQ-07)", () => {
  it("UT-C01: resolveTaskModel 准确区分 native-v2, leaf-v1 与 legacy", () => {
    expect(resolveTaskModel({ task_model: "native-v2" })).toBe("native-v2");
    expect(resolveTaskModel({ task_model: "leaf-v1" })).toBe("leaf-v1");
    expect(resolveTaskModel({ task_model: "legacy" })).toBe("legacy");
    expect(resolveTaskModel(null)).toBe("legacy");
  });

  it("UT-C02: 精简 native-v2 计划合同校验与字段解析", () => {
    const validNativePlan = {
      task_model: "native-v2",
      revision: 1,
      modules: [{ id: "m1", title: "核心模块" }],
      work_items: [
        {
          id: "w1",
          title: "实现服务",
          paths: ["src/service.ts"],
          depends_on: [],
        },
      ],
      acceptance_items: [
        {
          id: "a1",
          scenario: "验证服务",
          expected_outcome: "返回正确结果",
          layer: "unit",
          work_item_ids: ["w1"],
        },
      ],
      scope: {
        allowed_paths: ["src/service.ts"],
        repository_paths: {},
        protected_paths: [".git"],
        allow_dependency_changes: false,
        allow_public_api_changes: false,
      },
      baselines: { main: "a".repeat(40) },
      project_config_hash: "cfg_hash_1",
    };

    const parsed = PlanSchema.parse(validNativePlan);
    expect(parsed.task_model).toBe("native-v2");
    expect(parsed.work_items).toHaveLength(1);
    expect(parsed.acceptance_items).toHaveLength(1);
  });

  it("UT-C03: 质量整改项 (QualityRepairItem) 严格结构校验", () => {
    const validRepairItem = {
      repair_item_id: "repair_01",
      finding_ids: ["f1"],
      design_section: "## 架构设计",
      evidence_locations: ["src/index.ts:10"],
      reproduction: "运行测试并触发空指针",
      expected_actual: "期望返回有效对象，实际抛出异常",
      root_cause: "未做空值判断",
      allowed_changes: [
        {
          repo_id: "main",
          path: "src/index.ts",
          symbol: "handleRequest",
          action: "modify" as const,
          purpose: "补充空值防御",
        },
      ],
      forbidden_changes: ["package.json"],
      preserved_behaviors: ["保持既有成功返回格式"],
      implementation_steps: [
        {
          sequence: 1,
          depends_on: [],
          action: "添加空值检查语句",
          input: "传入的 context 参数",
          output: "非空的 Context 实例",
          algorithm: "三元表达式或可选链判空",
          pre_conditions: "参数可能为 undefined",
          post_conditions: "参数必然非空",
          interfaces: "Context 接口不变",
          state_and_transaction_rules: "不涉及持久化状态",
          idempotency_and_recovery: "纯函数计算",
        },
      ],
      acceptance_cases: [
        {
          case_id: "case_01",
          layer: "unit" as const,
          fixtures: "mockContext",
          steps: ["传入空 context 调用函数"],
          expected_assertions: ["不抛出异常并返回默认响应"],
          pre_fix_failure: "抛出 TypeError: Cannot read property",
        },
      ],
      regression_cases: ["test_normal_flow"],
      regression_impact_rationale: "仅增加安全分支，正常逻辑不变",
      completion_evidence: ["unit_test_passed"],
      stop_conditions: ["测试失败即停止"],
      function_impact: "none" as const,
      function_impact_explanation: "无外部行为变更",
      document_revision: 1,
      document_hash: "doc_hash_123",
      document_anchor: "#repair_01",
    };

    const parsed = QualityRepairItemSchema.parse(validRepairItem);
    expect(parsed.repair_item_id).toBe("repair_01");
    expect(parsed.implementation_steps[0]!.sequence).toBe(1);
  });

  it("UT-C04: superRefine 拒绝空 finding 或空 repair_plan 的 changes_required", () => {
    const invalidResult1 = {
      workflow_id: "wf1",
      run_id: "run1",
      phase: "before_human" as const,
      cycle: 1,
      verdict: "changes_required" as const,
      findings: [],
      repair_plan: [],
      plan_revision: 1,
      reviewed_at: new Date().toISOString(),
    };

    const res1 = QualityReviewResultSchema.safeParse(invalidResult1);
    expect(res1.success).toBe(false);
  });

  it("UT-C05: superRefine 拒绝未覆盖 blocking finding 的整改计划", () => {
    const validFinding = {
      finding_id: "f_critical",
      severity: "critical" as const,
      evidence: "发生严重越界漏洞",
      impact: "任意文件被越权读取",
      cause: "缺少路径规范化判断",
    };

    const repairItemCoveringOther = {
      repair_item_id: "rep1",
      finding_ids: ["f_minor"],
      design_section: "## 修复",
      reproduction: "复现步骤",
      expected_actual: "预期与实际",
      root_cause: "根因",
      allowed_changes: [
        {
          path: "src/safe.ts",
          symbol: "check",
          action: "modify" as const,
          purpose: "修复",
        },
      ],
      preserved_behaviors: ["原有行为保持"],
      implementation_steps: [
        {
          sequence: 1,
          action: "修改代码",
          input: "输入",
          output: "输出",
          algorithm: "算法",
          pre_conditions: "前置",
          post_conditions: "后置",
          interfaces: "接口",
          state_and_transaction_rules: "事务",
          idempotency_and_recovery: "幂等",
        },
      ],
      acceptance_cases: [
        {
          case_id: "ac1",
          layer: "unit" as const,
          fixtures: "夹具",
          steps: ["步骤"],
          expected_assertions: ["断言"],
          pre_fix_failure: "原失败",
        },
      ],
      regression_impact_rationale: "无影响",
      completion_evidence: ["证据"],
      stop_conditions: ["停止"],
      function_impact: "none" as const,
      function_impact_explanation: "解释",
      document_revision: 1,
      document_hash: "hash",
      document_anchor: "#rep1",
    };

    const resultWithUncovered = {
      workflow_id: "wf1",
      run_id: "run1",
      phase: "before_human" as const,
      cycle: 1,
      verdict: "changes_required" as const,
      findings: [
        validFinding,
        {
          finding_id: "f_minor",
          severity: "minor" as const,
          evidence: "微小代码格式问题",
          impact: "轻微影响可读性",
          cause: "缩进错误",
        },
      ],
      repair_plan: [repairItemCoveringOther],
      plan_revision: 1,
      reviewed_at: new Date().toISOString(),
    };

    const res = QualityReviewResultSchema.safeParse(resultWithUncovered);
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(
        res.error.issues.some((i) =>
          i.message.includes("阻塞缺陷 f_critical 未被任何整改条目覆盖"),
        ),
      ).toBe(true);
    }
  });

  it("UT-C06: superRefine 检查实施步骤存在自依赖与非法依赖", () => {
    const finding = {
      finding_id: "f1",
      severity: "major" as const,
      evidence: "SQL 注入隐患",
      impact: "可能导致泄露",
      cause: "字符串拼接",
    };

    const selfDepRepair = {
      repair_item_id: "rep1",
      finding_ids: ["f1"],
      design_section: "## 修复",
      reproduction: "复现步骤",
      expected_actual: "预期与实际",
      root_cause: "根因",
      allowed_changes: [
        {
          path: "src/db.ts",
          symbol: "query",
          action: "modify" as const,
          purpose: "参数化查询",
        },
      ],
      preserved_behaviors: ["原有接口返回类型"],
      implementation_steps: [
        {
          sequence: 1,
          depends_on: [1], // 自依赖！
          action: "修改查询",
          input: "输入",
          output: "输出",
          algorithm: "算法",
          pre_conditions: "前置",
          post_conditions: "后置",
          interfaces: "接口",
          state_and_transaction_rules: "事务",
          idempotency_and_recovery: "幂等",
        },
      ],
      acceptance_cases: [
        {
          case_id: "ac1",
          layer: "unit" as const,
          fixtures: "夹具",
          steps: ["步骤"],
          expected_assertions: ["断言"],
          pre_fix_failure: "原失败",
        },
      ],
      regression_impact_rationale: "无影响",
      completion_evidence: ["证据"],
      stop_conditions: ["停止"],
      function_impact: "none" as const,
      function_impact_explanation: "解释",
      document_revision: 1,
      document_hash: "hash",
      document_anchor: "#rep1",
    };

    const res = QualityReviewResultSchema.safeParse({
      workflow_id: "wf1",
      run_id: "run1",
      phase: "before_human" as const,
      cycle: 1,
      verdict: "changes_required" as const,
      findings: [finding],
      repair_plan: [selfDepRepair],
      plan_revision: 1,
      reviewed_at: new Date().toISOString(),
    });

    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.some((i) => i.message.includes("自依赖"))).toBe(
        true,
      );
    }
  });
});
