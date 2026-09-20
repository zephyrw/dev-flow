import type { Store } from "../../store/src/store.js";
import {
  type Workflow,
  type QualityGate,
  type QualityPhase,
  type QualityRepairAssignment,
  type QualityReviewResult,
  type QualityDecision,
  type QualityTransfer,
  type Run,
  QualityReviewResultSchema,
  requireCondition,
  type AcceptanceCarry,
} from "../../contracts/src/index.js";
import { now, objectHash, id } from "./util.js";
import type { ExecutionCompletion } from "./waiting-context.js";

type EvalDedup = {
  resultHash: string;
  decision: QualityDecision;
  reviewed_at?: string;
  canonical?: {
    cycle: number;
    phase: QualityPhase;
  };
  next_assignment_id?: string;
  source_completion_run_id?: string;
  consumed_completion_run_ids?: string[];
  assignment_applied?: boolean;
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
    return {
      plan_hash: w.plan_hash ?? "",
      run_id: w.run_id ?? "",
      context: objectHash({
        feedback: w.feedback,
        messages: this.store
          .list<any>("feedback_message", workflowId)
          .map((m) => [m.message_id, m.seq, m.text]),
      }),
    };
  }
  assertPassed(workflowId: string, phase: QualityPhase) {
    const gate = this.getGate(workflowId, phase);
    requireCondition(
      gate?.status === "passed",
      "QUALITY_GATE_STALE",
      "当前任务尚未通过 " + phase + " 代码质量审查",
      422,
    );
    const fingerprint = this.fingerprint(workflowId);
    requireCondition(
      gate.passed_input_fingerprint?.plan_hash === fingerprint.plan_hash,
      "QUALITY_GATE_STALE",
      "计划已变化，需要重新进行 " + phase + " 代码质量审查",
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
        const review = this.store.get<
          QualityReviewResult & {
            executor_repair_run_id?: string;
          }
        >("quality_review", id);
        const repair = review?.executor_repair_run_id
          ? this.store.get<Run>("run", review.executor_repair_run_id)
          : undefined;
        return (
          review?.workflow_id === workflowId &&
          review.phase === phase &&
          review.verdict === "changes_required" &&
          repair?.workflow_id === workflowId &&
          repair.plan_revision === review.plan_revision &&
          repair.purpose === "implement" &&
          repair.status === "completed" &&
          repair.exit_code === 0 &&
          !this.store.get("run_stop", repair.id)
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
      source.verdict !== "changes_required"
    )
      return;
    return this.resolveCompletedRepairRun(w, assignment, gate);
  }
  private resolveCompletedRepairRun(
    w: Workflow,
    assignment: QualityRepairAssignment,
    gate: QualityGate,
  ) {
    for (const runId of this.repairCompletionCandidates(w, assignment)) {
      if (
        this.isCountableRepairRun(w, runId) &&
        !this.repairAlreadyCounted(gate, runId)
      )
        return runId;
    }
  }
  private repairCompletionCandidates(
    w: Workflow,
    assignment: QualityRepairAssignment,
  ) {
    const ids: string[] = [];
    const add = (runId?: string) => {
      if (runId && !ids.includes(runId)) ids.push(runId);
    };
    add(assignment.consumed_completion_run_id);
    for (const completion of this.matchingRepairCompletions(w, assignment))
      add(completion.run_id);
    add(assignment.current_attempt_run_id);
    add(assignment.repair_run_id);
    return ids;
  }
  private matchingRepairCompletions(
    w: Workflow,
    assignment: QualityRepairAssignment,
  ) {
    if (!assignment.assignment_id) return [];
    return this.store
      .list<ExecutionCompletion>("execution_completion", w.id)
      .filter(
        (completion) =>
          completion.intent === "completed" &&
          completion.assignment_id === assignment.assignment_id,
      );
  }
  private isCountableRepairRun(w: Workflow, runId: string) {
    const run = this.store.get<Run>("run", runId);
    return (
      !!run &&
      run.workflow_id === w.id &&
      run.plan_revision === w.plan_revision &&
      run.purpose === "implement" &&
      run.status === "completed" &&
      run.exit_code === 0 &&
      !this.store.get("run_stop", run.id)
    );
  }
  private repairAlreadyCounted(gate: QualityGate, runId: string) {
    return (gate.failed_repair_review_ids ?? []).some(
      (reviewId) =>
        this.store.get<{ executor_repair_run_id?: string }>(
          "quality_review",
          reviewId,
        )?.executor_repair_run_id === runId,
    );
  }
  private readEvalDedup(dedupKey: string) {
    return this.store.get<EvalDedup>("quality_eval_dedup", dedupKey);
  }
  private dedupKey(workflowId: string, reviewRunId: string) {
    return workflowId + ":" + reviewRunId;
  }
  readConflictBackground(workflowId: string) {
    return this.store.get<AcceptanceCarry>("acceptance_carry", workflowId);
  }
  private reviewIdentity(result: {
    workflow_id: string;
    run_id: string;
    phase: QualityPhase;
    cycle: number;
    verdict: string;
    findings: Array<{ finding_id: string }>;
    repair_plan: unknown;
    summary?: string;
    notes?: string;
  }) {
    return objectHash({
      workflow_id: result.workflow_id,
      run_id: result.run_id,
      phase: result.phase,
      cycle: result.cycle,
      verdict: result.verdict,
      findings: [...result.findings].sort((a, b) =>
        a.finding_id.localeCompare(b.finding_id, "en"),
      ),
      repair_plan: result.repair_plan,
      summary: result.summary,
      notes: result.notes,
    });
  }
  evaluateReviewResult(workflowId: string, input: unknown): QualityDecision {
    const transfer = this.prepareQualityTransfer(workflowId, input);
    if (transfer.write === "none") return transfer.decision;
    return this.store.transaction(
      () => this.applyQualityTransfer(transfer).decision,
    );
  }
  prepareQualityTransfer(workflowId: string, input: unknown): QualityTransfer {
    const parsed = QualityReviewResultSchema.safeParse(input);
    const fallbackPhase =
      (parsed.success ? parsed.data.phase : undefined) ?? "before_human";
    if (!parsed.success)
      return this.retryTransfer(
        workflowId,
        typeof input === "object" && input && "run_id" in input
          ? String((input as { run_id?: string }).run_id ?? "")
          : undefined,
        fallbackPhase,
        "REVIEW_INVALID: " +
          parsed.error.issues.map((i) => i.message).join("; "),
      );
    const w = this.store.get<Workflow>("workflow", workflowId);
    if (!w || w.state !== "REVIEWING" || !w.plan_revision)
      return this.retryTransfer(
        workflowId,
        parsed.data.run_id ?? w?.run_id,
        fallbackPhase,
        "尚未进入实施自测后的有效审查阶段",
      );
    const expectedPhase =
      this.store.get<{ phase: QualityPhase }>(
        "plan_check_review_intent",
        workflowId,
      )?.phase ?? "before_human";
    const existing = this.getGate(workflowId, expectedPhase);
    const runId = parsed.data.run_id ?? w.run_id!;
    const prior = this.readEvalDedup(this.dedupKey(workflowId, runId));
    const cursor = Math.max(
      0,
      ...this.store.list<any>("feedback_message", workflowId).map((m) => m.seq),
    );
    const result = {
      ...parsed.data,
      workflow_id: parsed.data.workflow_id ?? workflowId,
      run_id: runId,
      phase: prior?.canonical?.phase ?? parsed.data.phase ?? expectedPhase,
      cycle: prior?.canonical?.cycle ?? parsed.data.cycle ?? existing?.cycle ?? 1,
      plan_revision: parsed.data.plan_revision ?? w.plan_revision,
      feedback_cursor: parsed.data.feedback_cursor ?? cursor,
      verdict:
        parsed.data.verdict ??
        (parsed.data.findings?.length || parsed.data.repair_plan?.length
          ? "changes_required"
          : "incomplete"),
      findings: parsed.data.findings ?? [],
      repair_plan: parsed.data.repair_plan ?? [],
      function_impact: parsed.data.function_impact ?? "none",
    };
    const identity = this.reviewIdentity(result);
    if (prior)
      return prior.resultHash === identity
        ? this.replayTransfer(workflowId, result, prior)
        : this.retryTransfer(
            workflowId,
            runId,
            result.phase,
            "IDEMPOTENCY_CONFLICT: 同一审查轮次不能替换结论",
          );
    const run = this.store.get<Run>("run", result.run_id);
    if (
      result.workflow_id !== workflowId ||
      result.phase !== expectedPhase ||
      w.run_id !== result.run_id ||
      run?.workflow_id !== workflowId ||
      run.status !== "completed" ||
      run.exit_code !== 0 ||
      this.store.get("run_stop", run.id)
    )
      return this.retryTransfer(
        workflowId,
        runId,
        result.phase,
        "REVIEW_BINDING_INVALID: 审查轮次、阶段或运行身份不匹配",
      );
    if (result.cycle !== (existing?.cycle ?? 1))
      return this.retryTransfer(
        workflowId,
        runId,
        result.phase,
        "REVIEW_CYCLE_STALE: 审查周期已变化",
      );
    if (result.verdict === "incomplete" || result.verdict === "need_user")
      return this.retryTransfer(
        workflowId,
        runId,
        result.phase,
        "质量审查未完成，不增加失败计数",
      );
    return this.firstDecisionTransfer(w, result, identity, existing);
  }
  applyQualityTransfer(transfer: QualityTransfer): QualityTransfer {
    if (transfer.write === "none") return transfer;
    const raced = this.readEvalDedup(
      this.dedupKey(transfer.workflow_id, transfer.review_run_id),
    );
    if (raced && raced.resultHash !== transfer.result_hash)
      return {
        ...transfer,
        write: "none",
        decision: this.retryDecision(
          transfer.workflow_id,
          transfer.phase,
          "IDEMPOTENCY_CONFLICT: 同一审查轮次不能替换结论",
        ),
      };
    if (raced && transfer.write === "full")
      return this.finishReplay(transfer, raced);
    if (transfer.write === "backfill") {
      this.persistBackfill(transfer);
      return transfer;
    }
    this.persistFull(transfer);
    return transfer;
  }
  recoverQualityDispatch(
    workflowId: string,
    phase: QualityPhase = "before_human",
  ): QualityTransfer | undefined {
    const gate = this.getGate(workflowId, phase);
    const reviewRunId = gate?.current_review_id;
    if (!reviewRunId) return;
    const review = this.store.get<QualityReviewResult>(
      "quality_review",
      reviewRunId,
    );
    const prior = this.readEvalDedup(this.dedupKey(workflowId, reviewRunId));
    if (!review || !prior?.decision) return;
    if (prior.decision.action === "retry_incomplete") return;
    return this.replayTransfer(workflowId, review, prior);
  }
  private retryDecision(
    workflowId: string,
    phase: QualityPhase,
    message: string,
  ): QualityDecision {
    return {
      action: "retry_incomplete",
      rejectionCount: this.getGate(workflowId, phase)?.executor_rejections ?? 0,
      message,
    };
  }
  private retryTransfer(
    workflowId: string,
    reviewRunId: string | undefined,
    phase: QualityPhase,
    message: string,
  ): QualityTransfer {
    return {
      workflow_id: workflowId,
      review_run_id: reviewRunId ?? "",
      phase,
      cycle: this.getGate(workflowId, phase)?.cycle ?? 1,
      decision: this.retryDecision(workflowId, phase, message),
      write: "none",
    };
  }
  private firstDecisionTransfer(
    w: Workflow,
    result: QualityReviewResult & { run_id: string; phase: QualityPhase; cycle: number },
    resultHash: string,
    existing: QualityGate | undefined,
  ): QualityTransfer {
    const fingerprint = this.fingerprint(w.id);
    const gate = existing ?? this.pendingGate(w.id, result.phase);
    const repairRunId = this.completedExecutorRepair(w, gate);
    const reviewedAt = result.reviewed_at ?? now();
    if (result.verdict === "passed")
      return {
        workflow_id: w.id,
        review_run_id: result.run_id,
        result: { ...result, reviewed_at: reviewedAt },
        phase: result.phase,
        cycle: result.cycle,
        decision: {
          action: "pass",
          rejectionCount: 0,
          message: "质量审查通过",
        },
        remove_assignment: true,
        fingerprint,
        result_hash: resultHash,
        reviewed_at: reviewedAt,
        write: "full",
      };
    const failures = [...(gate.failed_repair_review_ids ?? [])];
    if (repairRunId) failures.push(result.run_id);
    const rejectionCount = failures.length;
    const takeover = rejectionCount === 3;
    const nextAssignmentId = id("asg");
    const assignment = this.assignmentFor(
      w,
      result,
      nextAssignmentId,
      takeover,
    );
    return {
      workflow_id: w.id,
      review_run_id: result.run_id,
      result: { ...result, reviewed_at: reviewedAt },
      phase: result.phase,
      cycle: result.cycle,
      source_completion_run_id: repairRunId,
      consumed_completion_run_ids: repairRunId ? [repairRunId] : [],
      decision: {
        action: takeover ? "takeover_by_planner" : "repair_by_executor",
        rejectionCount,
        message: takeover
          ? "正式整改连续三次复核不通过，规划模型接管修复"
          : "按审查意见继续修复",
      },
      next_assignment_id: nextAssignmentId,
      assignment,
      fingerprint,
      result_hash: resultHash,
      reviewed_at: reviewedAt,
      write: "full",
    };
  }
  private replayTransfer(
    workflowId: string,
    result: QualityReviewResult & { run_id?: string; phase?: QualityPhase },
    prior: EvalDedup,
  ): QualityTransfer {
    const reviewRunId = result.run_id ?? "";
    const phase = prior.canonical?.phase ?? result.phase ?? "before_human";
    const base: QualityTransfer = {
      workflow_id: workflowId,
      review_run_id: reviewRunId,
      result,
      phase,
      cycle: prior.canonical?.cycle ?? result.cycle ?? 1,
      source_completion_run_id: prior.source_completion_run_id,
      consumed_completion_run_ids: prior.consumed_completion_run_ids,
      decision: prior.decision,
      next_assignment_id: prior.next_assignment_id,
      fingerprint: undefined,
      result_hash: prior.resultHash,
      reviewed_at: prior.reviewed_at ?? result.reviewed_at,
      write: "none",
    };
    return this.withBackfill(base, result, prior);
  }
  private withBackfill(
    transfer: QualityTransfer,
    result: QualityReviewResult & { run_id?: string },
    prior: EvalDedup,
  ): QualityTransfer {
    if (prior.assignment_applied) return transfer;
    if (prior.decision.action === "pass") {
      const assignment = this.store.get<QualityRepairAssignment>(
        "repair_assignment",
        transfer.workflow_id,
      );
      if (assignment?.phase !== transfer.phase) return transfer;
      return { ...transfer, remove_assignment: true, write: "backfill" };
    }
    if (
      prior.decision.action !== "repair_by_executor" &&
      prior.decision.action !== "takeover_by_planner"
    )
      return transfer;
    const w = this.store.get<Workflow>("workflow", transfer.workflow_id);
    if (!w || !result.run_id) return transfer;
    const current = this.store.get<QualityRepairAssignment>(
      "repair_assignment",
      transfer.workflow_id,
    );
    if (current?.source_review_id === result.run_id && current.assignment_id)
      return {
        ...transfer,
        next_assignment_id: current.assignment_id,
        assignment: current,
      };
    const nextAssignmentId =
      prior.next_assignment_id ?? current?.assignment_id ?? id("asg");
    return {
      ...transfer,
      next_assignment_id: nextAssignmentId,
      assignment: this.assignmentFor(
        w,
        {
          ...result,
          run_id: result.run_id,
          phase: transfer.phase,
        },
        nextAssignmentId,
        prior.decision.action === "takeover_by_planner",
      ),
      write: "backfill",
    };
  }
  private finishReplay(transfer: QualityTransfer, raced: EvalDedup) {
    const replayed = this.replayTransfer(
      transfer.workflow_id,
      transfer.result ?? QualityReviewResultSchema.parse({ run_id: transfer.review_run_id }),
      raced,
    );
    if (replayed.write === "backfill") this.persistBackfill(replayed);
    return replayed;
  }
  private assignmentFor(
    w: Workflow,
    result: { run_id: string; phase: QualityPhase },
    assignmentId: string,
    planner: boolean,
  ): QualityRepairAssignment {
    return {
      assignment_id: assignmentId,
      repair_cycle_id: assignmentId,
      planner,
      phase: result.phase,
      source: "quality_review",
      source_review_id: result.run_id,
      plan_revision: w.plan_revision!,
      plan_hash: w.plan_hash,
    };
  }
  private pendingGate(workflowId: string, phase: QualityPhase): QualityGate {
    return {
      workflow_id: workflowId,
      phase,
      cycle: 1,
      executor_rejections: 0,
      failed_repair_review_ids: [],
      takeover: false,
      status: "pending",
      updated_at: now(),
    };
  }
  private persistFull(transfer: QualityTransfer) {
    const phase = transfer.phase;
    const gate =
      this.getGate(transfer.workflow_id, phase) ??
      this.pendingGate(transfer.workflow_id, phase);
    if (transfer.decision.action === "pass") {
      gate.status = "passed";
      gate.executor_rejections = 0;
      gate.failed_repair_review_ids = [];
      gate.takeover = false;
      gate.passed_input_fingerprint = transfer.fingerprint;
      this.removePhaseAssignment(transfer.workflow_id, phase);
    } else {
      const failures = [...(gate.failed_repair_review_ids ?? [])];
      if (
        transfer.source_completion_run_id &&
        !failures.includes(transfer.review_run_id)
      )
        failures.push(transfer.review_run_id);
      gate.failed_repair_review_ids = failures;
      gate.executor_rejections = failures.length;
      gate.takeover = gate.executor_rejections === 3;
      gate.status = "rejected";
      gate.cycle++;
      delete gate.passed_input_fingerprint;
      if (transfer.assignment)
        this.store.put(
          "repair_assignment",
          transfer.workflow_id,
          transfer.workflow_id,
          transfer.assignment,
        );
    }
    gate.current_review_id = transfer.review_run_id;
    gate.updated_at = now();
    this.store.put(
      "quality_gate",
      this.getGateKey(transfer.workflow_id, phase),
      transfer.workflow_id,
      gate,
    );
    this.store.put(
      "quality_review",
      transfer.review_run_id,
      transfer.workflow_id,
      {
        ...transfer.result,
        input_fingerprint: transfer.fingerprint,
        ...(transfer.source_completion_run_id
          ? { executor_repair_run_id: transfer.source_completion_run_id }
          : {}),
      },
    );
    this.writeDedup(transfer, true);
    this.consumeCompletions(transfer);
  }
  private persistBackfill(transfer: QualityTransfer) {
    if (transfer.remove_assignment)
      this.removePhaseAssignment(transfer.workflow_id, transfer.phase);
    if (transfer.assignment)
      this.store.put(
        "repair_assignment",
        transfer.workflow_id,
        transfer.workflow_id,
        transfer.assignment,
      );
    this.writeDedup(transfer, true);
    this.consumeCompletions(transfer);
  }
  private writeDedup(transfer: QualityTransfer, assignmentApplied: boolean) {
    if (!transfer.result_hash) return;
    const existing = this.readEvalDedup(
      this.dedupKey(transfer.workflow_id, transfer.review_run_id),
    );
    this.store.put(
      "quality_eval_dedup",
      this.dedupKey(transfer.workflow_id, transfer.review_run_id),
      transfer.workflow_id,
      {
        resultHash: transfer.result_hash,
        decision: transfer.decision,
        reviewed_at: transfer.reviewed_at,
        canonical: {
          cycle: transfer.cycle,
          phase: transfer.phase,
        },
        next_assignment_id: transfer.next_assignment_id,
        source_completion_run_id: transfer.source_completion_run_id,
        consumed_completion_run_ids: transfer.consumed_completion_run_ids,
        assignment_applied: assignmentApplied || existing?.assignment_applied,
      },
    );
  }
  private consumeCompletions(transfer: QualityTransfer) {
    for (const runId of transfer.consumed_completion_run_ids ?? []) {
      const completion = this.store.get<ExecutionCompletion>(
        "execution_completion",
        runId,
      );
      if (!completion) continue;
      this.store.put("execution_completion", runId, transfer.workflow_id, {
        ...completion,
        consumed_by_review_id: transfer.review_run_id,
      });
    }
  }
  private removePhaseAssignment(workflowId: string, phase: QualityPhase) {
    if (
      this.store.get<QualityRepairAssignment>("repair_assignment", workflowId)
        ?.phase === phase
    )
      this.store.remove("repair_assignment", workflowId);
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
      assignment_id: id("asg"),
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
