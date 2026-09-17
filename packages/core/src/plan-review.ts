import { z } from "zod";
import { Id, requireCondition } from "../../contracts/src/index.js";
import { WorkspaceReferenceSchema } from "../../contracts/src/feedback.js";
import { AsideSessionService } from "../../asides/src/service.js";
import type { Store } from "../../store/src/store.js";
import type { Engine, PlanRecord } from "./engine.js";
import type { ProjectDocument } from "./document-service.js";
import { FeedbackService } from "./feedback-service.js";
import { hash } from "./util.js";

const PlanFeedbackSchema = z.object({
  request_id: Id,
  plan_revision: z.number().int().positive(),
  plan_hash: z.string().min(1),
  text: z.string().trim().min(1, "请填写具体内容").max(20000),
  refs: z.array(WorkspaceReferenceSchema).default([]),
});
export const RejectPlanSchema = PlanFeedbackSchema.extend({
  expected_version: z.number().int().positive(),
}).strict();
export const PlanQuestionSchema = PlanFeedbackSchema.strict();

// Native plans store their full prose in a versioned document, not in the contract.
export function readPlanMaterial(
  store: Store,
  workflowId: string,
  revision: number,
) {
  const record = store
    .list<PlanRecord>("plan", workflowId)
    .find((p) => p.revision === revision);
  requireCondition(record, "PLAN_MISSING", "计划版本不存在", 404);
  const document = store
    .list<ProjectDocument>("project_document", workflowId)
    .find(
      (d) =>
        d.revision === revision &&
        ["plan", "repair_plan"].includes(d.document_type) &&
        (!record.plan.design_ref ||
          d.hash === record.plan.design_ref.content_hash),
    );
  const markdown = document?.content ?? record.plan.markdown;
  requireCondition(
    typeof markdown === "string" && markdown.trim(),
    "PLAN_DOCUMENT_MISSING",
    "计划正文缺失，请先恢复计划文档",
    409,
  );
  requireCondition(
    !record.plan.design_ref ||
      hash(markdown.replace(/\r\n/g, "\n")) ===
        record.plan.design_ref.content_hash,
    "PLAN_DOCUMENT_HASH_MISMATCH",
    "计划正文与当前版本不一致",
    409,
  );
  return { ...record, markdown };
}

export class PlanReviewService {
  constructor(private engine: Engine) {}

  private current(key: string, revision: number, hash: string) {
    const w = this.engine.get(key);
    requireCondition(
      w.plan_revision === revision && w.plan_hash === hash,
      "PLAN_CHANGED",
      "计划已更新，请关闭窗口并查看最新计划后再操作",
      409,
    );
    return w;
  }

  reject(key: string, input: unknown) {
    const body = RejectPlanSchema.parse(input);
    return this.engine.store.deduplicate(
      `reject-plan:${key}:${body.request_id}`,
      body,
      () => {
        const w = this.current(key, body.plan_revision, body.plan_hash);
        requireCondition(
          w.version === body.expected_version,
          "VERSION_CONFLICT",
          "工作流已变化，请关闭窗口并查看最新计划后再操作",
          409,
        );
        requireCondition(
          ["PLAN_PENDING", "REPAIR_PLAN_PENDING"].includes(w.state),
          "INVALID_STATE",
          "只有待批准的计划可以驳回",
          409,
        );
        const message = new FeedbackService(this.engine.store).submitFeedback({
          request_id: body.request_id,
          workflow_id: key,
          kind: "planning",
          text: body.text,
          refs: body.refs,
          target_document_revision: body.plan_revision,
        });
        const workflow = this.engine.queueFormalFeedback(
          key,
          message.message_id,
        );
        this.engine.store.event(key, w.project_id, "UserGuidance", {
          action: "reject_plan",
          text: body.text,
          status: "received",
          plan_revision: body.plan_revision,
          plan_hash: body.plan_hash,
          feedback_id: message.message_id,
        });
        return { workflow, message };
      },
    );
  }

  question(key: string, input: unknown) {
    const body = PlanQuestionSchema.parse(input);
    return this.engine.store.deduplicate(
      `plan-question:${key}:${body.request_id}`,
      body,
      () => {
        this.current(key, body.plan_revision, body.plan_hash);
        readPlanMaterial(this.engine.store, key, body.plan_revision);
        return new AsideSessionService(this.engine.store).submitQuestion(
          key,
          body.text,
          body.refs,
          undefined,
          { plan_revision: body.plan_revision, plan_hash: body.plan_hash },
        );
      },
    );
  }
}
