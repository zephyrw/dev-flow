import type { Engine } from "./engine.js";
import type { Store } from "../../store/src/store.js";
import { FrozenInvocationSchema, requireCondition, type Run } from "../../contracts/src/index.js";
import { ModelAccessService } from "./model-access-service.js";
import type { AccountRecoveryContinuation, AccountRecoveryRetry } from "../../contracts/src/agy-recovery.js";

export type AccountRecoveryContinuationData = AccountRecoveryContinuation;

export interface PendingModelRetry {
  retry_run_id: string;
  logical_round_id: string;
  account_recovery?: AccountRecoveryRetry["account_recovery"];
}

/** Build an identity-only retry without occupying the workflow's main queue. */
export function buildAccountModelRunRetry(
  store: Store,
  workflowId: string,
  runId: string,
  recoveryInfo?: {
    recovery_id?: string;
    continuation?: AccountRecoveryContinuationData;
    remaining_budget_ms?: number;
  },
): AccountRecoveryRetry {
  const failed = store.must<Run>("run", runId);
  requireCondition(failed.workflow_id === workflowId, "RUN_BINDING_INVALID", "重试轮次不属于当前任务");
  const original = failed.frozen_invocation ?? failed.model_binding?.frozen_invocation;
  requireCondition(failed.profile && original?.adapterId === "agy", "RUN_BINDING_INVALID", "账号恢复缺少原轮冻结模型配置");
  const native = new ModelAccessService(store).resolveNativeConfig(failed.profile);
  const frozen = FrozenInvocationSchema.parse({
    ...original,
    accountScope: native.accountFingerprint,
    providerScope: native.providerEndpointFingerprint,
    identityConfidence: native.identityConfidence,
  });
  return {
    retry_run_id: failed.id,
    logical_round_id: failed.logical_round_id ?? failed.model_binding?.logical_round_id ?? failed.id,
    account_recovery: {
      recovery_id: recoveryInfo?.recovery_id,
      frozen_invocation: frozen,
      continuation: recoveryInfo?.continuation,
      remaining_budget_ms: recoveryInfo?.remaining_budget_ms,
    },
  };
}

/** Account recovery changes identity only; the original run remains immutable. */
export function stageAccountModelRunRetry(
  store: Store,
  workflowId: string,
  runId: string,
  recoveryInfo?: Parameters<typeof buildAccountModelRunRetry>[3],
): AccountRecoveryRetry {
  const pending = buildAccountModelRunRetry(store, workflowId, runId, recoveryInfo);
  store.put("pending_model_retry", workflowId, workflowId, pending);
  return pending;
}

export function assertAccountModelRetryAccess(store: Store, workflowId: string, sourceRunId?: string): boolean {
  const pending = store.get<PendingModelRetry>("pending_model_retry", workflowId);
  if (!pending?.account_recovery || (sourceRunId !== undefined && pending.retry_run_id !== sourceRunId)) return false;
  const source = store.must<Run>("run", pending.retry_run_id);
  requireCondition(source.workflow_id === workflowId && source.profile, "RUN_BINDING_INVALID", "账号恢复缺少原轮工具配置");
  const mas = new ModelAccessService(store);
  mas.assertFrozenAccess(source.profile, pending.account_recovery.frozen_invocation);
  return true;
}

export function stageModelRunRetry(store: Store, workflowId: string, runId: string) {
  const failed = store.must<Run>("run", runId);
  requireCondition(failed.workflow_id === workflowId, "RUN_BINDING_INVALID", "重试轮次不属于当前任务");
  store.put("pending_model_retry", workflowId, workflowId, {
    retry_run_id: failed.id,
    logical_round_id: failed.logical_round_id ?? failed.id,
  });
}
export interface ModelRetry {
  id: string;
  run_id?: string;
  plan_hash?: string;
  plan_revision: number;
  retry_at: number;
  logical_round_id?: string;
  assignment_id?: string;
  routing_role?: string;
}
export function quotaRetryAt(message: string, observedAt = Date.now()) {
  const match = /resets? in\s*(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?/i.exec(
    message,
  );
  if (!match) return null;
  const seconds =
    Number(match[1] ?? 0) * 3600 +
    Number(match[2] ?? 0) * 60 +
    Number(match[3] ?? 0);
  return seconds > 0 && seconds <= 7 * 86400
    ? observedAt + (seconds + 60) * 1000
    : null;
}
export function scheduleModelRetry(
  engine: Engine,
  key: string,
  message: string,
  observedAt = Date.now(),
) {
  const w = engine.get(key),
    retryAt = quotaRetryAt(message, observedAt);
  if (w.state !== "BLOCKED" || w.blocker?.code !== "MODEL_QUOTA" || !retryAt)
    return false;
  const failed = w.run_id
    ? engine.store.get<{
        logical_round_id?: string;
        assignment_id?: string;
        routing_role?: string;
      }>("run", w.run_id)
    : undefined;
  engine.store.put("model_retry", key, key, {
    id: key,
    run_id: w.run_id,
    plan_hash: w.plan_hash,
    plan_revision: w.plan_revision,
    retry_at: retryAt,
    logical_round_id: failed?.logical_round_id,
    assignment_id: failed?.assignment_id,
    routing_role: failed?.routing_role,
  } satisfies ModelRetry);
  engine.store.event(
    key,
    w.project_id,
    "ModelRetryScheduled",
    {
      retry_at: retryAt,
      message: "模型额度暂时不足，已按提供方的恢复时间安排自动继续。",
    },
    w.run_id,
  );
  return true;
}
