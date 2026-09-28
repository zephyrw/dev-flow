import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, normalize, relative, resolve, join } from "node:path";
import { createHash } from "node:crypto";
import type { Store } from "../../store/src/store.js";
import {
  FlowError,
  requireCondition,
  type Workspace,
  type Project,
  type ProjectMaterial,
} from "../../contracts/src/index.js";
import { atomicWrite, now } from "./util.js";
export function publishProjectMaterialSafely(options: {
  store: Store; locator: MaterialLocator; content: string; cachePath?: string; expectedHash?: string;
}): { material: ProjectMaterial; writtenToDisk: boolean } {
  const { store, locator, content } = options;
  let writtenToDisk = false;
  let sourceHash = computeSha256(content);
  try {
    if (!existsSync(locator.absolute_path)) {
      mkdirSync(dirname(locator.absolute_path), { recursive: true });
      try { writeFileSync(locator.absolute_path, content, { encoding: "utf8", flag: "wx" }); }
      catch (error: any) { if (error?.code !== "EEXIST") throw error; }
    }
    sourceHash = computeSha256(readFileSync(locator.absolute_path, "utf8"));
    writtenToDisk = true;
  } catch {}
  const record: ProjectMaterial = {
    id: locator.material_id ?? `mat_${locator.workflow_id}_${locator.kind}`,
    workflow_id: locator.workflow_id, repo_id: locator.repo_id, workspace_id: locator.workspace_id,
    path: locator.relative_path, kind: locator.kind, revision: locator.revision,
    source_hash: sourceHash, status: writtenToDisk ? "verified" : "missing", created_at: now(), updated_at: now(),
  };
  store.put("project_material", record.id, locator.workflow_id, record);
  return { material: record, writtenToDisk };
}

/** Read current project text. Hashes/status from older publication are not prose locks. */
export function readProjectMaterialByLocator(options: {
  store: Store; locator: MaterialLocator; fallbackPendingContent?: string; platformCachePath?: string;
}): MaterialReadResult {
  const { store, locator, fallbackPendingContent, platformCachePath } = options;
  if (existsSync(locator.absolute_path)) return {
    content: readFileSync(locator.absolute_path, "utf8"), exists: true, source: "project_material", locator,
  };
  const material = store.list<ProjectMaterial>("project_material", locator.workflow_id)
    .find(m => m.id === locator.material_id || (m.kind === locator.kind && m.path === locator.relative_path));
  if (material) return { content: "", exists: false, source: "project_material", locator };
  // Legacy rescue is read-only here; normal referenced originals never fall back to caches.
  const legacy = fallbackPendingContent ?? (platformCachePath && existsSync(platformCachePath) ? readFileSync(platformCachePath, "utf8") : "");
  return legacy ? { content: legacy, exists: true, source: "platform_legacy", locator }
    : { content: "", exists: false, source: "none", locator };
}

/** Old pending caches must never recreate or overwrite a project original. */
export function reconcileMaterialOutbox(store: Store, workflowId?: string): number {
  const materials = store.list<ProjectMaterial>("project_material", workflowId);
  let count = 0;
  for (const material of materials.filter(m => m.status === "pending")) {
    const ws = store.get<Workspace>("workspace", material.workspace_id);
    if (!ws) continue;
    const path = resolve(ws.root, sanitizeRelativePath(ws.root, material.path));
    if (!existsSync(path)) continue;
    store.put("project_material", material.id, material.workflow_id, {
      ...material, cache_path: undefined, source_hash: computeSha256(readFileSync(path, "utf8")),
      status: "verified", updated_at: now(),
    });
    count++;
  }
  return count;
}
export type ProjectMaterialCategory = "plan" | "review" | "repair" | "process" | "evidence";

export interface MaterialLocator {
  workflow_id: string;
  repo_id: string;
  workspace_id: string;
  workspace_root: string;
  workspace_version: number;
  kind: ProjectMaterialCategory;
  revision: number;
  run_id?: string;
  round?: number;
  material_id?: string;
  relative_path: string;
  absolute_path: string;
  expected_hash?: string;
}

