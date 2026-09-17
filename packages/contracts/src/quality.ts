import { z } from "zod";
import { Id, RelativePath, Layer } from "./base.js";

export type QualityPhase = "before_human" | "after_human";
export type QualityVerdict = "passed" | "changes_required" | "incomplete";
export type FunctionImpact = "none" | "changed" | "uncertain";

export const FindingSeverity = z.enum(["critical", "major", "minor", "info"]);
export type FindingSeverity = z.infer<typeof FindingSeverity>;

/**
 * 审查发现的具体缺陷事实 (RQ-07)
 */
export const QualityFindingSchema = z
  .object({
    finding_id: Id,
    severity: FindingSeverity,
    repo_id: Id.default("main"),
    file_path: RelativePath.optional(),
    symbol: z.string().optional(),
    line_number: z.number().int().positive().optional(),
    evidence_locations: z.array(z.string()).default([]),
    evidence: z.string().min(1),
    trigger_condition: z.string().optional(),
    reproduction: z.string().optional(),
    expected_actual: z.string().optional(),
    impact: z.string().min(1),
    cause: z.string().min(1),
    verification_type: z
      .enum(["reproduced", "statically_confirmed"])
      .default("reproduced"),
  })
  .strict();
export type QualityFinding = z.infer<typeof QualityFindingSchema>;

/**
 * 允许变更的具体边界
 */
export const AllowedChangeSchema = z
  .object({
    repo_id: Id.default("main"),
    path: RelativePath,
    symbol: z.string().min(1),
    action: z.enum(["modify", "create", "delete"]),
    purpose: z.string().min(1),
  })
  .strict();
export type AllowedChange = z.infer<typeof AllowedChangeSchema>;

/**
 * 实施步骤规范
 */
export const ImplementationStepSchema = z
  .object({
    sequence: z.number().int().positive(),
    depends_on: z.array(z.number().int().positive()).default([]),
    action: z.string().min(1),
    input: z.string().min(1),
    output: z.string().min(1),
    algorithm: z.string().min(1),
    pre_conditions: z.string().min(1),
    post_conditions: z.string().min(1),
    interfaces: z.string().min(1),
    state_and_transaction_rules: z.string().min(1),
    idempotency_and_recovery: z.string().min(1),
  })
  .strict();
export type ImplementationStep = z.infer<typeof ImplementationStepSchema>;

/**
 * 验收用例规范
 */
export const AcceptanceCaseSchema = z
  .object({
    case_id: Id,
    layer: z.enum(["unit", "integration", "e2e"]),
    fixtures: z.string().min(1),
    steps: z.array(z.string()).min(1),
    expected_assertions: z.array(z.string()).min(1),
    pre_fix_failure: z.string().min(1),
  })
  .strict();
export type AcceptanceCase = z.infer<typeof AcceptanceCaseSchema>;

/**
 * 严格整改文档条目规范 (RQ-07 & repair-document-contract.md)
 */
export const QualityRepairItemSchema = z
  .object({
    repair_item_id: Id,
    finding_ids: z.array(Id).min(1),
    design_section: z.string().min(1),
    evidence_locations: z.array(z.string()).default([]),
    reproduction: z.string().min(1),
    expected_actual: z.string().min(1),
    root_cause: z.string().min(1),
    allowed_changes: z.array(AllowedChangeSchema).min(1),
    forbidden_changes: z.array(z.string()).default([]),
    preserved_behaviors: z.array(z.string()).min(1),
    implementation_steps: z.array(ImplementationStepSchema).min(1),
    acceptance_cases: z.array(AcceptanceCaseSchema).min(1),
    regression_cases: z.array(z.string()).default([]),
    regression_impact_rationale: z.string().min(1),
    completion_evidence: z.array(z.string()).min(1),
    stop_conditions: z.array(z.string()).min(1),
    function_impact: z.enum(["none", "changed", "uncertain"]).default("none"),
    function_impact_explanation: z.string().min(1),
    document_revision: z.number().int().positive().default(1),
    document_hash: z.string().min(1).default("none"),
    document_anchor: z.string().min(1).default("#repair"),
  })
  .strict();
export type QualityRepairItem = z.infer<typeof QualityRepairItemSchema>;

/**
 * 保持兼容的整改项 Schema（支持简写或完整写法）
 */
export const QualityRepairPlanSchema = QualityRepairItemSchema;
export type QualityRepairPlan = QualityRepairItem;

/**
 * 质量审查结果输出标准合同及超精细跨字段校验 (RQ-07)
 */
