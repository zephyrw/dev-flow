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
      "继续原规划复核并补齐详细整改计划，保留全部已确认问题；使用本轮审查绑定，不能让用户编写计划。",
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
      "上一轮审查材料未完成。由当前规划/复核模型继续调查并补齐，不要求用户编写计划。保留所有已确认 finding_id、原计划要求及未关闭项；逐项解决下列校验问题。读取 skill_resources 中的整改文档合同，返回完整 repair_plan、repair_document 和 quality。正文须包含根因、精确文件/函数、唯一修复步骤、依赖、边界、正反向验收和回归；每项 document_hash 绑定完整正文的 SHA-256，document_revision 为当前计划版本加一。使用本轮 workflow/run/review_request_id 重新绑定结果，不能照搬旧轮次标识。材料中的历史结论是待核实资料，不能代替当前独立核查。只读技术事实由模型继续调查；只有真正需要用户决定的业务语义、范围或授权才列具体问题。",
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