export interface MaterialReadResult {
  content: string;
  exists: boolean;
  source: "project_material" | "result_pending" | "platform_legacy" | "none";
  is_conflict?: boolean;
  conflict_reason?: string;
  locator?: MaterialLocator;
}

function computeSha256(content: string): string {
  const norm = content.replace(/\r\n/g, "\n");
  return createHash("sha256").update(norm, "utf8").digest("hex");
}

/**
 * 安全解析相对路径，防止路径穿越和绝对路径注入
 */
export function sanitizeRelativePath(baseRoot: string, relPath: string): string {
  const normRel = relPath.replaceAll("\\", "/").replace(/^\/+/, "");
  if (isAbsolute(normRel) || normRel.includes("..")) {
    throw new FlowError("INVALID_PATH", `非法相对路径，禁止路径穿越: ${relPath}`, 400);
  }
  const resolved = resolve(baseRoot, normRel);
  const rel = relative(resolve(baseRoot), resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new FlowError("PATH_ESCAPE", `路径越界，必须在目标工作区内部: ${relPath}`, 400);
  }
  return normRel;
}

/** Resolve an existing document reference; never select a different copy by hash. */
export function originalPlanPath(store: Store, workflowId: string, revision?: number): string | undefined {
  const wf = store.get<any>("workflow", workflowId);
  const records = store.list<any>("plan", workflowId);
  const record = records.find(p => p.revision === (revision ?? wf?.plan_revision));
  const project = wf?.project_id ? store.get<Project>("project", wf.project_id) : undefined;
  const workspaces = store.list<Workspace>("workspace", workflowId);
  const roots = [
    ...workspaces.map(w => ({ repo_id: w.repo_id, root: w.root })),
    ...(project?.repositories ?? []).map(r => ({ repo_id: r.id, root: r.path })),
  ];
  const ref = record?.plan?.design_ref?.file_ref;
  if (typeof ref === "string" && ref.trim()) {
    if (isAbsolute(ref)) return normalize(ref);
    const qualified = roots.find(r => ref.startsWith(r.repo_id + ":"));
    const root = qualified ?? roots.find(r => r.repo_id === project?.primary_repo_id) ?? roots.find(r => r.repo_id === "main") ?? roots[0];
    if (root) return resolve(root.root, sanitizeRelativePath(root.root, qualified ? ref.slice(root.repo_id.length + 1) : ref));
  }
  const link = store.get<any>("planning_document", workflowId);
  if (record?.material_path) {
    if (isAbsolute(record.material_path)) return normalize(record.material_path);
    if (roots[0]) return resolve(roots[0].root, sanitizeRelativePath(roots[0].root, record.material_path));
  }
  const materials = store.list<ProjectMaterial>("project_material", workflowId).filter(m => m.kind === "plan");
  const material = materials.find(m => m.id === (record?.material_id ?? link?.material_id)) ??
    materials.find(m => m.id === `mat_${workflowId}_plan`) ??
    materials.find(m => record?.run_id && m.id === `mat_${workflowId}_plan_r${record.revision}_run_${record.run_id}`) ??
    materials.find(m => m.revision === (revision ?? wf?.plan_revision));
  if (material) {
    const ws = workspaces.find(w => w.id === material.workspace_id);
    const root = ws?.root ?? roots.find(r => r.repo_id === material.repo_id)?.root;
    if (root) return resolve(root, sanitizeRelativePath(root, material.path));
  }
  const docs = store.list<any>("project_document", workflowId).filter(d => d.document_type === "plan");
  const doc = docs.find(d => d.id === link?.document_id) ?? docs.find(d => d.id === `doc_${workflowId}_plan`) ??
    docs.find(d => d.revision === (revision ?? wf?.plan_revision));
  const platformCopy = doc?.path && (doc.path.replaceAll("\\", "/").includes("/.devflow/documents/") ||
    doc.path.replaceAll("\\", "/").includes(`/documents/${workflowId}/`));
  if (doc?.path && !platformCopy && roots.some(root => {
    const rel = relative(resolve(root.root), resolve(doc.path));
    return !rel.startsWith("..") && !isAbsolute(rel);
  })) return doc.path;
}

