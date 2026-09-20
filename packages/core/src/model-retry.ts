import type { Engine } from "./engine.js";
import type { Store } from "../../store/src/store.js";
import { requireCondition, type Run } from "../../contracts/src/index.js";

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
