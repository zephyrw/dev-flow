import { z } from "zod";
import { Id, RelativePath } from "./base.js";

export type QualityPhase = "before_human" | "after_human";
export type QualityVerdict = "passed" | "changes_required" | "incomplete";
export type FunctionImpact = "none" | "changed" | "uncertain";

export const FindingSeverity = z.enum(["critical", "major", "minor", "info"]);
export type FindingSeverity = z.infer<typeof FindingSeverity>;

export const QualityFindingSchema = z
  .object({
    finding_id: Id,
    severity: FindingSeverity.optional().default("major"),
    repo_id: Id.optional().default("main"),
    file_path: RelativePath.optional(),
    symbol: z.string().optional(),
    line_number: z.number().int().positive().optional(),
    evidence_locations: z.array(z.string()).optional().default([]),
    evidence: z.string().optional().default(""),
    trigger_condition: z.string().optional(),
    reproduction: z.string().optional(),
    expected_actual: z.string().optional(),
    impact: z.string().optional().default(""),
    cause: z.string().optional().default(""),
    verification_type: z
      .enum(["reproduced", "statically_confirmed"])
      .optional()
      .default("statically_confirmed"),
  })
  .passthrough();
export type QualityFinding = z.infer<typeof QualityFindingSchema>;

export const AllowedChangeSchema = z
  .object({
    repo_id: Id.optional().default("main"),
    path: RelativePath.optional(),
    symbol: z.string().optional(),
    action: z.enum(["modify", "create", "delete"]).optional(),
    purpose: z.string().optional(),
  })
  .passthrough();
export type AllowedChange = z.infer<typeof AllowedChangeSchema>;

export const ImplementationStepSchema = z
  .object({
    sequence: z.number().int().positive().optional(),
    depends_on: z.array(z.number().int().positive()).optional().default([]),
    action: z.string().optional(),
    input: z.string().optional(),
    output: z.string().optional(),
    algorithm: z.string().optional(),
    pre_conditions: z.string().optional(),
    post_conditions: z.string().optional(),
    interfaces: z.string().optional(),
    state_and_transaction_rules: z.string().optional(),
    idempotency_and_recovery: z.string().optional(),
  })
  .passthrough();
export type ImplementationStep = z.infer<typeof ImplementationStepSchema>;

export const AcceptanceCaseSchema = z
  .object({
    case_id: Id.optional(),
    layer: z.enum(["unit", "integration", "e2e"]).optional(),
    fixtures: z.string().optional(),
    steps: z.array(z.string()).optional().default([]),
    expected_assertions: z.array(z.string()).optional().default([]),
    pre_fix_failure: z.string().optional(),
  })
  .passthrough();
export type AcceptanceCase = z.infer<typeof AcceptanceCaseSchema>;

export const QualityRepairItemSchema = z
  .object({
    repair_item_id: Id.optional(),
    finding_ids: z.array(Id).optional().default([]),
    design_section: z.string().optional(),
    advice: z.string().optional(),
    evidence_locations: z.array(z.string()).optional().default([]),
    reproduction: z.string().optional(),
    expected_actual: z.string().optional(),
    root_cause: z.string().optional(),
    allowed_changes: z.array(AllowedChangeSchema).optional().default([]),
    forbidden_changes: z.array(z.string()).optional().default([]),
    preserved_behaviors: z.array(z.string()).optional().default([]),
    implementation_steps: z.array(ImplementationStepSchema).optional().default([]),
    acceptance_cases: z.array(AcceptanceCaseSchema).optional().default([]),
    regression_cases: z.array(z.string()).optional().default([]),
    regression_impact_rationale: z.string().optional(),
    completion_evidence: z.array(z.string()).optional().default([]),
    stop_conditions: z.array(z.string()).optional().default([]),
    function_impact: z
      .enum(["none", "changed", "uncertain"])
      .optional()
      .default("none"),
    function_impact_explanation: z.string().optional(),
    document_revision: z.number().int().positive().optional(),
    document_hash: z.string().optional(),
    document_anchor: z.string().optional(),
  })
  .passthrough();
export type QualityRepairItem = z.infer<typeof QualityRepairItemSchema>;