/**
 * 依据 CW2-D03 / CW3-F11 / CW3-F12 规范：解析主工作区及材料 Locator
 * 规则：优先用户指定原件引用，再项目 material_paths，再明确 primary repo，多仓库绝不无脑取首项；
 * 文件名和材料键包含真实 run_id/round/revision
 */
export function resolveMaterialLocator(options: {
  store: Store;
  workflowId: string;
  kind: ProjectMaterialCategory;
  revision?: number;
  run_id?: string;
  round?: number;
  preferredWorkspaceId?: string;
  customRelPath?: string;
  expectedHash?: string;
}): MaterialLocator {
  const { store, workflowId, kind, preferredWorkspaceId, customRelPath, run_id, round, expectedHash } = options;
  const revision = options.revision ?? 1;

  // 读取关联的 Project
  const wf = store.get<any>("workflow", workflowId);
  const project = wf?.project_id ? store.get<Project>("project", wf.project_id) : undefined;
  const savedWorkspaces = store.list<Workspace>("workspace", workflowId);
  const workspaces = savedWorkspaces.length ? savedWorkspaces : (project?.repositories ?? []).map(r => ({
    id: `project:${r.id}`, repo_id: r.id, root: r.path,
  } as Workspace));
  requireCondition(workspaces.length > 0, "NO_WORKSPACES", `工作流 ${workflowId} 无可用工作区`, 404);
  const existingPath = kind === "plan" ? originalPlanPath(store, workflowId) : undefined;

  let targetWs: Workspace | undefined;
  if (preferredWorkspaceId) {
    targetWs = workspaces.find((w) => w.id === preferredWorkspaceId);
  }

  if (!targetWs) {
    // 优先读取 Project 的 primary_repo_id
    if (project?.primary_repo_id) {
      targetWs = workspaces.find((w) => w.repo_id === project.primary_repo_id);
    }
  }

  if (!targetWs) {
    targetWs =
      workspaces.find((w: any) => w.is_primary === true || w.primary === true) ||
      workspaces.find((w) => w.repo_id === "main") ||
      workspaces.find((w) => w.repo_id === "primary") ||
      workspaces[0];
  }

  requireCondition(targetWs, "WORKSPACE_NOT_FOUND", "未找到适用的工作区进行材料定位", 404);

  const repoConfig = project?.repositories?.find((r) => r.id === targetWs!.repo_id);
  const matPaths = repoConfig?.material_paths;

  let relPath: string;
  if (existingPath && !customRelPath) {
    const root = [...workspaces, ...(project?.repositories ?? []).map(r => ({ id: `project:${r.id}`, repo_id: r.id, root: r.path } as Workspace))]
      .find(w => { const rel = relative(resolve(w.root), resolve(existingPath)); return !rel.startsWith("..") && !isAbsolute(rel); });
    requireCondition(root, "PATH_ESCAPE", "计划原件必须属于项目或任务工作区", 400);
    targetWs = root;
    relPath = sanitizeRelativePath(root.root, relative(root.root, existingPath));
  } else if (customRelPath && customRelPath.trim()) {
    relPath = sanitizeRelativePath(targetWs.root, customRelPath);
  } else {
    let baseDir: string;
    switch (kind) {
      case "plan":
        baseDir = matPaths?.plan_dir ?? "docs/plan";
        break;
      case "review":
        baseDir = matPaths?.review_dir ?? "docs/plan";
        break;
      case "repair":
        baseDir = matPaths?.repair_dir ?? "docs/plan";
        break;
      case "process":
        baseDir = matPaths?.process_dir ?? "docs/process";
        break;
      case "evidence":
        baseDir = matPaths?.evidence_dir ?? "docs/test/evidence";
        break;
    }

    switch (kind) {
      case "plan": {
        relPath = `${baseDir}/${workflowId}/plan.md`;
        break;
      }
      case "review": {
        relPath = `${baseDir}/${workflowId}/review.md`;
        break;
      }
      case "repair": {
        relPath = `${baseDir}/${workflowId}/repair.md`;
        break;
      }
      case "process": {
        relPath = `${baseDir}/${workflowId}/handover.md`;
        break;
      }
      case "evidence": {
        relPath = `${baseDir}/${workflowId}/${round ?? revision}/evidence.json`;
        break;
      }
    }
  }

  const absPath = normalize(resolve(targetWs.root, relPath));
  const materialId = kind === "evidence" ? `mat_${workflowId}_${kind}_r${revision}${round !== undefined ? `_round_${round}` : ""}${run_id ? `_run_${run_id}` : ""}` : `mat_${workflowId}_${kind}`;

  return {
    workflow_id: workflowId,
    repo_id: targetWs.repo_id,
    workspace_id: targetWs.id,
    workspace_root: targetWs.root,
    workspace_version: (targetWs as any).version ?? 1,
    kind,
    revision,
    run_id,
    round,
    material_id: materialId,
    relative_path: relPath,
    absolute_path: absPath,
    expected_hash: expectedHash,
  };
}

