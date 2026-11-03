import { UserInteractionInputSchema } from "../../contracts/src/user-interaction.js";
import { normalizeExecutionIntent, type NormalizedExecution } from "./round-intent.js";

export const EXECUTION_CONTINUE_INSTRUCTION =
  "继续按照已批准的原计划完成当前执行阶段尚未完成的全部任务。沿用原会话上下文核对已有成果，从剩余项接着执行；保留已完成成果，不重复未受影响的验证。阶段总结不代表任务完成，不跳过后续审查、人工审批或验收，不扩大权限。" +
  "全部完成返回 completed；仍有可继续任务返回 incomplete，附 completed_items 和 unfinished_items，使用原计划编号；确实需要用户操作或决策时返回 need_user，附具体 user_interaction；需要规划调整时返回 need_planner。";

export const EXECUTION_CLARIFY_INSTRUCTION =
  "请核对刚才的阶段总结和原会话中当前阶段的任务，只补充结束原因，不重新开发、测试或执行其他操作。" +
  "还有可自行继续的任务时返回 incomplete，附已完成项 completed_items 和剩余项 unfinished_items，使用原计划编号；当前阶段全部完成才返回 completed。" +
  "确实需要用户操作或决策时返回 need_user，并在 user_interaction 中说明具体卡点、用户操作和恢复条件；需规划调整时返回 need_planner。用户要求暂停或已确认外部阻塞时保持等待，不能把本次核对当作用户授权。";

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function owners(payload: Record<string, unknown>): Record<string, unknown>[] {
  const nested = record(payload.delivery);
  return nested ? [payload, nested] : [payload];
}

/** Preserve questions even when optional target/choice fields are malformed. */
export function hasExecutionUserRequest(payload: Record<string, unknown>): boolean {
  return owners(payload).some(owner => {
    if (Array.isArray(owner.unresolved_questions) && owner.unresolved_questions.some(text)) return true;
    const interaction = record(owner.user_interaction);
    if (!interaction) return false;
    if (UserInteractionInputSchema.safeParse(interaction).success) return true;
    return !!text(interaction.question) ||
      (["question", "action_required"].includes(String(interaction.kind)) && !!text(interaction.message));
  });
}

function hasConflictingStatuses(payload: Record<string, unknown>): boolean {
  const intents = owners(payload).flatMap(owner => [owner.status, owner.verdict])
    .map(text).filter((status): status is string => !!status)
    .map(status => normalizeExecutionIntent({ status }).intent);
  return new Set(intents).size > 1;
}

/** This only routes declared results; it never certifies work or scans source files. */
export function executionContinuationDecision(
  normalized: NormalizedExecution,
  parse?: { kind: string; reason?: string },
): "continue" | "clarify" | undefined {
  if (parse?.kind === "ambiguous" || hasConflictingStatuses(normalized.payload)) return;
  if (normalized.intent === "completed") {
    return owners(normalized.payload).some(owner =>
      Array.isArray(owner.unfinished_items) && owner.unfinished_items.length > 0)
      ? "clarify" : undefined;
  }
  if (hasExecutionUserRequest(normalized.payload)) return;
  if (normalized.intent === "incomplete") return "continue";
  if (normalized.intent === "need_user" || normalized.intent === "unclear") return "clarify";
  return;
}

/** Stable task identifiers, not changing summaries, are the progress signal. */
export function executionProgressItems(payload: Record<string, unknown>): string[] {
  return [...new Set(owners(payload).flatMap(owner =>
    Array.isArray(owner.completed_items) ? owner.completed_items : [])
    .map(item => text(item) ?? text(record(item)?.id) ?? text(record(item)?.task_id))
    .filter((id): id is string => !!id))].sort();
}
