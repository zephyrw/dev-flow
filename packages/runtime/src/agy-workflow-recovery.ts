import type { AccountCommittedEvent } from "../../agy-accounts/src/index.js";
import type { ActiveManagedRun } from "./agy-workflow-bridge.js";
import type { Store } from "../../store/src/store.js";
import type {
  AgySourceCheckpoint,
  AgyRecoveryManifest,
  AgyRecoveryProgress,
  AccountRecoveryContinuation,
  RecoveryDecision,
  RecoveryProgressState,
} from "../../contracts/src/agy-recovery.js";
import type { AgyRecoveryCheckpointManager } from "./agy-recovery-checkpoint.js";
import { FlowError, type Run } from "../../contracts/src/index.js";
import { createHash } from "node:crypto";

export interface RecoveryPlan {
  recovery_id: string;
  workflow_id: string;
  manifest_id: string;
  source_run_id?: string;
  target_run_id?: string;
  target_account_id: string;
  target_auth_epoch: number;
  decision: RecoveryDecision;
  state: RecoveryProgressState;
  tasks_to_resume: string[];
  continuation?: AccountRecoveryContinuation;
}

export class AgyWorkflowRecoveryCoordinator {
  async planRecovery(
    event: AccountCommittedEvent,
    affectedRuns: ActiveManagedRun[],
    store?: Store,
    checkpointManager?: AgyRecoveryCheckpointManager,
  ): Promise<RecoveryPlan[]> {
    const plans: RecoveryPlan[] = [];

    for (const affected of affectedRuns) {
      const recoveryId = `rec_${affected.run_id}_${event.auth_epoch}`;
      const manifestId = `${event.operation_id}:${affected.run_id}:root`;
      const logicalWorkId = "root";

      // 1. 读取原 Run 信息 (Q06 修复：仅从源 Run 读取真实 CLI 会话 ID，不用业务 ID 冒充)
      const runRecord = store?.get<Run>("run", affected.run_id);
      const originalConversationId =
        runRecord?.conversation_id ??
        (runRecord as any)?.original_conversation_id;

      // 2. 预算计算 (Q05 修复：等待时间不扣除执行预算，沿用已有冻结剩余值)
      const now = Date.now();
      const sourceCheckpointId = `chk_src_${affected.run_id}_${affected.auth_epoch}`;
      let sourceCheckpoint = checkpointManager?.getSourceCheckpoint(sourceCheckpointId);

      const startedAt = runRecord?.started_at ? Date.parse(runRecord.started_at) : now;
      const deadlineAt = runRecord?.deadline_at ?? now + 300_000;
      const totalBudgetMs = Math.max(0, deadlineAt - startedAt);
      const executionConsumedMs = runRecord?.ended_at
        ? Math.max(0, Date.parse(runRecord.ended_at) - startedAt)
        : Math.max(0, now - startedAt);
      const remainingMs = sourceCheckpoint?.budget?.remaining_ms !== undefined
        ? sourceCheckpoint.budget.remaining_ms
        : Math.max(0, totalBudgetMs - executionConsumedMs);
      const consumedMs = Math.max(0, totalBudgetMs - remainingMs);

      const recreationPolicy: "exact_only" | "recreate_after_confirmed_unavailable" =
        (runRecord as any)?.recreation_policy ?? "exact_only";

      // 3. 构建或获取 source checkpoint
      if (!sourceCheckpoint && store && runRecord) {
        sourceCheckpoint = {
          checkpoint_id: sourceCheckpointId,
          workflow_id: affected.workflow_id,
          source_run_id: affected.run_id,
          source_account_id: affected.account_id,
          source_auth_epoch: affected.auth_epoch,
          frozen_invocation: runRecord.frozen_invocation ?? {
            schema_version: 1,
            adapterId: "agy",
            executable: "agy",
            modelToken: affected.effective_model_id ?? "unknown",
            effortArgs: [],
            effortEnv: {},
            transport: "flag",
            reasoning: { mode: "native-default" },
            providerScope: "provider_default",
            accountScope: affected.account_id,
            identityConfidence: "account",
            capabilityRevision: "rev_1",
            runtimeFlavor: "legacy-agy-native",
            accessModelKey: affected.effective_model_id ?? "unknown",
          },
          profile_id: typeof runRecord.profile === "string" ? runRecord.profile : runRecord.profile?.id,
          purpose: runRecord.purpose,
          logical_round: 0,
          original_conversation_id: originalConversationId,
          child_ids: [],
          control_generation: 0,
          plan_revision: 1,
          policy_revision: affected.account_policy_revision ?? 1,
          recreation_policy: recreationPolicy,
          budget: {
            execution_budget_ms: totalBudgetMs,
            consumed_ms: consumedMs,
            remaining_ms: remainingMs,
            frozen_at: new Date(now).toISOString(),
          },
          created_at: new Date(now).toISOString(),
        };
        if (sourceCheckpoint) {
          checkpointManager?.saveSourceCheckpoint(sourceCheckpoint);
        }
      }

      // 4. 决策状态机 (轻量化：本地会话有会话 ID 则续接，无则新 Run 重试；预算充足均允许恢复)
      let decision: RecoveryDecision = "exact_resume";
      let state: RecoveryProgressState = "resume_pending";

      if (remainingMs <= 0) {
        decision = "manual_required";
        state = "manual_required";
      } else if (originalConversationId) {
        decision = "exact_resume";
        state = "resume_pending";
      } else {
        decision = "recreate_root";
        state = "recreate_pending";
      }

      // 5. 保存恢复清单
      if (checkpointManager) {
        const manifest: AgyRecoveryManifest = {
          manifest_id: manifestId,
          operation_id: event.operation_id,
          source_checkpoint_id: sourceCheckpointId,
          source_run_id: affected.run_id,
          logical_work_id: logicalWorkId,
          target_account_id: event.account_id,
          target_auth_epoch: event.auth_epoch,
          recreation_policy: recreationPolicy,
          created_at: new Date(now).toISOString(),
        };
        try {
          checkpointManager.saveRecoveryManifest(manifest);
        } catch {
          /* idempotent */
        }

        const progress: AgyRecoveryProgress = {
          recovery_id: recoveryId,
          manifest_id: manifestId,
          operation_id: event.operation_id,
          source_run_id: affected.run_id,
          revision: 1,
          decision,
          state,
          reason: "account_switch",
          started_at: new Date(now).toISOString(),
        };
        try {
          checkpointManager.saveRecoveryProgress(progress, affected.workflow_id);
        } catch {
          /* idempotent */
        }
      }

      // 6. 生成显式续接参数 (AccountRecoveryContinuation)
      let continuation: AccountRecoveryContinuation | undefined;
      const isExecutable =
        (decision === "exact_resume" || decision === "recreate_root") &&
        state !== "manual_required" &&
        remainingMs > 0;

      if (isExecutable) {
        const frozenDigest = createHash("sha256")
          .update(JSON.stringify(sourceCheckpoint?.frozen_invocation ?? {}))
          .digest("hex");

        continuation = {
          recovery_id: recoveryId,
          manifest_revision: 1,
          decision,
          original_conversation_id: originalConversationId,
          source_account_id: affected.account_id,
          source_auth_epoch: affected.auth_epoch,
          target_account_id: event.account_id,
          target_auth_epoch: event.auth_epoch,
          frozen_invocation_digest: frozenDigest,
          remaining_budget_ms: remainingMs,
        };

        if (store) {
          // 初始按源 Run 主键保存 continuation (R01)
          store.put(
            "account_recovery_continuation",
            affected.run_id,
            affected.workflow_id,
            continuation,
          );
        }
      }

      plans.push({
        recovery_id: recoveryId,
        workflow_id: affected.workflow_id,
        manifest_id: manifestId,
        source_run_id: affected.run_id,
        target_run_id: undefined,
        target_account_id: event.account_id,
        target_auth_epoch: event.auth_epoch,
        decision,
        state,
        tasks_to_resume: isExecutable ? [affected.run_id] : [],
        continuation,
      });
    }

    return plans;
  }