export const QualityRepairPlanSchema = QualityRepairItemSchema;
export type QualityRepairPlan = QualityRepairItem;

export const QualityReviewResultSchema = z
  .object({
    workflow_id: Id.optional(),
    run_id: Id.optional(),
    phase: z.enum(["before_human", "after_human"]).optional(),
    cycle: z.number().int().positive().optional(),
    verdict: z
      .enum(["passed", "changes_required", "incomplete", "need_user"])
      .optional(),
    findings: z.array(QualityFindingSchema).optional().default([]),
    repair_plan: z.array(QualityRepairItemSchema).optional().default([]),
    function_impact: z
      .enum(["none", "changed", "uncertain"])
      .optional()
      .default("none"),
    plan_revision: z.number().int().positive().optional(),
    feedback_cursor: z.number().int().optional().default(0),
    reviewed_at: z.string().optional(),
    summary: z.string().optional(),
    notes: z.string().optional(),
  })
  .passthrough()
  .superRefine((data, ctx) => {
    const ids = (data.findings ?? []).map((f) => f.finding_id);
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({
        code: "custom",
        message: "finding_id 不能重复",
        path: ["findings"],
      });
  });

export type QualityReviewResult = z.infer<typeof QualityReviewResultSchema>;

export interface QualityGate {
  workflow_id: string;
  phase: QualityPhase;
  cycle: number;
  executor_rejections: number;
  failed_repair_review_ids?: string[];
  takeover: boolean;
  status?: "pending" | "passed" | "rejected";
  current_review_id?: string;
  passed_input_fingerprint?: Record<string, string>;
  updated_at: string;
}

export interface QualityRepairAssignment {
  assignment_id?: string;
  planner: boolean;
  phase: QualityPhase;
  source: "quality_review";
  source_review_id: string;
  plan_revision: number;
  plan_hash?: string;
  instructions?: string;
  repair_cycle_id?: string;
  current_attempt_run_id?: string;
  consumed_completion_run_id?: string;
  repair_run_id?: string;
}

export type QualityDecisionAction =
  | "pass"
  | "repair_by_executor"
  | "takeover_by_planner"
  | "retry_incomplete"
  | "executor_test"
  | "planner_commit";

export type QualityFlowPhase = "before_human" | "after_human";

/** 策略 2 的唯一路由数据源；平台只读它决定下一动作，不校验结果真实性。 */
export type QualityFlow = {
  workflow_id: string;
  phase: QualityFlowPhase;
  executor_repair_completed: boolean;
  planner_repairs_only: boolean;
};

export type CodeReviewResult = {
  verdict: "passed" | "changes_required" | "need_user";
  summary?: string;
  /** 可直接传正文；附件路径只是展示补充。 */
  repair_document?: string;
  function_impact?: "none" | "changed" | "uncertain";
};

export type PlannerRepairResult = {
  /** completed 表示规划模型已修复并阅读代码自查，不表示测试完成。 */
  status: "completed" | "need_user" | "need_planner";
  summary?: string;
};

export type ExecutorTestResult = {
  /** completed 表示必要测试及期间相关修复已完成；平台不核验。 */
  status: "completed" | "need_user" | "need_planner";
  summary?: string;
  /** 兼容历史字段，仅展示，不据此分流。 */
  code_changed?: boolean;
  function_impact?: "none" | "changed" | "uncertain";
};

export type PlannerCommitResult = {
  status: "completed" | "need_user" | "need_planner";
  repositories?: Array<{ repo_id: string; commit: string }>;
  summary?: string;
};

export interface QualityDecision {
  action: QualityDecisionAction;
  rejectionCount: number;
  message: string;
}

export type QualityTransferWrite = "none" | "full" | "backfill";

export interface QualityTransfer {
  workflow_id: string;
  review_run_id: string;
  result?: QualityReviewResult;
  phase: QualityPhase;
  cycle: number;
  source_completion_run_id?: string;
  consumed_completion_run_ids?: string[];
  decision: QualityDecision;
  next_assignment_id?: string;
  assignment?: QualityRepairAssignment;
  remove_assignment?: boolean;
  fingerprint?: Record<string, string>;
  result_hash?: string;
  reviewed_at?: string;
  write: QualityTransferWrite;
}
