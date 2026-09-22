import { execFileSync } from "node:child_process";
import type { Engine } from "../../core/src/engine.js";
import {
  CONVERSATION_ENTITY,
  FlowError,
  requireCondition,
  type ConversationNode,
  type Run,
  type Workflow,
} from "../../contracts/src/index.js";
import type { Lease } from "../../scheduler/src/scheduler.js";
import { now } from "../../core/src/util.js";
import type { OperationRequest } from "../../core/src/interactions.js";
import {
  isQuotaRetryBlocked,
  isRetryBatchCurrent,
  readRetryBatch,
  type ModelRetry,
} from "../../core/src/model-retry.js";
import type { LocalRuntime } from "./runtime.js";
import { CliDispatchManager } from "./cli-dispatch.js";
import { prepareRepairResume } from "../../core/src/repair.js";
import { reconcileMaterialOutbox } from "../../core/src/project-materials.js";
import { ConversationService } from "../../core/src/conversation-service.js";
import {
  ConversationControlService,
  type StopPort,
} from "../../core/src/conversation-control.js";
import {
  ConversationRecovery,
  storeRecoveryRunPort,
  type RecoveryArrangement,
} from "./conversation-recovery.js";
import {
  clearWaitingContext,
  isPlanningWaiting,
  readPlanningHandoff,
  readRunContinuation,
  readWaitingContext,
  savePlanningHandoff,
  waitingBelongsToRun,
} from "../../core/src/waiting-context.js";
import type { WaitingContext } from "../../core/src/waiting-context.js";

const noopStopPort: StopPort = {
  async stopConversation() {
    return { accepted: false, confirmation: "unknown" };
  },
};