  async cancelRecovery(options: {
    workflowId: string;
    recoveryId: string;
    requestId?: string;
    expectedRevision?: number;
    store: Store;
    checkpointManager: AgyRecoveryCheckpointManager;
    engine?: any;
    processManager?: any;
  }): Promise<{ success: boolean; progress: AgyRecoveryProgress }> {
    let progress =
      options.checkpointManager.getRecoveryProgress(options.recoveryId) ??
      options.checkpointManager
        .listRecoveryProgressForWorkflow(options.workflowId)
        .find((p) => p.recovery_id === options.recoveryId);

    if (!progress) {
      throw new FlowError("NOT_FOUND", `恢复目标 ${options.recoveryId} 不存在`, 404);
    }

    // Ownership, request deduplication and revision checks apply before either cancellation path.
    const manifest = options.checkpointManager.getRecoveryManifest(progress.manifest_id);
    const sourceRunId = progress.source_run_id;
    const targetRunId = progress.target_run_id;
    const sourceRun = options.store.get<Run>("run", sourceRunId);
    const run = targetRunId ? options.store.get<Run>("run", targetRunId) : undefined;
    const sourceCheckpoint = manifest
      ? options.checkpointManager.getSourceCheckpoint(manifest.source_checkpoint_id)
      : undefined;
    if ((!sourceRun && !sourceCheckpoint) ||
        (sourceRun && sourceRun.workflow_id !== options.workflowId) ||
        (run && run.workflow_id !== options.workflowId) ||
        (sourceCheckpoint && sourceCheckpoint.workflow_id !== options.workflowId) ||
        (manifest && manifest.source_run_id !== sourceRunId)) {
      throw new FlowError("FORBIDDEN", "该恢复目标不属于指定工作流", 403);
    }

    // 请求去重：同 requestId + 相同操作已处理直接返回 (CR28 修复)
    if (options.requestId) {
      const priorReq = options.store.get<{ request_id: string; result: any }>(
        "agy_recovery_cancel_request",
        `${options.recoveryId}:${options.requestId}`,
      );
      if (priorReq) {
        return priorReq.result;
      }
    }

    // revision CAS
    if (
      options.expectedRevision !== undefined &&
      progress.revision !== options.expectedRevision
    ) {
      throw new FlowError("REVISION_CONFLICT", "恢复进度版本冲突", 409);
    }

    // 状态终态检查
    if (progress.state === "superseded" && progress.reason === "user_cancelled") {
      return { success: true, progress };
    }
    if (["completed", "superseded"].includes(progress.state)) {
      return { success: false, progress };
    }

    const clearOwnedContinuation = (runId: string) => {
      const continuation = options.store.get<AccountRecoveryContinuation>("account_recovery_continuation", runId);
      if (continuation?.recovery_id === options.recoveryId)
        options.store.remove("account_recovery_continuation", runId);
    };
    const clearOwnedWait = (key: string) => {
      const wait = options.store.get<{ run_id: string; operation_id: string }>("agy_account_wait", key);
      if (wait?.run_id === sourceRunId && wait.operation_id === progress!.operation_id)
        options.store.remove("agy_account_wait", key);
    };
    const saveResult = (success: boolean) => {
      const result = { success, progress: progress! };
      options.checkpointManager.saveRecoveryProgress(progress!, options.workflowId);
      if (options.requestId) options.store.put(
        "agy_recovery_cancel_request", `${options.recoveryId}:${options.requestId}`, options.workflowId,
        { request_id: options.requestId, result },
      );
      return result;
    };

    if (!targetRunId) {
      if (!options.engine?.cancelQueuedAccountRecovery)
        throw new FlowError("RECOVERY_CANCEL_UNAVAILABLE", "调度器无法撤销待派发的恢复", 503);
      return options.store.transaction(() => {
        options.engine.cancelQueuedAccountRecovery(options.workflowId, options.recoveryId, sourceRunId);
        clearOwnedContinuation(sourceRunId);
        clearOwnedWait(sourceRunId);
        clearOwnedWait(options.workflowId);
        progress = { ...progress!, state: "superseded", reason: "user_cancelled",
          revision: progress!.revision + 1, completed_at: new Date().toISOString() };
        return saveResult(true);
      });
    }

    // Let the scheduler own both process stopping and terminal Run reconciliation.
    if (!run) throw new FlowError("RECOVERY_TARGET_MISSING", "恢复目标运行记录不存在", 409);
    if (!options.engine?.cancelAccountRecoveryTarget)
      throw new FlowError("RECOVERY_CANCEL_UNAVAILABLE", "调度器无法停止该恢复运行", 503);
    const cancelRes = await options.engine.cancelAccountRecoveryTarget(
      options.recoveryId, targetRunId, progress.revision,
    );

    progress = options.checkpointManager.getRecoveryProgress(options.recoveryId) ?? progress;

    if (cancelRes.stopped === false && !["completed", "superseded"].includes(progress.state)) {
      return { success: false, progress, stopping: true } as any;
    }

    if (progress.state !== "completed" && progress.state !== "superseded") {
      progress.state = cancelRes.state === "completed" ? "completed" : "superseded";
      progress.reason = cancelRes.state === "completed" ? "run_completed" : "user_cancelled";
      progress.revision++;
      progress.completed_at = new Date().toISOString();
    }
    clearOwnedContinuation(targetRunId);
    clearOwnedContinuation(sourceRunId);
    clearOwnedWait(sourceRunId);
    clearOwnedWait(options.workflowId);
    return saveResult(progress.state === "superseded" && progress.reason === "user_cancelled");
  }
}