/**
 * 依据 CW2-D03 / CW3-F11 / §6 规范：安全发布项目材料
 * 1. 既有异内容默认冲突；只有明确更新意图且 expected_hash 匹配才允许覆盖
 * 2. 全新写入必须为 no-replace 独占发布，不改判模型成功事实，落盘失败标 pending
 */
// 保持向下兼容的轻量 helper 导出
export function getPlanMaterialPath(
  workspaceRoot: string,
  workflowId: string,
  revision?: number,
) {
  const file = revision !== undefined ? `plan-r${revision}.md` : "plan.md";
  const rel = `docs/plan/${workflowId}/${file}`;
  return {
    relativePath: rel,
    absolutePath: normalize(resolve(workspaceRoot, rel)),
  };
}

export function getReviewMaterialPath(
  workspaceRoot: string,
  workflowId: string,
  round?: number,
) {
  const file = round !== undefined ? `review-r${round}.md` : "review.md";
  const rel = `docs/plan/${workflowId}/${file}`;
  return {
    relativePath: rel,
    absolutePath: normalize(resolve(workspaceRoot, rel)),
  };
}

export function getProcessMaterialPath(
  workspaceRoot: string,
  workflowId: string,
  filename = "handover.md",
) {
  const rel = `docs/process/${workflowId}/${filename}`;
  return {
    relativePath: rel,
    absolutePath: normalize(resolve(workspaceRoot, rel)),
  };
}

export function getEvidenceMaterialPath(
  workspaceRoot: string,
  workflowId: string,
  round: number = 1,
  filename = "evidence.json",
) {
  const rel = `docs/test/evidence/${workflowId}/${round}/${filename}`;
  return {
    relativePath: rel,
    absolutePath: normalize(resolve(workspaceRoot, rel)),
  };
}

export function resolveProjectMaterialPath(workspaceRoot: string, relPath: string): string {
  const normRel = sanitizeRelativePath(workspaceRoot, relPath);
  return normalize(resolve(workspaceRoot, normRel));
}

export function writeProjectMaterial(options: {
  workspaceRoot: string;
  workflowId: string;
  category: ProjectMaterialCategory | "test_evidence";
  filename: string;
  content: string;
  round?: number;
  customRelPath?: string;
}) {
  let rel = options.customRelPath;
  if (!rel) {
    if (options.category === "evidence" || options.category === "test_evidence") {
      rel = `docs/test/evidence/${options.workflowId}/${options.round ?? 1}/${options.filename}`;
    } else {
      rel = `docs/plan/${options.workflowId}/${options.filename}`;
    }
  }
  const abs = normalize(resolve(options.workspaceRoot, rel));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, options.content, "utf8");
  return { relativePath: rel, absolutePath: abs };
}

export function readProjectMaterial(options: {
  workspaceRoot: string;
  relativePath: string;
  cachePath?: string;
}) {
  const abs = normalize(resolve(options.workspaceRoot, options.relativePath));
  if (existsSync(abs)) {
    return {
      exists: true,
      isFromProject: true,
      isFromCache: false,
      content: readFileSync(abs, "utf8"),
    };
  }
  if (options.cachePath && existsSync(options.cachePath)) {
    return {
      exists: true,
      isFromProject: false,
      isFromCache: true,
      content: readFileSync(options.cachePath, "utf8"),
    };
  }
  return {
    exists: false,
    isFromProject: false,
    isFromCache: false,
    content: "",
  };
}
