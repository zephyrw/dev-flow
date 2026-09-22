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
  if (w.state === "COMPLETED" || w.state === "STOPPED") {
    return { migrated: false, reason: "terminal_readonly" };
  }

  // 已进入实际 Git 提交/集成中的任务按原操作完成，不迁入新用途。
  if (w.state === "COMMITTING" || w.state === "INTEGRATING" || w.state === "COMMITTED") {
    return { migrated: false, reason: "git_operation_in_flight" };
  }

  const runs = store.list<{ id: string; purpose?: string; status?: string }>(
    "run",
    workflowId,
  );
  const active = runs.find(
    (r) => r.status === "running" || r.status === "executing",
  );
  // 正在执行模型 Run 的旧任务不改其冻结用途；该 Run 结束后在下一派发边界迁移。
  if (active) return { migrated: false, reason: "active_run_frozen" };

  const flow = createQualityFlow(workflowId);
  const reviewIntent = store.get<{ phase?: QualityFlowPhase }>(
    "plan_check_review_intent",
    workflowId,
  );
  const assignment = store.get<{
    planner?: boolean;
    phase?: QualityFlowPhase;
    source?: string;
  }>("repair_assignment", workflowId);
  const takeover = runs.find(
    (r) => r.purpose === "planner_takeover" && r.status === "completed",
  );
  const repairDone = runs.some(
    (r) =>
      r.purpose === "implement" &&
      r.status === "completed" &&
      assignment &&
      assignment.planner === false &&
      assignment.source === "quality_review",
  );
  const functionalReady = store.get("functional_retest_ready", workflowId);
  const humanIssues = store
    .list<{ status?: string }>("functional_issue", workflowId)
    .some((i) =>
      ["ready_for_retest", "open", "queued", "fixing"].includes(i.status ?? ""),
    );

  if (reviewIntent?.phase === "after_human") {
    flow.phase = "after_human";
    flow.planner_repairs_only = true;
  }
  if (w.state === "HUMAN_PENDING" || w.state === "HUMAN_VERIFY" || functionalReady) {
    // 等待人工功能验收 / 功能修复已完成待人复测 → 保留人的问题状态
    if (humanIssues || functionalReady) {
      flow.phase = "before_human";
    }
  }
  if (takeover || assignment?.planner === true) {
    flow.planner_repairs_only = true;
  }
  if (repairDone) {
    flow.executor_repair_completed = true;
  }
  // 已有至少一次整改后复核失败 → 改为规划修复
  if (flow.executor_repair_completed && w.state === "REVIEW_QUEUED") {
    flow.planner_repairs_only = true;
  }

  store.transaction(() => {
    writeQualityFlow(store, flow);
    store.put("workflow", workflowId, w.project_id ?? "global", {
      ...w,
      quality_policy_version: 2,
    });
    store.put(MIGRATION_RECEIPT_KIND, workflowId, workflowId, {
      workflow_id: workflowId,
      from_policy: w.quality_policy_version ?? 1,
      to_policy: 2,
      from_state: w.state,
      from_stage: w.stage,
      quality_flow: flow,
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
