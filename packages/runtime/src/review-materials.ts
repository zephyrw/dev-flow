import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Engine } from "../../core/src/engine.js";
import type { Run, Workflow, Review } from "../../contracts/src/index.js";
import type { QualityRepairAssignment } from "../../contracts/src/quality.js";
import type { Store } from "../../store/src/store.js";
import { requireCondition } from "../../contracts/src/index.js";
import { reviewCompletionContext } from "../../core/src/review-completion.js";
import { reviewScopeInstructions } from "../../core/src/role-boundaries.js";

/** A recovered Run keeps its frozen assignment even if the active pointer was lost. */
export function repairAssignmentForRun(store: Store, w: Workflow, run: Run): QualityRepairAssignment | null {
  if (!run.assignment_id || run.purpose === "aside" || run.workflow_id !== w.id) return null;
  const active = store.get<QualityRepairAssignment>("repair_assignment", w.id);
  const assignment = active?.assignment_id === run.assignment_id ? active :
    store.list<QualityRepairAssignment>("quality_repair_assignment", w.id)
      .find(item => item.assignment_id === run.assignment_id);
  if (!assignment || assignment.plan_revision !== run.plan_revision || run.plan_revision !== w.plan_revision ||
      (assignment.plan_hash && assignment.plan_hash !== w.plan_hash) ||
      (run.dispatch_context?.source_run_id && assignment.source_review_id !== run.dispatch_context.source_run_id)) return null;
  return assignment;
}

/** Resolve the assigned review, never an unrelated latest review. Older saved
 * assignments are supported using the persisted review Run/request binding. */
export function repairReviewMaterial(store: Store, w: Workflow, run: Run, assignment?: QualityRepairAssignment | null): Review | null {
  if (!assignment || assignment.source !== "quality_review" || run.purpose === "aside" ||
      assignment.assignment_id !== run.assignment_id || assignment.plan_revision !== run.plan_revision ||
      (assignment.plan_hash && assignment.plan_hash !== w.plan_hash)) return null;
  const matches = (review: Review) => (!review.workflow_id || review.workflow_id === w.id) &&
    (!review.plan_revision || review.plan_revision === assignment.plan_revision);
  if (assignment.source_review && matches(assignment.source_review) &&
      assignment.source_review.run_id === assignment.source_review_id) return assignment.source_review;
  const reviews = store.list<Review>("review", w.id);
  const exact = reviews.find(review => review.run_id === assignment.source_review_id && matches(review));
  if (exact) return exact;
  const pointer = store.get<{ review_run_id?: string }>("plan_check_review_intent", w.id);
  if (pointer?.review_run_id !== assignment.source_review_id || !w.review_request_id) return null;
  const legacy = reviews.find(review => !review.run_id && review.review_request_id === w.review_request_id && matches(review));
  return legacy ? { ...legacy, run_id: assignment.source_review_id } : null;
}

export function reviewSkillResources() {
  const dir = dirname(fileURLToPath(import.meta.url));
  const root = [
    resolve(dir, "../../skills"),
    resolve(dir, "../../../../packages/skills"),
  ].find((candidate) =>
    existsSync(resolve(candidate, "devflow-review/SKILL.md")),
  );
  requireCondition(root, "SKILL_MISSING", "安装缺少 devflow-review Skill");
  return Object.fromEntries(
    [
      "devflow-review/SKILL.md",
      "devflow-review/references/repair-document-contract.md",
      "devflow-review/references/review-contract.md",
      "devflow/references/role-and-schedule.md",
    ].map((path) => [path, readFileSync(resolve(root, path), "utf8")]),
  );
}

export function projectReviewCompletion(
  raw: ReturnType<typeof reviewCompletionContext>,
) {
  if (!raw) return null;
  return {
    fingerprint: raw.fingerprint,
    automatic_attempts: raw.automatic_attempts,
    instruction:
      "继续代码质量审查。检查实现遗漏、逻辑与边界、异常、并发、事务、权限、安全及维护性；默认接受自测说明，不核验测试真实性，不要求证明工具。历史审查结论仅作为背景参考，旧 findings 需在当前代码范围内独立核查，历史过程审计要求不继续执行。",
    previous_reviews: (raw.attempts ?? []).map((a) => ({
      run_id: a.run_id,
      review: a.review,
      context_role: "historical_background",
    })),
    updated_at: raw.updated_at,
  };
}

export function reviewContractContext(engine: Engine, w: Workflow, run: Run) {
  const phase =
    w.stage === "quality_before_human" ? "before_human" : "after_human";
  return {
    workflow_id: w.id,
    review_request_id: w.review_request_id,
    run_id: run.id,
    phase,
    cycle: engine.quality.getOrCreateGate(w.id, phase).cycle,
    plan_revision: w.plan_revision,
    next_plan_revision: w.plan_revision + 1,
    snapshot_id: w.snapshot_id,
    feedback_cursor: Math.max(
      0,
      ...engine.store.list<any>("feedback_message", w.id).map((m) => m.seq),
    ),
    completion: projectReviewCompletion(reviewCompletionContext(engine, w)),
  };
}

export function reviewDeliveryContext(engine: Engine, w: Workflow) {
  return engine.reviewDeliveryMaterials(w.id);
}

export const reviewInstructions =
  reviewScopeInstructions +
  "将独立审查范围按模块、调用链或风险边界分配给多个只读子 Agent 并行检查；每个审查子 Agent 都只审代码质量，不核验测试声明或重复运行测试。主审汇总去重、处理结论差异并检查跨模块交互，完整汇总后统一给出审查结论及修复意见，不让每个子 Agent 重复全量审查，也不把并行分工变成平台放行条件。" +
  "完整读取 skill_resources 中的审查规则与整改合同。缺少必要用户决策时才向用户提问。";