const resuming = new WeakMap<Engine, Set<string>>();
export async function resumeModelWaits(engine: Engine, at = Date.now()) {
  let active = resuming.get(engine);
  if (!active) resuming.set(engine, (active = new Set()));
  for (const retry of engine.store.list<ModelRetry>("model_retry")) {
    if (active.has(retry.id)) continue;
    const valid = () => {
      const w = engine.get(retry.id);
      return (
        w.state === "BLOCKED" &&
        w.blocker?.code === "MODEL_QUOTA" &&
        w.run_id === retry.run_id &&
        w.plan_hash === retry.plan_hash &&
        w.plan_revision === retry.plan_revision
      );
    };
    if (!valid()) {
      engine.store.remove("model_retry", retry.id);
      continue;
    }
    if (isQuotaRetryBlocked(engine.store, retry)) {
      engine.store.remove("model_retry", retry.id);
      continue;
    }
    const batch = readRetryBatch(engine.store, retry.id, retry.run_id);
    if (!isRetryBatchCurrent(retry, batch)) {
      engine.store.remove("model_retry", retry.id);
      continue;
    }
    if (retry.retry_at > at) continue;
    active.add(retry.id);
    try {
      await engine.waitForIdle(retry.id);
      const runtime = engine.runtime as LocalRuntime | undefined;
      await runtime?.browser?.reconcile(retry.id);
      await runtime?.environments?.stop(retry.id);
      if (!valid()) continue;
      if (isQuotaRetryBlocked(engine.store, retry)) continue;
      arrangeConversationRecovery(engine, retry.id, "quota_retry");
      resumeApproved(engine, retry.id, "quota_retry");
      engine.store.remove("model_retry", retry.id);
      engine.store.event(
        retry.id,
        engine.get(retry.id).project_id,
        "ModelRetryStarted",
        { message: "已到预计额度恢复时间，正在继续原任务。" },
      );
      void engine.dispatch();
    } catch (error) {
      engine.store.remove("model_retry", retry.id);
      engine.block(retry.id, error);
    } finally {
      active.delete(retry.id);
    }
  }
}
export function reconcileProcesses(engine: Engine, key: string) {
  const w = engine.get(key);
  requireCondition(
    [
      "RECOVERY_REQUIRED",
      "BLOCKED",
      "STOPPED",
      "COMMIT_PARTIAL",
      "WAITING_AUTHORIZATION",
      "WAITING_INPUT",
    ].includes(w.state),
    "INVALID_STATE",
    "当前不能进行恢复对账",
  );
  const records = engine.store.list<{
    id: string;
    status: string;
    confirmed?: boolean;
  }>("process_record", key);
  const results = records
    .filter((record) => !(record.status === "exited" && record.confirmed))
    .map((record) => {
      const result = JSON.parse(
        execFileSync(engine.config.host.executable, ["job-status", record.id], {
          encoding: "utf8",
          windowsHide: true,
          timeout: 10000,
          env: {
            ...process.env,
            DOTNET_ROOT:
              process.env.DOTNET_ROOT ?? process.cwd() + "/.cache/dotnet",
          },
        }),
      );
      requireCondition(
        result.id === record.id && !result.alive,
        "PROCESS_STILL_ACTIVE",
        `受管进程 ${record.id} 尚未退出`,
      );
      return result;
    });
  const leases = engine.store.list<Lease>("lease", key);
  requireCondition(
    !leases.some((l) => l.id === "browser:shared"),
    "BROWSER_RECONCILIATION_REQUIRED",
    "浏览器租约需要先检查并关闭本轮创建的标签页",
  );
  requireCondition(
    records.length > 0 || !leases.some((l) => l.status === "suspect"),
    "PROCESS_RECORD_MISSING",
    "缺少旧运行的进程登记，不能凭租约超时释放资源",
  );
  engine.store.transaction(() => {
    engine.store.remove("check_lock", key);
    for (const operation of engine.store.list<OperationRequest>(
      "operation_request",
      key,
    )) {
      if (operation.status !== "running") continue;
      engine.store.put("operation_request", operation.id, key, {
        ...operation,
        status: "failed",
        result: {
          error: "OPERATION_INTERRUPTED",
          message:
            "操作执行期间中断，退出结果未保存。先检查实际效果；原授权已消费，重试必须重新申请授权。",
          outcome_unknown: true,
        },
      });
      engine.invalidate(key, "已授权操作中断");
      engine.store.event(key, w.project_id, "OperationInterrupted", {
        request_id: operation.id,
      });
    }
    for (const record of records)
      engine.store.put("process_record", record.id, key, {
        ...record,
        status: "exited",
        confirmed: true,
        reconciled_at: now(),
      });
    for (const lease of leases)
      engine.scheduler.release(key, lease.run_id, [lease.id], true);
    const env = engine.store.get<Record<string, unknown>>("environment", key);
    if (env)
      engine.store.put("environment", key, key, { ...env, status: "stopped" });
    engine.store.event(key, w.project_id, "ProcessesReconciled", { results });
    const dispatchMgr = new CliDispatchManager(engine.store);
    dispatchMgr.reconcileDispatch(key);
    reconcileMaterialOutbox(engine.store, key);
  });
  return results;
}
export function resumeApproved(
  engine: Engine,
  key: string,
  source: "user_resume" | "quota_retry" | "manual_handoff" | "migration" = "user_resume",
) {
  reconcileProcesses(engine, key);
  const w = engine.get(key);
  requireCondition(
    !engine.store
      .list<{ status: string }>("operation_request", key)
      .some((r) => r.status === "pending"),
    "AUTHORIZATION_PENDING",
    "先在工作台批准或拒绝待授权操作，再继续执行",
  );
  requireCondition(
    w.state !== "COMMIT_PARTIAL",
    "COMMIT_RECOVERY_REQUIRED",
    "部分提交只能重试原提交，不能启动开发",
  );
  const waiting = readWaitingContext(engine.store, key);
  const recoveryReason =
    source === "quota_retry"
      ? "quota_retry"
      : source === "user_resume"
        ? "user_resume"
        : "service_recovery";
  const arranged = arrangeConversationRecovery(engine, key, recoveryReason);
  if (!isPlanningRecovery(engine, key, w, waiting, arranged)) {
    const approval = engine.store.get<{ plan_hash: string }>(
      "approval",
      `${key}-${w.plan_revision}`,
    );
    requireCondition(
      approval?.plan_hash === w.plan_hash,
      "PLAN_NOT_APPROVED",
      "当前计划未获批准",
    );
  }

  // CW2-F12 / CW3-F06: 严格区分来源，自动恢复严禁解除用户原因 (workflow_pause)
  const dispatchMgr = new CliDispatchManager(engine.store);
  if (source === "user_resume") {
    dispatchMgr.removeControlReason(key, "workflow_pause");
  } else if (source === "migration") {
    dispatchMgr.removeControlReason(key, "migration");
  }

  const control = dispatchMgr.getDispatchControl(key);
  requireCondition(
    !control.reasons.some((r) => r.reason === "migration"),
    "MIGRATION_IN_PROGRESS",
    "工作流仍有未完成的资产迁移，禁止恢复执行",
    409,
  );
  if (!control.dispatch_enabled) {
    const reasons = control.reasons.map((r) => r.message || r.reason).join("; ");
    throw new FlowError("DISPATCH_DISABLED", `无法恢复执行: ${reasons || "调度已停用"}`, 409);
  }

  const current = resumeWaitingIfCurrent(engine, key, w, waiting);
  if (current) return current;
  const routed = routeArrangedResume(engine, key, w, arranged);
  if (routed) return routed;
  if (isPlanningRecovery(engine, key, w, waiting, arranged)) {
    engine.store.remove("model_retry", key);
    const next = engine.transition(key, [w.state], "PLANNING", "planning", {
      blocker: undefined,
    });
    engine.store.enqueue(key, "dispatch_run", { purpose: "planning" });
    return next;
  }
  prepareRepairResume(engine, key);
  engine.invalidate(key, "用户恢复执行，旧证据失效");
  engine.store.remove("model_retry", key);
  engine.transition(key, [w.state], "QUEUED", "execute", {
    blocker: undefined,
  });
  engine.scheduler.enqueue(key, w.project_id);
  return engine.get(key);
}

