import type { Store } from "../../store/src/store.js";
import type { Workflow } from "../../contracts/src/index.js";
import type {
  QualityFlow,
  QualityFlowPhase,
} from "../../contracts/src/quality.js";
import {
  createQualityFlow,
  nextQualityAction,
  resolveWorkflowQualityFlow,
  usesQualityPolicyV2,
  type QualityFlowAction,
  type QualityFlowEvent,
} from "./quality-flow.js";

const QUALITY_FLOW_KIND = "quality_flow";
const MIGRATION_RECEIPT_KIND = "quality_policy_migration";

export function usesPolicyV2(workflow: {
  quality_policy_version?: number;
}): boolean {
  return usesQualityPolicyV2(workflow.quality_policy_version);
}

export function readQualityFlow(store: Store, workflowId: string): QualityFlow {
  const stored = store.get<Partial<QualityFlow>>(QUALITY_FLOW_KIND, workflowId);
  return resolveWorkflowQualityFlow(stored, workflowId);
}

export function writeQualityFlow(store: Store, flow: QualityFlow): void {
  store.put(QUALITY_FLOW_KIND, flow.workflow_id, flow.workflow_id, flow);
}

export function ensureQualityFlow(store: Store, workflowId: string): QualityFlow {
  const existing = store.get<Partial<QualityFlow>>(QUALITY_FLOW_KIND, workflowId);
  if (existing) return resolveWorkflowQualityFlow(existing, workflowId);
  const flow = createQualityFlow(workflowId);
  writeQualityFlow(store, flow);
  return flow;
}

/**
 * 策略 2 路由：只读 quality_flow 与本轮角色结果，产出唯一下一动作。
 * 实际写状态和入队仍由 Engine 执行。
 */
export function routeQualityEvent(
  store: Store,
  workflowId: string,
  event: QualityFlowEvent,
  executorRepairDispatched?: boolean,
): { flow: QualityFlow; action: QualityFlowAction } {
  const flow = ensureQualityFlow(store, workflowId);
  const result = nextQualityAction(
    { flow, executor_repair_dispatched: executorRepairDispatched },
    event,
  );
  writeQualityFlow(store, result.flow);
  return result;
}

/**
 * 按计划 11.1 迁移旧任务到策略 2。
 * 只读已有 Run/assignment/用户操作元数据识别位置，不读代码、证据或测试日志。
 */
