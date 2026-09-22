import type { Engine } from "./engine.js";
import type { Store } from "../../store/src/store.js";
import {
  CONVERSATION_ENTITY,
  type ConversationAttempt,
  type ConversationNode,
  type Workflow,
} from "../../contracts/src/index.js";
import {
  CONVERSATION_CONTROL_FENCE,
  type ConversationControlFence,
} from "./conversation-control.js";

export interface ModelRetry {
  id: string;
  run_id?: string;
  plan_hash?: string;
  plan_revision: number;
  retry_at: number;
  root_id?: string;
  generation?: number;
  recovery_id?: string;
}

export interface ModelRetryBatch {
  run_id?: string;
  root_id?: string;
  generation?: number;
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

export function readRetryBatch(
  store: Store,
  workflowId: string,
  runId?: string,
): ModelRetryBatch {
  const nodes = store.list<ConversationNode>(
    CONVERSATION_ENTITY.node,
    workflowId,
  );
  const attempts = store.list<ConversationAttempt>(
    CONVERSATION_ENTITY.attempt,
    workflowId,
  );
  const root = pickActiveRoot(nodes, attempts, runId);
  const latest = root
    ? latestAttempt(attempts, root.id)
    : undefined;
  return {
    run_id: runId ?? latest?.run_id,
    root_id: root?.id,
    generation: latest?.generation,
  };
}

export function isRetryBatchCurrent(
  retry: ModelRetry,
  batch: ModelRetryBatch,
): boolean {
  if (retry.run_id && batch.run_id && retry.run_id !== batch.run_id)
    return false;
  if (retry.root_id && batch.root_id && retry.root_id !== batch.root_id)
    return false;
  if (
    retry.generation !== undefined &&
    batch.generation !== undefined &&
    retry.generation !== batch.generation
  )
    return false;
  return true;
}

export function invalidateTreeRetry(
  store: Store,
  workflowId: string,
  rootId?: string,
) {
  const retry = store.get<ModelRetry>("model_retry", workflowId);
  if (!retry) return;
  if (rootId && retry.root_id && retry.root_id !== rootId) return;
  store.remove("model_retry", workflowId);
}

export function isQuotaRetryBlocked(store: Store, retry: ModelRetry): boolean {
  const workflow = store.get<Workflow>("workflow", retry.id);
  if (!workflow) return true;
  if (workflow.state === "STOPPED" || workflow.state === "STOPPING")
    return true;
  return store
    .list<ConversationControlFence>(CONVERSATION_CONTROL_FENCE, retry.id)
    .some(
      (fence) =>
        fence.dispatch_frozen &&
        (!retry.root_id || fence.root_id === retry.root_id),
    );
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
  const batch = readRetryBatch(engine.store, key, w.run_id);
  const prior = engine.store.get<ModelRetry>("model_retry", key);
  if (prior && !isRetryBatchCurrent(prior, batch))
    engine.store.remove("model_retry", key);
  if (isQuotaRetryBlocked(engine.store, { id: key, ...batch, plan_revision: w.plan_revision, retry_at: retryAt }))
    return false;
  engine.store.put("model_retry", key, key, {
    id: key,
    run_id: batch.run_id ?? w.run_id,
    plan_hash: w.plan_hash,
    plan_revision: w.plan_revision,
    retry_at: retryAt,
    root_id: batch.root_id,
    generation: batch.generation,
    recovery_id: prior?.recovery_id,
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

function pickActiveRoot(
  nodes: ConversationNode[],
  attempts: ConversationAttempt[],
  runId?: string,
): ConversationNode | undefined {
  const roots = nodes.filter(
    (node) =>
      node.id === node.root_id &&
      node.kind !== "aside" &&
      node.purpose !== "aside",
  );
  if (runId) {
    const matched = roots.find((node) =>
      attempts.some(
        (attempt) =>
          attempt.conversation_id === node.id && attempt.run_id === runId,
      ),
    );
    if (matched) return matched;
  }
  return roots.sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
}

function latestAttempt(
  attempts: ConversationAttempt[],
  conversationId: string,
): ConversationAttempt | undefined {
  return attempts
    .filter((item) => item.conversation_id === conversationId)
    .sort((a, b) => a.generation - b.generation)
    .at(-1);
}
