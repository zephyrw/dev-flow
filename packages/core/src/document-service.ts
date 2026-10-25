import type { Store } from "../../store/src/store.js";
import { hash, now } from "./util.js";
import { requireCondition } from "../../contracts/src/index.js";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { originalPlanPath, resolveMaterialLocator } from "./project-materials.js";
import { publishMaterialFile, readMaterialFile, replaceMaterialFile } from "./material-filesystem.js";
import { safePath } from "../../workspace/src/files.js";

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
  original_authority?: { revision: number; hash: string; path: string };
}
export interface ApproveDocumentRequest {
  request_id: string;
  expected_version: number;
  document_revision?: number;
  document_hash?: string;
  feedback_cursor: number;
}

const samePath = (a: string, b: string) => process.platform === "win32"
  ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
export interface DocumentVersion { path?: string; hash?: string }

/** The external exception authorizes exactly one registered, previously approved original. */
export function documentLocation(store: Store, workflowId: string, path: string, doc?: ProjectDocument) {
  try {
    const locator = resolveMaterialLocator({ store, workflowId, kind: "plan", customRelPath: path, projectOriginal: true });
    const canonical = safePath(locator.workspace_root, locator.relative_path, true);
    // Keep the registered spelling (including Windows short directory names).
    // Only filesystem access uses the validated canonical relative path.
    return { root: locator.workspace_root, relative: relative(realpathSync.native(locator.workspace_root), canonical).replaceAll("\\", "/"), path: resolve(path) };
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "PATH_ESCAPE")) throw error;
    const wf = store.get<any>("workflow", workflowId);
    const record = store.get<any>("plan", `${workflowId}-${wf?.plan_revision}`);
    const link = store.get<any>("planning_document", workflowId);
    const authority = doc?.original_authority ?? { revision: record?.revision, hash: record?.hash, path };
    const approvedPlan = store.get<any>("plan", `${workflowId}-${authority.revision}`);
    const approval = store.get<any>("approval", `${workflowId}-${authority.revision}`);
    const approvedRef = approvedPlan?.plan?.design_ref?.file_ref;
    requireCondition(doc?.workflow_id === workflowId && doc.document_type === "plan" && doc.path &&
      doc.revision === wf?.plan_revision && link?.document_id === doc.id && link.plan_revision === doc.revision &&
      !["pending", "conflict"].includes(link.material_status) && !record?.material_id && !link.material_id &&
      record?.material_path && samePath(record.material_path, path) && samePath(doc.path, path) &&
      record.plan?.design_ref?.file_ref && isAbsolute(record.plan.design_ref.file_ref) && samePath(record.plan.design_ref.file_ref, path) &&
      approval?.plan_hash === authority.hash && approvedPlan?.hash === authority.hash &&
      typeof approvedRef === "string" && isAbsolute(approvedRef) && samePath(approvedRef, path) && samePath(authority.path, path),
      "PATH_ESCAPE", "计划原件必须属于项目或任务工作区", 400);
    const root = dirname(path), rel = relative(root, path);
    requireCondition(readMaterialFile(root, rel), "PLAN_MATERIAL_LOST", "已登记的项目计划原件已丢失", 409);
    return { root, relative: rel, path: resolve(path), authority };
  }
}

/** Documents belong to the project. Store references, never revision copies. */
export class DocumentService {
  constructor(private store: Store, private storageRoot: string = process.cwd()) {}