export function migrateWorkflowQualityPolicy(
  store: Store,
  workflowId: string,
): { migrated: boolean; from?: number; to?: number; reason?: string } {
  const w = store.get<Workflow>("workflow", workflowId);
  if (!w) return { migrated: false, reason: "workflow_missing" };
  if (usesPolicyV2(w)) return { migrated: false, reason: "already_policy_2" };
  if (["COMPLETED", "COMMITTED", "CLEANUP_PENDING"].includes(w.state))
    return { migrated: false, reason: "terminal_readonly" };
  if (["COMMITTING", "INTEGRATING", "COMMIT_PARTIAL"].includes(w.state))
    return { migrated: false, reason: "git_operation_in_flight" };

  const runs = store.list<import("../../contracts/src/index.js").Run>("run", workflowId);
  if (runs.some((run) => ["prepared", "starting", "running", "executing", "stopping", "waiting"].includes(run.status)))
    return { migrated: false, reason: "active_run_frozen" };

  const beforeFlow = store.get<QualityFlow>(QUALITY_FLOW_KIND, workflowId);
  const beforePending = store.get<import("../../contracts/src/model-routing.js").DispatchContext>("pending_dispatch_purpose", workflowId);
  const assignment = store.get<import("../../contracts/src/quality.js").QualityRepairAssignment>("repair_assignment", workflowId);
  const pointer = store.get<{ phase?: QualityFlowPhase; completion_run_id?: string }>("plan_check_review_intent", workflowId);
  const flow = createQualityFlow(workflowId);
  flow.phase = pointer?.phase ?? assignment?.phase ?? "before_human";
  const boundIds = new Set([assignment?.consumed_completion_run_id, assignment?.current_attempt_run_id, assignment?.repair_run_id].filter(Boolean));
  const completions = store.list<{ run_id: string; assignment_id?: string; intent?: string }>("execution_completion", workflowId);
  const matchingImplement = (run: import("../../contracts/src/index.js").Run) =>
    run.purpose === "implement" && run.status === "completed" &&
    (run.plan_revision === undefined || run.plan_revision === w.plan_revision);
  const boundCompleted = !!assignment && assignment.source === "quality_review" && !assignment.planner &&
    runs.some((run) => matchingImplement(run) &&
      (boundIds.has(run.id) || (!!assignment.assignment_id &&
        (run.assignment_id === assignment.assignment_id ||
         completions.some((item) => item.run_id === run.id && item.intent === "completed" && item.assignment_id === assignment.assignment_id)))),
    );
  // 旧任务缺少 assignment 绑定元数据时，按调度位置还原：整改结果待复核位置上的
  // implement 完成视为该次整改已完成；整改待派发位置（QUEUED）不算，保留唯一一次机会。
  const legacyRepairCompleted = !!assignment && assignment.source === "quality_review" && !assignment.planner &&
    boundIds.size === 0 && !assignment.assignment_id &&
    ["REVIEW_QUEUED", "REVIEWING"].includes(w.state) &&
    runs.some(matchingImplement);
  const completedRepair = boundCompleted || legacyRepairCompleted;
  const takeoverRun = runs.find((run) =>
    run.purpose === "planner_takeover" && run.status === "completed" &&
    (!pointer?.completion_run_id && !w.run_id ? true : run.id === (pointer?.completion_run_id ?? w.run_id)),
  );
  const takeoverCompleted = !!takeoverRun;
  // Legacy rejection counts were recorded only after a completed repair was reviewed.
  const rejectedRepair = store.list<{ executor_rejections?: number; failed_repair_review_ids?: string[] }>("quality_gate", workflowId)
    .some((gate) => (gate.executor_rejections ?? 0) > 0 || !!gate.failed_repair_review_ids?.length);
  flow.executor_repair_completed = completedRepair || rejectedRepair;
  flow.planner_repairs_only = flow.phase === "after_human" || assignment?.planner === true || rejectedRepair || takeoverCompleted;
  const latestCompletion = runs.find((run) =>
    run.id === (pointer?.completion_run_id ?? w.run_id) &&
    run.purpose === "planner_takeover" && run.status === "completed",
  );
  let nextState = w.state;
  let nextStage = w.stage;
  let pending = beforePending;
  let nextAssignment = assignment;
  if ((latestCompletion || takeoverCompleted) && ["REVIEW_QUEUED", "REVIEWING", "PLANNER_TAKEOVER"].includes(w.state)) {
    flow.planner_repairs_only = true;
    nextState = "QUEUED";
    nextStage = "executor_test";
    pending = { purpose: "executor_test", review_phase: flow.phase, source_run_id: (latestCompletion ?? takeoverRun)!.id };
  } else if (w.state === "QUEUED" && assignment?.source === "quality_review" &&
      !store.get("functional_fix_intent", workflowId) &&
      (!beforePending || beforePending.purpose === "implement" || beforePending.purpose === "planner_takeover")) {
    // 规划修复已完成时接执行测试，不重复派规划接管。
    if (takeoverCompleted) {
      flow.planner_repairs_only = true;
      nextStage = "executor_test";
      pending = { purpose: "executor_test", review_phase: flow.phase, source_run_id: takeoverRun!.id };
    } else {
      const planner = flow.planner_repairs_only || completedRepair;
      nextAssignment = { ...assignment, planner };
      nextStage = planner ? "planner_takeover" : "execute";
      pending = { purpose: planner ? "planner_takeover" : "implement", review_phase: flow.phase,
        repair_kind: "quality", assignment_id: assignment.assignment_id, source_run_id: w.run_id };
    }
  }

  store.transaction(() => {
    const replacedJobs: ReturnType<Store["jobs"]> = [];
    if (pending !== beforePending) {
      for (const job of store.jobs().filter((item) => item.workflow_id === workflowId && ["dispatch", "dispatch_run"].includes(item.kind))) {
        let payload: { purpose?: string; aside_id?: string };
        try { payload = JSON.parse(job.data); } catch { continue; }
        if (payload.aside_id || (payload.purpose && !["implement", "quality_review", "planner_takeover", "executor_test"].includes(payload.purpose))) continue;
        replacedJobs.push(job);
        store.jobStatus(job.id, "cancelled");
      }
      store.put("pending_dispatch_purpose", workflowId, workflowId, pending);
      store.enqueue(workflowId, "dispatch_run", { ...pending, expected_version: w.version + 1 });
    }
    writeQualityFlow(store, flow);
    if (nextAssignment && nextAssignment !== assignment)
      store.put("repair_assignment", workflowId, workflowId, nextAssignment);
    store.put("workflow", workflowId, w.project_id, {
      ...w, state: nextState, stage: nextStage, quality_policy_version: 2,
      version: w.version + 1, updated_at: new Date().toISOString(),
    });
    store.put(MIGRATION_RECEIPT_KIND, workflowId, workflowId, {
      workflow_id: workflowId, from_policy: w.quality_policy_version ?? 1, to_policy: 2,
      from_state: w.state, from_stage: w.stage, quality_flow: flow,
      before: { workflow: w, quality_flow: beforeFlow, assignment, pending_dispatch: beforePending, replaced_jobs: replacedJobs },
      migrated_at: new Date().toISOString(),
    });
  });
  return { migrated: true, from: w.quality_policy_version ?? 1, to: 2 };
}

export function migrationReceipt(
  store: Store,
  workflowId: string,
): Record<string, unknown> | undefined {
  return store.get(MIGRATION_RECEIPT_KIND, workflowId);
}
