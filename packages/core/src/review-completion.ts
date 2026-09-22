import type { Engine } from "./engine.js";
import {
  FlowError,
  requireCondition,
  type Workflow,
} from "../../contracts/src/index.js";
import { now, objectHash } from "./util.js";

export interface ReviewCompletion {
  fingerprint: string;
  automatic_attempts: number;
  attempts: Array<{ run_id?: string; review: unknown; reason: string }>;
  instruction: string;
  updated_at: string;
}

function fingerprint(engine: Engine, w: Workflow) {
  return objectHash({
    plan: w.plan_hash,
    revision: w.plan_revision,
    snapshot: w.snapshot_id,
    environment: w.environment_revision,
    feedback: w.feedback,
    phase: engine.store.get<{ phase: string }>("plan_check_review_intent", w.id)
      ?.phase,
    feedback_cursor: Math.max(
      0,
      ...engine.store.list<any>("feedback_message", w.id).map((m) => m.seq),
    ),
  });
}

export function reviewCompletionContext(engine: Engine, w: Workflow) {
  const value = engine.store.get<ReviewCompletion>("review_completion", w.id);
  if (!value) return null;
  return value?.fingerprint === fingerprint(engine, w) ? value : null;
}

export function seedReviewCompletion(
  engine: Engine,
  w: Workflow,
  review: unknown,
  reason: string,
) {
  engine.store.put("review_completion", w.id, w.id, {
    fingerprint: fingerprint(engine, w),
    automatic_attempts: 0,
    attempts: reviewCompletionContext(engine, w)?.attempts ?? [
      { run_id: w.run_id, review, reason },
    ],
    instruction:
      "继续代码质量审查，说明具体代码位置、原因、后果与可执行修复意见；默认接受自测说明，不核验测试真实性，不要求证明工具。",
    updated_at: now(),
  } satisfies ReviewCompletion);
}

/** Material completion belongs to the reviewer, never to the user or executor. */
export function queueReviewCompletion(
  engine: Engine,
  w: Workflow,
  review: unknown,
  error: unknown,
) {
  const current = engine.get(w.id);
  requireCondition(
    current.state === "REVIEWING" &&
      current.run_id === w.run_id &&
      !engine.store.get("run_stop", w.run_id!),
    "RUN_REVOKED",
    "审查已停止，不能自动补全",
  );
  const prior = reviewCompletionContext(engine, w);
  const reason = error instanceof Error ? error.message : String(error);
  const attempts = [
    ...(prior?.attempts ?? []),
    { run_id: w.run_id, review, reason },
  ];
  const value: ReviewCompletion = {
    fingerprint: fingerprint(engine, w),
    automatic_attempts: (prior?.automatic_attempts ?? 0) + 1,
    attempts,
    instruction:
      "上一轮审查未完成有效结论。由当前审核模型依据当前需求、批准设计及实际 diff 继续审查代码质量，给出明确 verdict 与代码问题。每项问题写清具体代码位置、触发条件、原因、后果与最小修复意见，无缺陷给出 passed。默认接受自测说明，不得核验测试真实性，不得索要测试日志、时间戳或测试证明工具。历史审查结论仅作为参考背景，不自动继承；技术事实由模型核实，确需用户决策的业务问题使用 need_user 列出。",
    updated_at: now(),
  };
  engine.store.put("review_completion", w.id, w.id, value);
  // Separate bounded material retries from the three code-quality rejections.
  if (value.automatic_attempts > 2)
    throw new FlowError(
      "REVIEW_COMPLETION_EXHAUSTED",
      "规划模型两次补全后仍未形成可执行的整改计划；已保存问题及校验详情。可重试规划复核。",
      422,
      { reason, attempts: value.automatic_attempts },
    );
  engine.transition(w.id, ["REVIEWING"], "REVIEW_QUEUED", w.stage, {
    blocker: undefined,
  });
  engine.scheduler.enqueue(w.id, w.project_id);
  engine.store.event(
    w.id,
    w.project_id,
    "ReviewCompletionQueued",
    {
      message: "规划模型正在审查。",
      attempt: value.automatic_attempts,
      reason,
    },
    w.run_id,
  );
  return engine.get(w.id);
}