  publishDocument(workflowId: string, documentType: ProjectDocument["document_type"], content: string,
    revision?: number, documentPath?: string, updateOriginal = false, expectedOriginal?: DocumentVersion): ProjectDocument {
    return this.store.transaction(() => {
    const existing = this.store.list<ProjectDocument>("project_document", workflowId)
      .filter(d => d.document_type === documentType).sort((a, b) => b.revision - a.revision)[0];
    const original = documentType === "plan" ? originalPlanPath(this.store, workflowId) : existing?.path;
    let path = original;
    if (!path) {
      const locator = resolveMaterialLocator({ store: this.store, workflowId,
        kind: documentType === "plan" ? "plan" : "repair", customRelPath: documentPath,
        revision: revision ?? 1, projectOriginal: true });
      path = locator.absolute_path;
      if (!documentPath && (documentType === "design" || documentType === "architecture"))
        path = resolve(dirname(path), documentType + ".md");
    }
    const location = documentLocation(this.store, workflowId, path, existing);
    path = location.path;
    const before = readMaterialFile(location.root, location.relative);
    if (!original && !before) resolveMaterialLocator({ store: this.store, workflowId,
      kind: documentType === "plan" ? "plan" : "repair", customRelPath: path });
    const data = Buffer.from(content.replace(/\r\n/g, "\n"));
    if (updateOriginal && expectedOriginal?.path) requireCondition(
      samePath(expectedOriginal.path, path) &&
      (before ? hash(before.toString("utf8").replace(/\r\n/g, "\n")) : undefined) === expectedOriginal.hash,
      "DOCUMENT_CONTENT_CONFLICT", "计划原件在规划期间已变化，请读取最新内容后重新规划", 409);
    // A returned candidate can register an existing original, but cannot overwrite an unrelated file.
    if (updateOriginal && before && ((!original && !existing) || (expectedOriginal && !expectedOriginal.path)))
      requireCondition(before.toString("utf8").replace(/\r\n/g, "\n") === data.toString("utf8"), "DOCUMENT_CONTENT_CONFLICT", "候选文档已存在，不能覆盖未登记的原件", 409);
    if (!before || (updateOriginal && before.toString("utf8").replace(/\r\n/g, "\n") !== data.toString("utf8"))) {
      requireCondition(content.trim().length > 0, "EMPTY_DOCUMENT", "文档正文不能为空", 400);
      if (before && existing?.revision && revision && revision > existing.revision)
        this.store.put("plan_revision_content", `${workflowId}-${existing.revision}`, workflowId, {
          workflow_id: workflowId, revision: existing.revision, content: before.toString("utf8"),
          hash: hash(before.toString("utf8").replace(/\r\n/g, "\n")),
        });
      if (before) replaceMaterialFile(location.root, location.relative, before, data, randomUUID());
      else publishMaterialFile(location.root, location.relative, data, randomUUID());
      this.store.onRollback(() => replaceMaterialFile(location.root, location.relative, data, before, randomUUID()));
    }
    const metadata = {
      id: `doc_${workflowId}_${documentType}`, workflow_id: workflowId, document_type: documentType,
      revision: revision ?? existing?.revision ?? 1, path, hash: "",
      approved_by_human: existing?.approved_by_human ?? false,
      approval_receipt: existing?.approval_receipt,
      created_at: existing?.created_at ?? now(), updated_at: now(),
      original_authority: location.authority ?? existing?.original_authority,
    };
    this.store.put("project_document", metadata.id, workflowId, metadata);
    const current = readMaterialFile(location.root, location.relative)!;
    return { ...metadata, content: current.toString("utf8"), hash: hash(current.toString("utf8").replace(/\r\n/g, "\n")) };
    });
  }

  captureOriginal(workflowId: string): DocumentVersion {
    const doc = this.store.get<ProjectDocument>("project_document", `doc_${workflowId}_plan`);
    const path = originalPlanPath(this.store, workflowId);
    if (!path) return {};
    const location = documentLocation(this.store, workflowId, path, doc);
    const content = readMaterialFile(location.root, location.relative);
    return { path, hash: content ? hash(content.toString("utf8").replace(/\r\n/g, "\n")) : undefined };
  }

  private hydrate(doc: ProjectDocument): ProjectDocument {
    const currentPath = doc.document_type === "plan" ? originalPlanPath(this.store, doc.workflow_id) : undefined;
    const path = currentPath ?? doc.path;
    if (path) {
      const location = documentLocation(this.store, doc.workflow_id, path, doc);
      const bytes = readMaterialFile(location.root, location.relative);
      requireCondition(bytes, "DOCUMENT_NOT_FOUND", "项目文档原件不存在：" + path, 404);
      const content = bytes.toString("utf8");
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