function arrangeConversationRecovery(
  engine: Engine,
  key: string,
  reason: "user_resume" | "quota_retry" | "service_recovery",
): RecoveryArrangement | undefined {
  const session = openConversationRecovery(engine, key);
  if (!session) return undefined;
  session.recovery.assertResumeReady(key, session.request);
  const arranged = session.recovery.commitArrangement(key, session.request, {
    reason,
  });
  session.controls.resumeTree(key, session.request);
  return arranged;
}

function openConversationRecovery(engine: Engine, key: string) {
  const nodes = engine.store.list<ConversationNode>(
    CONVERSATION_ENTITY.node,
    key,
  );
  if (!nodes.length) return undefined;
  const conversations = new ConversationService(engine.store);
  const controls = new ConversationControlService(
    engine.store,
    conversations,
    noopStopPort,
  );
  const recovery = new ConversationRecovery({
    store: engine.store,
    conversations,
    controls,
    runPort: storeRecoveryRunPort(engine.store),
  });
  const tree = conversations.getTree(key);
  const rootId = tree.active_root_id;
  if (!rootId) return undefined;
  const generation =
    tree.attempts
      .filter((item) => item.conversation_id === rootId)
      .sort((a, b) => a.generation - b.generation)
      .at(-1)?.generation ?? 0;
  return {
    recovery,
    controls,
    request: {
      request_id: `recover-${key}-${rootId}-${generation}`,
      action: "resume" as const,
      root_id: rootId,
      expected_generation: generation,
    },
  };
}

function isPlanningRecovery(
  engine: Engine,
  key: string,
  w: Workflow,
  waiting: WaitingContext | undefined,
  arranged?: RecoveryArrangement,
) {
  if (arranged?.planning_only || arranged?.purpose === "planning") return true;
  if (
    w.state === "PLANNING" ||
    w.state === "PLAN_PENDING" ||
    w.state === "REPAIR_PLAN_PENDING" ||
    w.state === "RESEARCHING"
  )
    return true;
  const run = w.run_id
    ? engine.store.get<{ purpose?: string; stage?: string }>("run", w.run_id)
    : undefined;
  if (run?.purpose === "planning" || run?.stage === "planning") return true;
  if (
    waiting &&
    isPlanningWaiting(waiting) &&
    isCurrentPlanningSource(engine, key, w, waiting)
  )
    return true;
  return isStoppedUnapprovedPlanning(engine, key, w);
}

