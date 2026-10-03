import type { Store } from "../../store/src/store.js";
import { hash, now } from "./util.js";
import { requireCondition } from "../../contracts/src/index.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { originalPlanPath, resolveMaterialLocator } from "./project-materials.js";

export interface ProjectDocument {
  id: string;
  workflow_id: string;
  document_type: "plan" | "repair_plan" | "design" | "architecture";
  revision: number;
  hash: string;
  /** Hydrated response only. Historical records may still contain this field. */
  content: string;
  path?: string;
  anchor_map?: Record<string, string>;
  approved_by_human?: boolean;
  approval_receipt?: { approved_at: string; request_id: string; feedback_cursor: number };
  created_at: string;
  updated_at: string;
}
export interface ApproveDocumentRequest {
  request_id: string;
  expected_version: number;
  document_revision?: number;
  document_hash?: string;
  feedback_cursor: number;
}

/** Documents belong to the project. Store references, never revision copies. */
export class DocumentService {
  constructor(private store: Store, private storageRoot: string = process.cwd()) {}

  publishDocument(workflowId: string, documentType: ProjectDocument["document_type"], content: string,
    revision?: number, documentPath?: string, updateOriginal = false): ProjectDocument {
    const existing = this.store.list<ProjectDocument>("project_document", workflowId)
      .filter(d => d.document_type === documentType).sort((a, b) => b.revision - a.revision)[0];
    let path = documentType === "plan" ? originalPlanPath(this.store, workflowId) : existing?.path;
    if (!path && documentPath && isAbsolute(documentPath)) path = resolve(documentPath);
    if (!path) {
      const locator = resolveMaterialLocator({ store: this.store, workflowId,
        kind: documentType === "plan" ? "plan" : "repair", customRelPath: documentPath,
        revision: revision ?? 1 });
      path = locator.absolute_path;
      if (!documentPath && (documentType === "design" || documentType === "architecture"))
        path = resolve(dirname(path), documentType + ".md");
    }
    // Existing originals may contain user/model progress; registration cannot replace them.
    if (!existsSync(path)) {
      requireCondition(content.trim().length > 0, "EMPTY_DOCUMENT", "文档正文不能为空", 400);
      mkdirSync(dirname(path), { recursive: true });
      try { writeFileSync(path, content.replace(/\r\n/g, "\n"), { encoding: "utf8", flag: "wx" }); }
      catch (error: any) { if (error?.code !== "EEXIST") throw error; }
    } else if (updateOriginal) {
      requireCondition(content.trim().length > 0, "EMPTY_DOCUMENT", "文档正文不能为空", 400);
      if (existsSync(path) && existing?.revision && revision && revision > existing.revision) {
        try {
          const oldContent = readFileSync(path, "utf8");
          this.store.put("plan_revision_content", `${workflowId}-${existing.revision}`, workflowId, {
            workflow_id: workflowId,
            revision: existing.revision,
            content: oldContent,
            hash: hash(oldContent.replace(/\r\n/g, "\n")),
          });
        } catch {}
      }
      writeFileSync(path, content.replace(/\r\n/g, "\n"), "utf8");
    }
    const metadata = {
      id: `doc_${workflowId}_${documentType}`, workflow_id: workflowId, document_type: documentType,
      revision: revision ?? existing?.revision ?? 1, path, hash: "",
      approved_by_human: existing?.approved_by_human ?? false,
      approval_receipt: existing?.approval_receipt,
      created_at: existing?.created_at ?? now(), updated_at: now(),
    };
    this.store.put("project_document", metadata.id, workflowId, metadata);
    return this.hydrate(metadata as ProjectDocument);
  }

  private hydrate(doc: ProjectDocument): ProjectDocument {
    const currentPath = doc.document_type === "plan" ? originalPlanPath(this.store, doc.workflow_id) : undefined;
    const path = currentPath ?? doc.path;
    if (path) {
      requireCondition(existsSync(path), "DOCUMENT_NOT_FOUND", "项目文档原件不存在：" + path, 404);
      const content = readFileSync(path, "utf8");
      return { ...doc, path, content, hash: hash(content.replace(/\r\n/g, "\n")) };
    }
    // Read-only rescue for pre-reference records; never write cached text back.
    requireCondition(typeof doc.content === "string", "DOCUMENT_NOT_FOUND", "未找到项目文档原件", 404);
    return doc;
  }

  getDocument(workflowId: string, documentType: string, _revision?: number): ProjectDocument {
    const docs = this.store.list<ProjectDocument>("project_document", workflowId);
    const exact = docs.find(d => d.id === documentType);
    const matched = exact ?? docs.find(d => d.id === `doc_${workflowId}_${documentType}`) ??
      docs.filter(d => d.document_type === documentType).sort((a, b) => b.revision - a.revision)[0];
    requireCondition(matched, "DOCUMENT_NOT_FOUND", `未找到文档: ${documentType}`, 404);
    return this.hydrate(matched);
  }

  approveDocument(workflowId: string, documentId: string, req: ApproveDocumentRequest): ProjectDocument {
    const doc = this.store.get<ProjectDocument>("project_document", documentId);
    requireCondition(doc && doc.workflow_id === workflowId, "DOCUMENT_NOT_FOUND", "审批的文档不存在", 404);
    const current = this.hydrate(doc);
    const { content: _content, anchor_map: _anchors, ...metadata } = current;
    const approved = { ...metadata, hash: "", approved_by_human: true,
      approval_receipt: { approved_at: now(), request_id: req.request_id, feedback_cursor: req.feedback_cursor }, updated_at: now() };
    this.store.put("project_document", doc.id, workflowId, approved);
    return { ...approved, content: current.content, hash: current.hash };
  }

  // Legacy integrations may call this; document versions/prose are no longer workflow gates.
  verifyRepairPlanWithDocument(_workflowId: string, _repairPlan: Array<{
    document_revision: number; document_hash: string; document_anchor: string;
  }>): { valid: boolean; reason?: string } { return { valid: true }; }
}
