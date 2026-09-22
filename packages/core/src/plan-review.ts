import { z } from "zod";
import { Id, requireCondition, FlowError } from "../../contracts/src/index.js";
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

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveMaterialLocator } from "./project-materials.js";
import type { ProjectMaterial, Workspace, Run } from "../../contracts/src/index.js";

// Native plans store their full prose in project materials or versioned documents, not in the contract.
export function readPlanMaterial(
  store: Store,
  workflowId: string,
  revision: number,
) {
  const record = store
    .list<PlanRecord>("plan", workflowId)
    .find((p) => p.revision === revision);
  requireCondition(record, "PLAN_MISSING", "计划版本不存在", 404);

  const planDoc = store.get<{ material_id?: string; run_id?: string; plan_revision?: number }>(
    "planning_document",
    workflowId,
  );
  const currentDoc = planDoc?.plan_revision === revision ? planDoc : undefined;
  const materialId = record.material_id ?? currentDoc?.material_id;
  let material = materialId
    ? store.get<ProjectMaterial>("project_material", materialId)
    : undefined;
  requireCondition(!materialId || material, "PLAN_MATERIAL_LOST", "计划关联的项目材料记录已丢失", 409);

  // 兼容尚未保存 material_id 的规划结果。Run 记录的是输入版本 N，产物属于 N+1。
  if (!material) {
    const published = store.list<ProjectMaterial>("project_material", workflowId)
      .filter((m) => m.kind === "plan" && m.revision === revision);
    const linkedRunId = record.run_id ?? currentDoc?.run_id;
    const planningRunIds = linkedRunId
      ? [linkedRunId]
      : store.list<Run>("run", workflowId)
          .filter((r) => r.plan_revision + 1 === revision && r.status === "completed" &&
            (r.purpose === "planning" || r.stage === "planning"))
          .map((r) => r.id);
    let candidates = published.filter((m) => planningRunIds.some(
      (runId) => m.id === `mat_${workflowId}_plan_r${revision}_run_${runId}`,
    ));
    const expectedHash = record.plan.design_ref?.content_hash;
    if (expectedHash && candidates.length > 0) {
      candidates = candidates.filter((m) => m.source_hash === expectedHash);
      requireCondition(candidates.length > 0, "PLAN_MATERIAL_CONFLICT", "项目材料与该计划版本不一致", 409);
    }
    requireCondition(candidates.length <= 1, "PLAN_MATERIAL_AMBIGUOUS", "该计划版本存在多个材料来源，不能自动选择", 409);
    material = candidates[0] ?? published.find((m) =>
      m.id === `mat_${workflowId}_plan_${revision}` || m.id === `mat_${workflowId}_plan_r${revision}`,
    );
    requireCondition(material || published.length === 0, "PLAN_MATERIAL_UNRESOLVED", "项目计划材料存在，但无法关联到生成轮次", 409);
  }
  if (material) {
    requireCondition(
      material.workflow_id === workflowId && material.kind === "plan" && material.revision === revision,
      "PLAN_MATERIAL_CONFLICT",
      "项目材料不属于该任务的计划版本",
      409,
    );
  }

  let markdown: string | undefined;
  let sourceType: "project" | "result_pending" | "platform_legacy" = "project";

  // 解析目标项目文件路径
  let targetPath: string | undefined;
  if (material) {
    const ws = store.get<Workspace>("workspace", material.workspace_id);
    requireCondition(ws && ws.workflow_id === workflowId, "WORKSPACE_NOT_FOUND", "项目计划所属工作区不存在", 409);
    targetPath = join(ws.root, material.path);
  }
  if (!targetPath) {
    const locator = resolveMaterialLocator({
      store,
      workflowId,
      kind: "plan",
      revision,
    });
    targetPath = locator.absolute_path;
  }

  // 核验原件
  if (targetPath && existsSync(targetPath)) {
    const raw = readFileSync(targetPath, "utf8");
    const norm = raw.replace(/\r\n/g, "\n");
    const currentHash = hash(record.plan.design_ref ? norm : raw);

    const expectedHash = record.plan.design_ref?.content_hash ?? material?.source_hash;
    if (expectedHash && currentHash !== expectedHash) {
      throw new FlowError(
        "PLAN_MATERIAL_CONFLICT",
        `项目中的计划原件已被修改 (预期: ${expectedHash.slice(0, 8)}, 当前: ${currentHash.slice(0, 8)})，发生原件冲突`,
        409,
      );
    }
    markdown = raw;
    sourceType = "project";
  } else if (material?.status === "pending") {
    // 项目原件未发布成功但属于本轮生成 (result_pending)
    const document = store
      .list<ProjectDocument>("project_document", workflowId)
      .find(
        (d) =>
          d.revision === revision &&
          ["plan", "repair_plan"].includes(d.document_type) &&
          (!record.plan.design_ref || d.hash === record.plan.design_ref.content_hash),
      );
    markdown = document?.content ?? record.plan.markdown;
    sourceType = "result_pending";
  } else if (material) {
    // CW3-F12 / CW4-F03: 已存在材料记录但磁盘文件丢失或冲突，禁止以平台缓存掩盖！
    if (material.status === "conflict") {
      throw new FlowError(
        "PLAN_MATERIAL_CONFLICT",
        `项目中的计划原件发生内容冲突 (${material.path})`,
        409,
      );
    }
    throw new FlowError(
      "PLAN_MATERIAL_LOST",
      `已发布的项目计划原件已丢失 (${material.path})，禁止以平台缓存掩盖`,
      409,
    );
  } else {
    // 确无任何项目材料记录的历史计划才保留缓存兼容
    const document = store
      .list<ProjectDocument>("project_document", workflowId)
      .find(
        (d) =>
          d.revision === revision &&
          ["plan", "repair_plan"].includes(d.document_type) &&
          (!record.plan.design_ref || d.hash === record.plan.design_ref.content_hash),
      );
    markdown = document?.content ?? record.plan.markdown;
    sourceType = "platform_legacy";
  }

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
  return { ...record, markdown, source_type: sourceType };
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
