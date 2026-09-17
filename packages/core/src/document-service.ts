import type { Store } from "../../store/src/store.js";
import { canonical, hash, id, now, objectHash } from "./util.js";
import { FlowError, requireCondition } from "../../contracts/src/index.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface ProjectDocument {
  id: string;
  workflow_id: string;
  document_type: "plan" | "repair_plan" | "design" | "architecture";
  revision: number;
  hash: string;
  content: string;
  anchor_map?: Record<string, string>;
  approved_by_human?: boolean;
  approval_receipt?: {
    approved_at: string;
    request_id: string;
    feedback_cursor: number;
  };
  created_at: string;
  updated_at: string;
}

export interface ApproveDocumentRequest {
  request_id: string;
  expected_version: number;
  document_revision: number;
  document_hash: string;
  feedback_cursor: number;
}

export class DocumentService {
  constructor(
    private store: Store,
    private storageRoot: string = process.cwd(),
  ) {}

  /**
   * 保存或发布项目文档新修订版本 (RQ-07, RQ-08)
   */
  publishDocument(
    workflowId: string,
    documentType: "plan" | "repair_plan" | "design" | "architecture",
    content: string,
    revision?: number,
  ): ProjectDocument {
    requireCondition(
      content.trim().length > 0,
      "EMPTY_DOCUMENT",
      "文档正文不能为空",
      400,
    );

    const docId = `doc_${workflowId}_${documentType}`;
    const allDocs = this.store.list<ProjectDocument>(
      "project_document",
      workflowId,
    );
    const existing = allDocs.filter((d) => d.document_type === documentType);
    const nextRevision =
      revision ??
      (existing.length > 0
        ? Math.max(...existing.map((d) => d.revision)) + 1
        : 1);

    const normContent = content.replace(/\r\n/g, "\n");
    const docHash = hash(normContent);

    // 解析 markdown anchor (例如 ## 标题 -> #标题)
    const anchorMap: Record<string, string> = {};
    const headerRegex = /^(#{1,6})\s+(.+)$/gm;
    let match: RegExpExecArray | null;
    while ((match = headerRegex.exec(normContent)) !== null) {
      const title = match[2]!.trim();
      const anchor = `#${title.toLowerCase().replace(/\s+/g, "-")}`;
      anchorMap[anchor] = title;
    }

    const doc: ProjectDocument = {
      id: `${docId}_r${nextRevision}`,
      workflow_id: workflowId,
      document_type: documentType,
      revision: nextRevision,
      hash: docHash,
      content: normContent,
      anchor_map: anchorMap,
      approved_by_human: false,
      created_at: now(),
      updated_at: now(),
    };

    // 持久化文档实体
    this.store.put("project_document", doc.id, workflowId, doc);

    // 同步落盘本地 docs 目录备份
    try {
      const docDir = join(
        this.storageRoot,
        "documents",
        workflowId,
        `r${nextRevision}`,
      );
      mkdirSync(docDir, { recursive: true });
      writeFileSync(join(docDir, `${documentType}.md`), normContent, "utf8");
    } catch {}

    return doc;
  }

  /**
   * 获取指定版本文档
   */
  getDocument(
    workflowId: string,
    documentType: string,
    revision?: number,
  ): ProjectDocument {
    const allDocs = this.store.list<ProjectDocument>(
      "project_document",
      workflowId,
    );
    const matched = allDocs.filter((d) => d.document_type === documentType);
    requireCondition(
      matched.length > 0,
      "DOCUMENT_NOT_FOUND",
      `未找到文档: ${documentType}`,
      404,
    );

    if (revision !== undefined) {
      const target = matched.find((d) => d.revision === revision);
      requireCondition(
        target,
        "DOCUMENT_REVISION_NOT_FOUND",
        `未找到文档版本 r${revision}`,
        404,
      );
      return target!;
    }

    // 默认返回最新修订版本
    matched.sort((a, b) => b.revision - a.revision);
    return matched[0]!;
  }

  /**
   * 严格核验并审批文档 (RQ-08, 第 5.2 节)
   */
  approveDocument(
    workflowId: string,
    documentId: string,
    req: ApproveDocumentRequest,
  ): ProjectDocument {
    const doc = this.store.get<ProjectDocument>("project_document", documentId);
    requireCondition(
      doc && doc.workflow_id === workflowId,
      "DOCUMENT_NOT_FOUND",
      "审批的文档不存在",
      404,
    );

    requireCondition(
      doc.revision === req.document_revision,
      "VERSION_CONFLICT",
      `文档版本不一致: 期望 r${req.document_revision}, 当前 r${doc.revision}`,
      409,
    );

    requireCondition(
      doc.hash === req.document_hash,
      "HASH_MISMATCH",
      "审批文档的 Hash 与服务器当前版本不一致，正文已被修改",
      409,
    );

    // 幂等防重：若已以相同 request_id 批准，直接返回
    if (
      doc.approved_by_human &&
      doc.approval_receipt?.request_id === req.request_id
    ) {
      return doc;
    }

    doc.approved_by_human = true;
    doc.approval_receipt = {
      approved_at: now(),
      request_id: req.request_id,
      feedback_cursor: req.feedback_cursor,
    };
    doc.updated_at = now();

    this.store.put("project_document", doc.id, workflowId, doc);
    return doc;
  }

  /**
   * 校验整改项与当前文档正文一致性 (RQ-07)
   */
  verifyRepairPlanWithDocument(
    workflowId: string,
    repairPlan: Array<{
      document_revision: number;
      document_hash: string;
      document_anchor: string;
    }>,
  ): { valid: boolean; reason?: string } {
    if (!repairPlan || repairPlan.length === 0) {
      return { valid: false, reason: "整改项列表为空" };
    }

    const docType = "repair_plan";
    const allDocs = this.store.list<ProjectDocument>(
      "project_document",
      workflowId,
    );
    const repairDocs = allDocs.filter((d) => d.document_type === docType);

    if (repairDocs.length === 0) {
      return {
        valid: false,
        reason: "未在当前工作流中找到已发布的整改文档 (repair_plan)",
      };
    }

    for (const item of repairPlan) {
      const doc = repairDocs.find((d) => d.revision === item.document_revision);
      if (!doc) {
        return {
          valid: false,
          reason: `整改项引用的文档版本 r${item.document_revision} 不存在`,
        };
      }
      if (item.document_hash !== "none" && doc.hash !== item.document_hash) {
        return { valid: false, reason: `整改项引用的文档 Hash 不一致` };
      }
      if (
        item.document_anchor &&
        doc.anchor_map &&
        !doc.anchor_map[item.document_anchor]
      ) {
        // 如果 anchor 没精确命中，检查正文是否包含该 anchor 标识
        const rawAnchor = item.document_anchor.replace(/^#/, "");
        if (!doc.content.toLowerCase().includes(rawAnchor.toLowerCase())) {
          return {
            valid: false,
            reason: `整改项引用的文档章节锚点不存在: ${item.document_anchor}`,
          };
        }
      }
    }

    return { valid: true };
  }
}
