import { execFileSync } from "node:child_process";
import type { Engine } from "../../core/src/engine.js";
import { FlowError, requireCondition } from "../../contracts/src/index.js";
import type { Lease } from "../../scheduler/src/scheduler.js";
import { now } from "../../core/src/util.js";
import type { OperationRequest } from "../../core/src/interactions.js";
import { assertAccountModelRetryAccess, stageModelRunRetry, type ModelRetry } from "../../core/src/model-retry.js";
import type { LocalRuntime } from "./runtime.js";
import { prepareRepairResume } from "../../core/src/repair.js";
import {
  BEFORE_HUMAN_REVIEW_STAGE,
  PLAN_SELF_CHECK_STAGE,
} from "../../core/src/plan-self-check.js";

import {
  clearWaitingContext,
  isCurrentPlanningSource,
  isOpenPlanningHandoff,
  isPlanningWaiting,
  readPlanningHandoff,
  readRunContinuation,
  readWaitingContext,
  savePlanningHandoff,
  waitingBelongsToRun,
} from "../../core/src/waiting-context.js";
import type { WaitingContext } from "../../core/src/waiting-context.js";
import type { Workflow } from "../../contracts/src/index.js";


type InterruptionRecord = {
  prior_state?: string;
  prior_stage?: string;
  prior_purpose?: string;
  prior_run_id?: string;
  review_phase?: string;
  repair_batch_id?: string;
  logical_round_id?: string;
  run_id?: string;
};

export function resolveResumeTarget(engine: Engine, key: string) {
  const w = engine.get(key);
  const interruption =
    engine.store.get<InterruptionRecord>("interruption", key) ??
    (w.run_id
      ? engine.store.get<InterruptionRecord>("run_stop", w.run_id)
      : undefined);
  const run = interruption?.prior_run_id
    ? engine.store.get<{ purpose?: string; stage?: string; repair_batch_id?: string }>(
        "run",
        interruption.prior_run_id,
      )
    : w.run_id
      ? engine.store.get<{ purpose?: string; stage?: string; repair_batch_id?: string }>(
          "run",
          w.run_id,
        )
      : undefined;
  const priorState = interruption?.prior_state;
  const purpose = interruption?.prior_purpose ?? run?.purpose;
  const stage = interruption?.prior_stage ?? run?.stage ?? w.stage;
  const reviewPhase =
    interruption?.review_phase ??
    engine.store.get<{ phase?: string }>("plan_check_review_intent", key)
      ?.phase;
  if (priorState === "HUMAN_PENDING" || stage === "functional_retest" || stage === "accept") {
    return {
      state: "HUMAN_PENDING" as const,
      stage: stage || "accept",
      enqueue: false,
    };
  }
  if (priorState === "PLANNING" || purpose === "planning" || stage === "planning") {
    return { state: "PLANNING" as const, stage: "planning", enqueue: true };
  }
  if (purpose === "plan_self_check" || stage === PLAN_SELF_CHECK_STAGE) {
    return {
      state: "QUEUED" as const,
      stage: PLAN_SELF_CHECK_STAGE,
      enqueue: true,
    };
  }
  if (
    priorState === "REVIEWING" ||
    priorState === "REVIEW_QUEUED" ||
    purpose === "quality_review" ||
    stage === "review" ||
    stage === BEFORE_HUMAN_REVIEW_STAGE
  ) {
    const phase = reviewPhase === "after_human" ? "after_human" : "before_human";
    engine.store.put("plan_check_review_intent", key, key, {
      ...engine.store.get<Record<string, unknown>>("plan_check_review_intent", key), phase,
    });
    return {
      state: "REVIEW_QUEUED" as const,
      stage: phase === "before_human" ? BEFORE_HUMAN_REVIEW_STAGE : "review",
      enqueue: true,
    };
  }
  if (
    priorState === "EXECUTING" ||
    priorState === "QUEUED" ||
    priorState === "VERIFYING" ||
    priorState === "BLOCKED" ||
    purpose === "implement" ||
    purpose === "functional_fix" ||
    purpose === "planner_takeover"
  ) {
    return {
      state: "QUEUED" as const,
      stage:
        purpose === "planner_takeover" || stage === "planner_takeover"
          ? "planner_takeover"
          : "execute",
      enqueue: true,
    };
  }
  if (["QUEUED", "REVIEW_QUEUED", "PLANNING"].includes(w.state)) {
    return { state: w.state, stage: w.stage, enqueue: true };
  }
  if (w.state === "BLOCKED" || w.state === "STOPPED" || w.state === "RECOVERY_REQUIRED") {
    if (stage === "review" || stage === BEFORE_HUMAN_REVIEW_STAGE) {
      return {
        state: "REVIEW_QUEUED" as const,
        stage,
        enqueue: true,
      };
    }
    if (stage === "planning") {
      return { state: "PLANNING" as const, stage: "planning", enqueue: true };
    }
    if (stage === PLAN_SELF_CHECK_STAGE) {
      return {
        state: "QUEUED" as const,
        stage: PLAN_SELF_CHECK_STAGE,
        enqueue: true,
      };
    }
    return { state: "QUEUED" as const, stage: "execute", enqueue: true };
  }
  throw new FlowError(
    "RESUME_TARGET_AMBIGUOUS",
    "无法唯一判定继续开发还是继续审查，请选择后继续",
    409,
  );
}

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
    if (retry.retry_at > at) continue;
    active.add(retry.id);
    try {
      await engine.waitForIdle(retry.id);
      const runtime = engine.runtime as LocalRuntime | undefined;
      await runtime?.browser?.reconcile(retry.id);
      await runtime?.environments?.stop(retry.id);
      if (!valid()) continue;
      if (retry.run_id) stageModelRunRetry(engine.store, retry.id, retry.run_id);
      resumeApproved(engine, retry.id, { autoRetry: true });
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
  });
  return results;
}
export function resumeApproved(
  engine: Engine,
  key: string,
  options: { autoRetry?: boolean } = {},
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
  if (!options.autoRetry) {
    // A missing authorization pauses account recovery without changing its model.
    // Explicit user stop/model-switch already removes this pending retry.
    if (!w.run_id || !assertAccountModelRetryAccess(engine.store, key, w.run_id))
      engine.store.remove("pending_model_retry", key);
    engine.store.remove("transient_network_retry", key);
  }
  engine.store.remove("model_retry", key);
  const waiting = readWaitingContext(engine.store, key);
  const resumedWaiting = resumeWaitingIfCurrent(engine, key, w, waiting);
  if (resumedWaiting) return resumedWaiting;
  const target = resolveResumeTarget(engine, key);
  assertResumePreconditions(engine, key, target);
  const restored = engine.restoreFailedRole(key, "用户恢复执行");
  if (restored) return restored;
  if (target.state === "QUEUED") {
    prepareRepairResume(engine, key);
    engine.stageExecuteContinuation(key);
  }
  engine.transition(key, [w.state], target.state, target.stage, {
    blocker: undefined,
    ...(target.state === "PLANNING" ? { run_id: undefined } : {}),
  });
  if (target.enqueue) engine.scheduler.enqueue(key, w.project_id);
  return engine.get(key);
}

