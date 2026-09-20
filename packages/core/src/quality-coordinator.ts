import type { Store } from "../../store/src/store.js";
import {
  type Workflow,
  type QualityGate,
  type QualityPhase,
  type QualityRepairAssignment,
  type QualityReviewResult,
  type Run,
  QualityReviewResultSchema,
  requireCondition,
} from "../../contracts/src/index.js";
import { CurrentDeliveryReader } from "../../evidence/src/current-delivery.js";
import { PlanSelfCheckCoordinator } from "./plan-self-check.js";
import { now, objectHash } from "./util.js";
import {
  closeQualityRepairBatch,
  ensureQualityRepairBatch,
} from "./repair-model-service.js";

type Decision = {
  action:
    | "pass"
    | "repair_by_executor"
    | "takeover_by_planner"
    | "retry_incomplete";
  rejectionCount: number;
  message: string;
};
export class QualityCoordinator {
  constructor(private store: Store) {}
  getGateKey(workflowId: string, phase: QualityPhase) {
    return workflowId + ":gate:" + phase;
  }
  getGate(workflowId: string, phase: QualityPhase) {
    return this.store.get<QualityGate>(
      "quality_gate",
      this.getGateKey(workflowId, phase),
    );
  }
  getOrCreateGate(workflowId: string, phase: QualityPhase): QualityGate {
    const existing = this.getGate(workflowId, phase);
    if (existing) return existing;
    const gate: QualityGate = {
      workflow_id: workflowId,
      phase,
      cycle: 1,
      executor_rejections: 0,
      failed_repair_review_ids: [],
      takeover: false,
      status: "pending",
      updated_at: now(),
    };
    this.store.put(
      "quality_gate",
      this.getGateKey(workflowId, phase),
      workflowId,
      gate,
    );
    return gate;
  }
  fingerprint(workflowId: string) {
    const w = this.store.must<Workflow>("workflow", workflowId);
    const delivery = new CurrentDeliveryReader(this.store).requireValidDelivery(
      workflowId,
    );
    const check = new PlanSelfCheckCoordinator(this.store).assertPassed(w);
    return {
      plan_hash: w.plan_hash!,
      snapshot_id: w.snapshot_id!,
      delivery_revision_id: delivery.revision!.id,
      context: objectHash({
        feedback: w.feedback,
        environment_revision: w.environment_revision,
        messages: this.store
          .list<any>("feedback_message", workflowId)
          .map((m) => [m.message_id, m.seq, m.text, m.refs]),
      }),
      self_check_id: check.id,
    };
  }
  assertPassed(workflowId: string, phase: QualityPhase) {
    const gate = this.getGate(workflowId, phase);
    requireCondition(
      gate?.status === "passed" &&
        objectHash(gate.passed_input_fingerprint) ===
          objectHash(this.fingerprint(workflowId)),
      "QUALITY_GATE_STALE",
      "当前交付尚未通过 " + phase + " 代码质量审查",
      422,
    );
    return gate;
  }
  canTakeOver(workflowId: string, phase: QualityPhase) {
    const gate = this.getGate(workflowId, phase);
    const reviews = gate?.failed_repair_review_ids ?? [];
    return (
      gate?.status === "rejected" &&
      gate.takeover === true &&
      gate.executor_rejections === 3 &&
      reviews.length === 3 &&
      new Set(reviews).size === 3 &&
      reviews.every((id) => {
        const review = this.store.get<QualityReviewResult & {
          executor_repair_run_id?: string;
        }>("quality_review", id);
        return (
          review?.workflow_id === workflowId &&
          review.phase === phase &&
          review.verdict === "changes_required" &&
          !!review.executor_repair_run_id
        );
      })
    );
  }
  private completedExecutorRepair(w: Workflow, gate: QualityGate) {
    const assignment = this.store.get<QualityRepairAssignment>(
      "repair_assignment",
      w.id,
    );
    if (
      gate.status !== "rejected" ||
      gate.takeover ||
      !assignment ||
      assignment.planner !== false ||
      assignment.source !== "quality_review" ||
      assignment.phase !== gate.phase ||
      assignment.source_review_id !== gate.current_review_id ||
      assignment.plan_revision !== w.plan_revision ||
      assignment.plan_hash !== w.plan_hash
    )
      return;
    const source = this.store.get<QualityReviewResult>(
      "quality_review",
      assignment.source_review_id,
    );
    if (
      source?.workflow_id !== w.id ||
      source.phase !== gate.phase ||
      source.verdict !== "changes_required" ||
      !source.repair_plan.length
    )
      return;
    // The completed self-check binds the implementation which actually ran the
    // approved repair. A retry, an unsubmitted delivery or a second review of
    // the same implementation is not another completed repair attempt.
    const check = new PlanSelfCheckCoordinator(this.store).current(w.id);
    const run = check && this.store.get<Run>("run", check.source_run_id);
    if (
      !run ||
      run.workflow_id !== w.id ||
      run.plan_revision !== w.plan_revision ||
      run.purpose !== "implement" ||
      run.status !== "completed" ||
      run.exit_code !== 0 ||
      this.store.get("run_stop", run.id) ||
      (gate.failed_repair_review_ids ?? []).some(
        (id) =>
          this.store.get<{ executor_repair_run_id?: string }>(
            "quality_review",
            id,
          )?.executor_repair_run_id === run.id,
      )
    )
      return;
    return run.id;
  }
  evaluateReviewResult(workflowId: string, input: unknown): Decision {
    const parsed = QualityReviewResultSchema.safeParse(input);
    const phase = parsed.success ? parsed.data.phase : "before_human";
    const reject = (message: string): Decision => ({
      action: "retry_incomplete",
      rejectionCount: this.getGate(workflowId, phase)?.executor_rejections ?? 0,
      message,
    });
    if (!parsed.success)
      return reject(
        "REVIEW_INVALID: " +
          parsed.error.issues.map((i) => i.message).join("; "),
      );
    const result = parsed.data;
    const dedupKey = workflowId + ":" + result.run_id;
    const resultHash = objectHash(result);
    const prior = this.store.get<{ resultHash: string; decision: Decision }>(
      "quality_eval_dedup",
      dedupKey,
    );
    if (prior)
      return prior.resultHash === resultHash
        ? prior.decision
        : reject("IDEMPOTENCY_CONFLICT: 同一审查轮次不能替换结论");
    const w = this.store.get<Workflow>("workflow", workflowId);
    if (!w || w.state !== "REVIEWING" || !w.plan_revision)
      return reject("尚未进入实施自测后的有效审查阶段");
    const run = this.store.get<Run>("run", result.run_id);
    const expectedPhase =
      this.store.get<{ phase: QualityPhase }>(
        "plan_check_review_intent",
        workflowId,
      )?.phase ?? "before_human";
    const cursor = Math.max(
      0,
      ...this.store.list<any>("feedback_message", workflowId).map((m) => m.seq),
    );
    if (
      result.workflow_id !== workflowId ||
      result.phase !== expectedPhase ||
      result.plan_revision !== w.plan_revision ||
      result.feedback_cursor !== cursor ||
      w.run_id !== result.run_id ||
      run?.workflow_id !== workflowId ||
      run.plan_revision !== w.plan_revision ||
      run.status !== "completed" ||
      run.exit_code !== 0 ||
      this.store.get("run_stop", run.id) ||
      !["review", "quality_before_human"].includes(run.stage)
    )
      return reject(
        "REVIEW_BINDING_INVALID: 审查轮次、阶段、计划、退出码或反馈游标不匹配",
      );
    let fingerprint: Record<string, string>;
    try {
      fingerprint = this.fingerprint(workflowId);
    } catch (e) {
      return reject(String(e));
    }
    const gate = this.getOrCreateGate(workflowId, phase);
    if (result.cycle !== gate.cycle)
      return reject("REVIEW_CYCLE_STALE: 审查周期已变化");
    if (result.verdict === "incomplete")
      return reject("质量审查未完成，不增加失败计数");
    const repairRunId = this.completedExecutorRepair(w, gate);
    return this.store.transaction(() => {
      let decision: Decision;
      if (result.verdict === "passed") {
        gate.status = "passed";
        gate.executor_rejections = 0;
        gate.failed_repair_review_ids = [];
        gate.takeover = false;
        gate.passed_input_fingerprint = fingerprint;
        if (
          this.store.get<QualityRepairAssignment>("repair_assignment", workflowId)
            ?.phase === phase
        )
          this.store.remove("repair_assignment", workflowId);
        closeQualityRepairBatch(this.store, workflowId, phase);
        decision = {
          action: "pass",
          rejectionCount: gate.executor_rejections,
          message: "质量审查通过",
        };
      } else {
        const failures = gate.failed_repair_review_ids ?? [];
        if (repairRunId) failures.push(result.run_id);
        gate.failed_repair_review_ids = failures;
        gate.executor_rejections = failures.length;
        gate.takeover = gate.executor_rejections === 3;
        gate.status = "rejected";
        gate.cycle++;
        delete gate.passed_input_fingerprint;
        ensureQualityRepairBatch(
          this.store,
          workflowId,
          phase,
          result.run_id,
        );
        decision = {
          action: gate.takeover ? "takeover_by_planner" : "repair_by_executor",
          rejectionCount: gate.executor_rejections,
          message: gate.takeover
            ? "正式整改连续三次复核不通过，规划模型接管修复"
            : "按完整整改文档继续修复",
        };
      }
      gate.current_review_id = result.run_id;
      gate.updated_at = now();
      this.store.put(
        "quality_gate",
        this.getGateKey(workflowId, phase),
        workflowId,
        gate,
      );
      this.store.put("quality_review", result.run_id, workflowId, {
        ...result,
        input_fingerprint: fingerprint,
        ...(repairRunId ? { executor_repair_run_id: repairRunId } : {}),
      });
      this.store.put("quality_eval_dedup", dedupKey, workflowId, {
        resultHash,
        decision,
      });
      return decision;
    });
  }
  startPlannerTakeover(
    workflowId: string,
    phase: QualityPhase = "before_human",
  ) {
    const gate = this.getGate(workflowId, phase);
    requireCondition(
      this.canTakeOver(workflowId, phase),
      "TAKEOVER_NOT_REQUIRED",
      "尚未达到规划模型接管条件",
    );
    const w = this.store.must<Workflow>("workflow", workflowId);
    this.store.put("repair_assignment", workflowId, workflowId, {
      planner: true,
      phase,
      source: "quality_review",
      source_review_id: gate!.current_review_id,
      plan_revision: w.plan_revision,
      plan_hash: w.plan_hash,
    });
    // The scheduler creates the Run only when it actually acquires a slot.
    const next = {
      ...w,
      state: "QUEUED" as const,
      stage: "planner_takeover",
      version: w.version + 1,
      updated_at: now(),
    };
    this.store.put("workflow", workflowId, w.project_id, next);
    this.store.enqueue(workflowId, "dispatch_run", {
      purpose: "planner_takeover",
      workflow_id: workflowId,
    });
    return next;
  }
}
