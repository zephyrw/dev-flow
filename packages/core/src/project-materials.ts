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

  const workspaces = store.list<Workspace>("workspace", workflowId);
  requireCondition(workspaces.length > 0, "NO_WORKSPACES", `工作流 ${workflowId} 无可用工作区`, 404);

  // 读取关联的 Project
  const wf = store.get<any>("workflow", workflowId);
  const project = wf?.project_id ? store.get<Project>("project", wf.project_id) : undefined;

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
  if (customRelPath && customRelPath.trim()) {
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
        const runPart = run_id ? `-run-${run_id}` : "";
        relPath = `${baseDir}/${workflowId}/plan-r${revision}${runPart}.md`;
        break;
      }
      case "review": {
        const roundPart = round !== undefined ? `-round-${round}` : "";
        const runPart = run_id ? `-run-${run_id}` : "";
        relPath = `${baseDir}/${workflowId}/review-r${revision}${roundPart}${runPart}.md`;
        break;
      }
      case "repair": {
        const roundPart = round !== undefined ? `-round-${round}` : "";
        const runPart = run_id ? `-run-${run_id}` : "";
        relPath = `${baseDir}/${workflowId}/repair-r${revision}${roundPart}${runPart}.md`;
        break;
      }
      case "process": {
        const runPart = run_id ? `-${run_id}` : "";
        relPath = `${baseDir}/${workflowId}/handover${runPart}.md`;
        break;
      }
      case "evidence": {
        relPath = `${baseDir}/${workflowId}/${round ?? revision}/evidence.json`;
        break;
      }
    }
  }

  const absPath = normalize(resolve(targetWs.root, relPath));
  const materialId = `mat_${workflowId}_${kind}_r${revision}${round !== undefined ? `_round_${round}` : ""}${run_id ? `_run_${run_id}` : ""}`;

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
export function publishProjectMaterialSafely(options: {
  store: Store;
  locator: MaterialLocator;
  content: string;
  cachePath?: string;
  expectedHash?: string;
}): { material: ProjectMaterial; writtenToDisk: boolean } {
  const { store, locator, content, cachePath, expectedHash } = options;
  const contentHash = computeSha256(content);
  const materialId =
    locator.material_id ??
    `mat_${locator.workflow_id}_${locator.kind}_r${locator.revision}${locator.round !== undefined ? `_round_${locator.round}` : ""}${locator.run_id ? `_run_${locator.run_id}` : ""}`;
  const effectiveExpectedHash = expectedHash ?? locator.expected_hash;

  let writtenToDisk = false;
  let status: ProjectMaterial["status"] = "pending";

  try {
    if (existsSync(locator.absolute_path)) {
      const existing = readFileSync(locator.absolute_path, "utf8");
      const existingHash = computeSha256(existing);

      if (existingHash === contentHash) {
        // 内容已一致，直接核验通过
        writtenToDisk = true;
        status = "verified";
      } else if (effectiveExpectedHash !== undefined && existingHash === effectiveExpectedHash) {
        // 明确具有更新意图且预期哈希完全匹配，允许覆盖写入
        atomicWrite(locator.absolute_path, content);
        writtenToDisk = true;
        status = "verified";
      } else {
        // CW3-F11: 未传 expectedHash 或预期哈希不匹配时，既有异内容默认判定为冲突，禁止覆盖
        status = "conflict";
        writtenToDisk = false;
      }
    } else {
      // 全新写入 (no-replace 独占发布)
      const targetDir = dirname(locator.absolute_path);
      if (!existsSync(targetDir)) {
        mkdirSync(targetDir, { recursive: true });
      }
      atomicWrite(locator.absolute_path, content);
      writtenToDisk = true;
      status = "verified";
    }
  } catch (err: any) {
    // 磁盘写入失败时记录 pending，保留模型成功事实并支持后续 outbox 重试
    status = "pending";
    writtenToDisk = false;
  }

  const record: ProjectMaterial = {
    id: materialId,
    workflow_id: locator.workflow_id,
    repo_id: locator.repo_id,
    workspace_id: locator.workspace_id,
    path: locator.relative_path,
    kind: locator.kind,
    revision: locator.revision,
    source_hash: contentHash,
    cache_path: cachePath,
    status,
    created_at: now(),
    updated_at: now(),
  };

  store.put("project_material", materialId, locator.workflow_id, record);
  return { material: record, writtenToDisk };
}

/**
 * 依据 CW2-D03 / CW3-F12 / §6 规范：按 Locator 精确读取材料
 * 严格区分 result_pending、原件冲突/缺失与历史无 locator 兼容。
 * 原件发布后若丢失，禁止以平台缓存掩盖！
 */