export const QualityReviewResultSchema = z
  .object({
    workflow_id: Id,
    run_id: Id,
    phase: z.enum(["before_human", "after_human"]),
    cycle: z.number().int().positive(),
    verdict: z.enum(["passed", "changes_required", "incomplete"]),
    findings: z.array(QualityFindingSchema).default([]),
    repair_plan: z.array(QualityRepairItemSchema).default([]),
    function_impact: z.enum(["none", "changed", "uncertain"]).default("none"),
    plan_revision: z.number().int().positive(),
    feedback_cursor: z.number().int().default(0),
    reviewed_at: z.string().min(1),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (
      new Set(data.findings.map((f) => f.finding_id)).size !==
      data.findings.length
    )
      ctx.addIssue({
        code: "custom",
        message: "finding_id 不能重复",
        path: ["findings"],
      });
    if (
      data.verdict === "passed" &&
      (data.findings.length || data.repair_plan.length)
    )
      ctx.addIssue({
        code: "custom",
        message: "存在未修复问题时不能 passed",
        path: ["verdict"],
      });
    if (data.verdict === "changes_required") {
      // 1. 必须有至少一个问题项
      if (!data.findings || data.findings.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "changes_required 判决必须包含至少一个缺陷 finding",
          path: ["findings"],
        });
      }

      // 2. 整改计划不能为空
      if (!data.repair_plan || data.repair_plan.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "changes_required 判决必须包含非空的确定性整改计划 repair_plan",
          path: ["repair_plan"],
        });
        return;
      }

      // 3. 所有 blocking finding (critical / major) 都必须被至少一个 repair_plan 条目覆盖
      const allFindingIds = new Set(data.findings.map((f) => f.finding_id));
      const blockingFindingIds = new Set(
        data.findings
          .filter((f) => f.severity !== "info")
          .map((f) => f.finding_id),
      );
      const coveredFindingIds = new Set<string>();
      const repairItemIds = new Set<string>();

      for (let i = 0; i < data.repair_plan.length; i++) {
        const item = data.repair_plan[i]!;

        // 检查 repair_item_id 是否重复
        if (repairItemIds.has(item.repair_item_id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `整改项 ID 重复: ${item.repair_item_id}`,
            path: ["repair_plan", i, "repair_item_id"],
          });
        }
        repairItemIds.add(item.repair_item_id);

        // 检查 finding_ids 引用的合法性
        for (const fid of item.finding_ids) {
          if (!allFindingIds.has(fid)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `整改项引用了不存在的 finding: ${fid}`,
              path: ["repair_plan", i, "finding_ids"],
            });
          }
          coveredFindingIds.add(fid);
        }

        // 检查 implementation_steps 的依赖环与合法性
        const stepSeqs = new Set(
          item.implementation_steps.map((s) => s.sequence),
        );
        if (stepSeqs.size !== item.implementation_steps.length)
          ctx.addIssue({
            code: "custom",
            message: "步骤编号重复",
            path: ["repair_plan", i, "implementation_steps"],
          });
        const visiting = new Set<number>(),
          done = new Set<number>();
        const visit = (seq: number): boolean => {
          if (visiting.has(seq)) return false;
          if (done.has(seq)) return true;
          visiting.add(seq);
          const step = item.implementation_steps.find(
            (s) => s.sequence === seq,
          );
          for (const dep of step?.depends_on ?? [])
            if (!visit(dep)) return false;
          visiting.delete(seq);
          done.add(seq);
          return true;
        };
        if (item.implementation_steps.some((s) => !visit(s.sequence)))
          ctx.addIssue({
            code: "custom",
            message: "整改步骤依赖存在环",
            path: ["repair_plan", i, "implementation_steps"],
          });
        for (let j = 0; j < item.implementation_steps.length; j++) {
          const step = item.implementation_steps[j]!;
          for (const dep of step.depends_on) {
            if (!stepSeqs.has(dep)) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `实施步骤 ${step.sequence} 依赖了不存在的步骤序号: ${dep}`,
                path: [
                  "repair_plan",
                  i,
                  "implementation_steps",
                  j,
                  "depends_on",
                ],
              });
            }
            if (dep === step.sequence) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `实施步骤 ${step.sequence} 存在自依赖`,
                path: [
                  "repair_plan",
                  i,
                  "implementation_steps",
                  j,
                  "depends_on",
                ],
              });
            }
          }
        }
      }

      for (const bFid of blockingFindingIds) {
        if (!coveredFindingIds.has(bFid)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `阻塞缺陷 ${bFid} 未被任何整改条目覆盖`,
            path: ["repair_plan"],
          });
        }
      }
    }
  });

export type QualityReviewResult = z.infer<typeof QualityReviewResultSchema>;

/**
 * 质量关卡门禁状态
 */
export interface QualityGate {
  workflow_id: string;
  phase: QualityPhase;
  cycle: number;
  executor_rejections: number; // 已完成正式整改后仍被复核拒绝的连续次数，不含首次发现问题
  failed_repair_review_ids?: string[]; // 只记录已绑定实际执行轮次的整改复核，旧计数不能直接触发接管
  takeover: boolean;
  status?: "pending" | "passed" | "rejected";
  current_review_id?: string;
  passed_input_fingerprint?: Record<string, string>;
  updated_at: string;
}

export interface QualityRepairAssignment {
  planner: boolean;
  phase: QualityPhase;
  source: "quality_review";
  source_review_id: string;
  plan_revision: number;
  plan_hash: string;
}