function isStoppedUnapprovedPlanning(engine: Engine, key: string, w: Workflow) {
  const interruption = engine.store.get<{ prior_stage?: string }>(
    "interruption",
    key,
  );
  const prior = interruption?.prior_stage;
  if (!["planning", "plan_approval", "research"].includes(prior ?? ""))
    return false;
  const approval = engine.store.get<{ plan_hash: string }>(
    "approval",
    `${key}-${w.plan_revision}`,
  );
  return !w.plan_hash || approval?.plan_hash !== w.plan_hash;
}

function routeArrangedResume(
  engine: Engine,
  key: string,
  w: Workflow,
  arranged?: RecoveryArrangement,
) {
  if (!arranged) return;
  engine.store.remove("model_retry", key);
  if (arranged.planning_only || arranged.purpose === "planning") {
    const next = engine.transition(key, [w.state], "PLANNING", "planning", {
      blocker: undefined,
    });
    engine.store.enqueue(key, "dispatch_run", { purpose: "planning" });
    return next;
  }
  if (
    arranged.purpose === "quality_review" ||
    arranged.waiting_purpose === "review"
  ) {
    const stage =
      arranged.phase === "before_human" ? "quality_before_human" : "review";
    const next = engine.transition(key, [w.state], "REVIEW_QUEUED", stage, {
      blocker: undefined,
    });
    engine.scheduler.enqueue(key, w.project_id);
    engine.store.enqueue(key, "dispatch", {});
    return next;
  }
}

function resumeWaitingIfCurrent(
  engine: Engine,
  key: string,
  w: Workflow,
  waiting: WaitingContext | undefined,
) {
  if (!waiting) return;
  const continuation = readRunContinuation(engine.store, key);
  const currentRun = w.run_id
    ? engine.store.get<Run>("run", w.run_id)
    : undefined;
  const belongs = waitingBelongsToRun(
    waiting,
    w.run_id,
    currentRun?.continuation ?? continuation,
  );
  const planningSource = isCurrentPlanningSource(engine, key, w, waiting);
  if (isPlanningWaiting(waiting) && !planningSource) {
    archiveStalePlanning(engine, key, waiting);
    return;
  }
  if (!belongs && !planningSource) return;
  engine.store.remove("model_retry", key);
  return engine.resumeFromWaiting(key, "用户恢复执行", waiting);
}

function isCurrentPlanningSource(
  engine: Engine,
  key: string,
  w: Workflow,
  waiting: WaitingContext,
) {
  const handoff = readPlanningHandoff(engine.store, key);
  const open =
    !!handoff && ["pending", "assigned"].includes(handoff.status);
  if (!open && !isPlanningWaiting(waiting)) return false;
  if (w.state === "PLANNING" || w.blocker?.code === "NEED_PLANNER") return true;
  const run = w.run_id
    ? engine.store.get<{ stage?: string; purpose?: string }>("run", w.run_id)
    : undefined;
  if (run?.stage === "planning" || run?.purpose === "planning") return true;
  if (open && handoff.target_run_id && handoff.target_run_id === w.run_id)
    return true;
  return false;
}

function archiveStalePlanning(
  engine: Engine,
  key: string,
  waiting: WaitingContext,
) {
  const handoff = readPlanningHandoff(engine.store, key);
  if (handoff && ["pending", "assigned"].includes(handoff.status)) {
    const stale =
      waiting.run_id === handoff.source_run_id ||
      waiting.source_execution_run_id === handoff.source_run_id ||
      !waiting.run_id;
    if (stale)
      savePlanningHandoff(engine.store, key, {
        ...handoff,
        status: "superseded",
      });
  }
  if (isPlanningWaiting(waiting)) clearWaitingContext(engine.store, key);
}