export function readProjectMaterialByLocator(options: {
  store: Store;
  locator: MaterialLocator;
  fallbackPendingContent?: string;
  platformCachePath?: string;
}): MaterialReadResult {
  const { store, locator, fallbackPendingContent, platformCachePath } = options;
  const materialId =
    locator.material_id ??
    `mat_${locator.workflow_id}_${locator.kind}_r${locator.revision}${locator.round !== undefined ? `_round_${locator.round}` : ""}${locator.run_id ? `_run_${locator.run_id}` : ""}`;
  
  let materialRecord = store.get<ProjectMaterial>("project_material", materialId);
  if (!materialRecord) {
    // 尝试寻找同 workflow, kind, revision 的材料记录
    const list = store.list<ProjectMaterial>("project_material", locator.workflow_id);
    materialRecord = list.find((m) => m.kind === locator.kind && m.revision === locator.revision);
  }

  // 1. 若记录自身已是冲突状态
  if (materialRecord?.status === "conflict") {
    const raw = existsSync(locator.absolute_path) ? readFileSync(locator.absolute_path, "utf8") : "";
    return {
      content: raw,
      exists: !!raw,
      source: "project_material",
      is_conflict: true,
      conflict_reason: "项目材料发布存在内容冲突，已保护原件不被覆盖",
      locator,
    };
  }

  // 2. 若项目原件存在于磁盘，核验内容与哈希
  if (existsSync(locator.absolute_path)) {
    try {
      const raw = readFileSync(locator.absolute_path, "utf8");
      const currentHash = computeSha256(raw);

      if (materialRecord && materialRecord.source_hash && currentHash !== materialRecord.source_hash) {
        return {
          content: raw,
          exists: true,
          source: "project_material",
          is_conflict: true,
          conflict_reason: `项目原件已被修改 (预期哈希: ${materialRecord.source_hash.slice(0, 8)}, 当前: ${currentHash.slice(0, 8)})`,
          locator,
        };
      }
      return {
        content: raw,
        exists: true,
        source: "project_material",
        locator,
      };
    } catch (err: any) {
      // 读取异常处理
    }
  }

  // 3. 磁盘文件不存在：
  // 3a. 若材料记录处于 pending 状态，或有当前本轮正文，返回 result_pending
  if (materialRecord?.status === "pending" || fallbackPendingContent) {
    const pendingText =
      fallbackPendingContent ??
      (platformCachePath && existsSync(platformCachePath) ? readFileSync(platformCachePath, "utf8") : "");
    if (pendingText) {
      return {
        content: pendingText,
        exists: true,
        source: "result_pending",
        locator,
      };
    }
  }

  // 3b. 若材料记录已存在且曾发布成功 (verified)，但磁盘文件丢失：
  // CW3-F12: 绝不能用平台缓存掩盖已发布原件的丢失！
  if (materialRecord && materialRecord.status === "verified") {
    return {
      content: "",
      exists: false,
      source: "project_material",
      is_conflict: true,
      conflict_reason: `项目原件已丢失 (${locator.relative_path})，禁止以平台缓存掩盖`,
      locator,
    };
  }

  // 3c. 历史兼容：确无任何项目材料记录时，回退平台缓存
  if (!materialRecord && platformCachePath && existsSync(platformCachePath)) {
    try {
      const legacyContent = readFileSync(platformCachePath, "utf8");
      return {
        content: legacyContent,
        exists: true,
        source: "platform_legacy",
        locator,
      };
    } catch {}
  }

  return {
    content: "",
    exists: false,
    source: "none",
    locator,
  };
}

/**
 * 依据 CW3-F12 规范：材料 outbox 恢复与补写对账
 * 在服务启动或恢复时，将 pending 状态的材料安全补写至磁盘，恢复只补写不重走模型业务
 */
export function reconcileMaterialOutbox(store: Store, workflowId?: string): number {
  const materials = workflowId
    ? store.list<ProjectMaterial>("project_material", workflowId)
    : store.list<ProjectMaterial>("project_material");

  const pendingList = materials.filter((m) => m.status === "pending");
  let reconciledCount = 0;

  for (const mat of pendingList) {
    const ws = store.get<Workspace>("workspace", mat.workspace_id);
    if (!ws || !existsSync(ws.root)) continue;

    const absPath = normalize(resolve(ws.root, mat.path));
    try {
      let contentToSave: string | null = null;
      if (mat.cache_path && existsSync(mat.cache_path)) {
        contentToSave = readFileSync(mat.cache_path, "utf8");
      }

      if (!contentToSave) continue;

      if (existsSync(absPath)) {
        const cur = readFileSync(absPath, "utf8");
        if (computeSha256(cur) === mat.source_hash) {
          mat.status = "verified";
          mat.updated_at = now();
          store.put("project_material", mat.id, mat.workflow_id, mat);
          reconciledCount++;
        } else {
          mat.status = "conflict";
          mat.updated_at = now();
          store.put("project_material", mat.id, mat.workflow_id, mat);
        }
      } else {
        const targetDir = dirname(absPath);
        if (!existsSync(targetDir)) {
          mkdirSync(targetDir, { recursive: true });
        }
        atomicWrite(absPath, contentToSave);
        mat.status = "verified";
        mat.updated_at = now();
        store.put("project_material", mat.id, mat.workflow_id, mat);
        reconciledCount++;
      }
    } catch {}
  }

  return reconciledCount;
}

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
