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

import { originalPlanPath, resolveMaterialLocator, readVerifiedProjectMaterial } from "./project-materials.js";
import { readMaterialFile } from "./material-filesystem.js";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { ProjectMaterial, Project, Workspace, Run } from "../../contracts/src/index.js";

// Current documents are references; older material records retain their publication fences.
export function readPlanMaterial(
  store: Store,
  workflowId: string,
  revision: number,
) {
  const record = store
    .list<PlanRecord>("plan", workflowId)
    .find((p) => p.revision === revision);
  requireCondition(record, "PLAN_MISSING", "计划版本不存在", 404);

  const planDoc = store.get<{ material_id?: string; run_id?: string; plan_revision?: number; material_status?: string }>(
    "planning_document",
    workflowId,
  );
  const currentDoc = planDoc?.plan_revision === revision ? planDoc : undefined;
  // Reference-only documents are current originals, not versioned prose copies.
  // A path alone is insufficient: require the registered document and its plan link.
  const registered = store.get<ProjectDocument>("project_document", `doc_${workflowId}_plan`);
  const effectiveMaterialPath = record.material_path ?? registered?.path;
  if (!record.material_id && !currentDoc?.material_id && registered?.path &&
      registered.workflow_id === workflowId && registered.document_type === "plan" &&
      registered.revision === revision &&
      registered.hash === "" && !registered.content &&
      effectiveMaterialPath && resolve(effectiveMaterialPath) === resolve(registered.path)) {
    requireCondition(currentDoc?.material_status !== "pending" && currentDoc?.material_status !== "conflict",
      currentDoc?.material_status === "conflict" ? "PLAN_MATERIAL_CONFLICT" : "PLAN_MATERIAL_PENDING",
      "计划原件注册尚未就绪", 409);
    const path = originalPlanPath(store, workflowId, revision);
    requireCondition(path && resolve(path) === resolve(registered.path), "PLAN_MATERIAL_CONFLICT", "计划原件引用与登记路径不一致", 409);
    const workflow = store.get<{ project_id: string }>("workflow", workflowId);
    const project = workflow && store.get<Project>("project", workflow.project_id);
    const approval = store.get<{ plan_hash: string }>("approval", `${workflowId}-${revision}`);
    const explicitPath = record.plan.design_ref?.file_ref;
    // Older multi-repository tasks can reference an approved original in the
    // parent project docs directory rather than inside either repository.
    const approvedOriginal = approval?.plan_hash === record.hash && explicitPath &&
      isAbsolute(explicitPath) && resolve(explicitPath) === resolve(path);
    const roots = [...store.list<Workspace>("workspace", workflowId).map(w => w.root),
      ...(project?.repositories ?? []).map(r => r.path),
      ...(approvedOriginal ? [dirname(path)] : [])];
    const root = roots.find(candidate => {
      const rel = relative(resolve(candidate), resolve(path));
      return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
    });
    requireCondition(root, "PATH_ESCAPE", "计划原件必须属于项目或任务工作区", 400);
    const body = readMaterialFile(root, relative(root, path).replaceAll("\\", "/"));
    requireCondition(body, "PLAN_MATERIAL_LOST", "已登记的项目计划原件已丢失", 409);
    const markdown = body.toString("utf8");
    requireCondition(markdown.trim(), "PLAN_DOCUMENT_MISSING", "计划原件正文为空", 409);
    return { ...record, markdown, path, document_path: path,
      source_type: "project" as const, authority_ready: true };
  }
  const materialId = record.material_id ?? currentDoc?.material_id;
  let material = materialId
    ? store.get<ProjectMaterial>("project_material", materialId)
    : undefined;
  requireCondition(!materialId || material || (currentDoc?.material_id === materialId && currentDoc.material_status === "pending"), "PLAN_MATERIAL_LOST", "计划关联的项目材料记录已丢失", 409);

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
    const legacyCandidates = published.filter((m) =>
      m.id === `mat_${workflowId}_plan_${revision}` || m.id === `mat_${workflowId}_plan_r${revision}`,
    );
    requireCondition(candidates.length > 0 || legacyCandidates.length <= 1, "PLAN_MATERIAL_AMBIGUOUS", "旧计划材料存在多个绑定", 409);
    material = candidates[0] ?? legacyCandidates[0];
    requireCondition(material || published.length === 0, "PLAN_MATERIAL_UNRESOLVED", "项目计划材料存在，但无法关联到生成轮次", 409);
  }
  if (material) {
    requireCondition(
      material.workflow_id === workflowId && material.kind === "plan" && material.revision === revision,
      "PLAN_MATERIAL_CONFLICT",
      "项目材料不属于该任务的计划版本",
      409,
    );
    const linkedRunId = record.run_id ?? currentDoc?.run_id;
    requireCondition(!linkedRunId || (!material.run_id && material.protocol_version !== 2) || material.run_id === linkedRunId, "PLAN_MATERIAL_CONFLICT", "项目材料生成轮次与计划不一致", 409);
  }

  let markdown: string | undefined;
  let locator: any;
  let sourceType: "project" | "result_pending" | "platform_legacy" = "project";

  if (material) {
    // F01_MATERIAL_AUTHORITY: 统一材料读取裁决：先判断材料状态
    if (material.status === "conflict") {
      // 若 material.status === 'conflict'，必须抛出 PLAN_MATERIAL_CONFLICT 错误，不得仅因磁盘文件存在就静默读取
      throw new FlowError(
        "PLAN_MATERIAL_CONFLICT",
        `项目中的计划原件发生内容冲突 (${material.path})`,
        409,
      );
    }

    if (material.status === "pending") {
      // 若 material.status === 'pending'，仅允许作为 result_pending 展示，不得视为 verified
      const document = store
        .list<ProjectDocument>("project_document", workflowId)
        .find(
          (d) =>
            d.revision === revision &&
            ["plan", "repair_plan"].includes(d.document_type) &&
            (!record.plan.design_ref?.content_hash || d.hash === record.plan.design_ref.content_hash),
        );
      markdown = document?.content ?? record.plan.markdown;
      sourceType = "result_pending";
    } else if (material.status === "verified") {
      // 若 material.status === 'verified'，校验绑定与文件存在及哈希，若文件丢失抛出 PLAN_MATERIAL_LOST
      markdown = readVerifiedProjectMaterial(store, material);
      sourceType = "project";
    } else {
      throw new FlowError(
        "PLAN_MATERIAL_CONFLICT",
        `项目材料状态异常 (${material.status})，无法读取`,
        409,
      );
    }
  } else if (currentDoc?.material_status === "pending" || currentDoc?.material_status === "conflict") {
    requireCondition(currentDoc.material_status !== "conflict", "PLAN_MATERIAL_CONFLICT", "计划材料定位或发布发生冲突", 409);
    markdown = store.list<ProjectDocument>("project_document", workflowId).find((d) => d.revision === revision && ["plan", "repair_plan"].includes(d.document_type))?.content ?? record.plan.markdown;
    sourceType = "result_pending";
  } else {
    // F04_LEGACY_READ: 在定位材料前先判断是否为真正的无材料记录历史兼容计划：
    // 若无 material 记录且没有权威绑定，不要调用 resolveMaterialLocator（避免无工作区时抛出 NO_WORKSPACES），
    // 直接进入 legacy 只读正文分支（platform_legacy）；
    // 有 material 记录或工作区时才执行文件定位。
    const hasAuthoritativeBinding = Boolean(
      record.material_id ||
      record.material_path ||
      currentDoc?.material_id ||
      record.plan.design_ref
    );

    if (!hasAuthoritativeBinding) {
      // 真正的无材料记录历史兼容计划：直接进入 legacy 只读正文分支，避免无工作区时抛出 NO_WORKSPACES
      const document = store
        .list<ProjectDocument>("project_document", workflowId)
        .find(
          (d) =>
            d.revision === revision &&
            ["plan", "repair_plan"].includes(d.document_type),
        );
      markdown = document?.content ?? record.plan.markdown;
      sourceType = "platform_legacy";
    } else {
      // A bound plan never becomes a legacy DB copy merely because its original disappeared.
      requireCondition(effectiveMaterialPath, "PLAN_MATERIAL_LOST", "已绑定计划缺少项目材料定位", 409);
      locator = resolveMaterialLocator({ store, workflowId, kind: "plan", revision, customRelPath: effectiveMaterialPath });
      const raw = readMaterialFile(locator.workspace_root, locator.relative_path);
      const expectedHash = record.plan.design_ref?.content_hash;
      const fileHash = raw ? hash(raw.toString("utf8").replace(/\r\n/g, "\n")) : undefined;
      const isFileValid = Boolean(raw) && (!expectedHash || fileHash === expectedHash);

      const currentWf = store.get<{ plan_revision: number }>("workflow", workflowId);
      const isCurrentVersion = !currentWf || currentWf.plan_revision === revision;

      if (isFileValid) {
        markdown = raw!.toString("utf8");
        sourceType = "project";
      } else if (!isCurrentVersion) {
        // 仅在历史版本上允许从快照回退供旧问答只读阅读，但不得获得当前权威资格
        const snapshot = store.get<{ content: string; hash: string }>(
          "plan_revision_content",
          `${workflowId}-${revision}`,
        );
        if (
          snapshot?.content &&
          (!expectedHash || (snapshot.hash ?? hash(snapshot.content.replace(/\r\n/g, "\n"))) === expectedHash)
        ) {
          markdown = snapshot.content;
          sourceType = "platform_legacy";
        } else {
          const document = store
            .list<ProjectDocument>("project_document", workflowId)
            .find(
              (d) =>
                d.revision === revision &&
                ["plan", "repair_plan"].includes(d.document_type),
            );
          if (document?.content && (!expectedHash || hash(document.content.replace(/\r\n/g, "\n")) === expectedHash)) {
            markdown = document.content;
            sourceType = "platform_legacy";
          }
        }
      }

      if (!markdown) {
        requireCondition(raw, "PLAN_MATERIAL_LOST", "已绑定的计划原件已丢失", 409);
        requireCondition(fileHash === expectedHash, "PLAN_DOCUMENT_HASH_MISMATCH", "计划正文与当前版本不一致", 409);
        markdown = raw!.toString("utf8");
        sourceType = "project";
      }
    }
  }

  requireCondition(
    typeof markdown === "string" && markdown.trim(),
    "PLAN_DOCUMENT_MISSING",
    "计划正文缺失，请先恢复计划文档",
    409,
  );
  requireCondition(
    !record.plan.design_ref?.content_hash ||
      hash(markdown.replace(/\r\n/g, "\n")) ===
        record.plan.design_ref.content_hash,
    "PLAN_DOCUMENT_HASH_MISMATCH",
    "计划正文与当前版本不一致",
    409,
  );
  const workspace = material && store.get<Workspace>("workspace", material.workspace_id);
  const path = locator?.absolute_path ?? (material && workspace ? resolve(workspace.root, material.path) : undefined);
  const isAuthoritative = sourceType === "project" && (material ? material.status === "verified" : Boolean(record.material_path));
  return { ...record, markdown, path, document_path: path, source_type: sourceType, authority_ready: isAuthoritative };
}

/** One authority verdict for approval and dispatch. Pending/legacy prose is display-only. */
export function assertPlanMaterialReady(store: Store, workflowId: string, revision?: number) {
  const requested = revision ?? store.get<{ plan_revision: number }>("workflow", workflowId)?.plan_revision;
  requireCondition(requested, "PLAN_MISSING", "没有可用计划版本", 409);
  const result = readPlanMaterial(store, workflowId, requested);
  requireCondition(result.authority_ready, "PLAN_MATERIAL_PENDING", "未核验的计划正文只可查看，不能审批或执行", 409);
  return result;
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