function assertResumePreconditions(
  engine: Engine,
  key: string,
  target: ReturnType<typeof resolveResumeTarget>,
) {
  if (target.state === "PLANNING") {
    engine.project(engine.get(key).project_id);
    return;
  }
  if (target.state === "HUMAN_PENDING") return;
  engine.assertProjectConfiguration(key);
  const w = engine.get(key);
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

function resumeWaitingIfCurrent(
  engine: Engine,
  key: string,
  w: Workflow,
  waiting: WaitingContext | undefined,
) {
  if (!waiting) return;
  const continuation = readRunContinuation(engine.store, key);
  const currentRun = w.run_id
    ? engine.store.get<{
        continuation?: import("../../contracts/src/tr-handoff.js").RunContinuation;
        stage?: string;
        purpose?: string;
      }>("run", w.run_id)
    : undefined;
  const belongs = waitingBelongsToRun(
    waiting,
    w.run_id,
    currentRun?.continuation ?? continuation,
  );
  const planningSource = isCurrentPlanningSource({
    handoff: readPlanningHandoff(engine.store, key),
    waiting,
    state: w.state,
    blockerCode: w.blocker?.code,
    runId: w.run_id,
    run: currentRun,
  });
  if (isPlanningWaiting(waiting) && !planningSource) {
    archiveStalePlanning(engine, key, waiting);
    return;
  }
  if (!belongs && !planningSource) return;
  assertResumePreconditions(engine, key, {
    state: isPlanningWaiting(waiting) ? "PLANNING" : waiting.purpose === "review" ? "REVIEW_QUEUED" : "QUEUED",
    stage: waiting.purpose,
    enqueue: true,
  });
  engine.store.remove("model_retry", key);
  return engine.resumeFromWaiting(key, "用户恢复执行", waiting);
}

function archiveStalePlanning(
  engine: Engine,
  key: string,
  waiting: WaitingContext,
) {
  const handoff = readPlanningHandoff(engine.store, key);
  if (isOpenPlanningHandoff(handoff)) {
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
