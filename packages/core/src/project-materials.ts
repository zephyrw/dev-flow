import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, normalize, relative, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Store } from "../../store/src/store.js";
import {
  FlowError,
  requireCondition,
  type Workspace,
  type Project,
  type ProjectMaterial,
  type Workflow,
} from "../../contracts/src/index.js";
import { now } from "./util.js";
import { materialRelativePath, withMaterialRoot, readMaterialFile, publishMaterialFile } from "./material-filesystem.js";

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
 * F05_FILESYSTEM_BOUNDARY: 先对原始输入检查绝对路径/盘符/UNC路径；按路径段检查'..'父目录段；确保严格位于baseRoot内
 */
export function sanitizeRelativePath(_baseRoot: string, relPath: string): string {
  return materialRelativePath(relPath);
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
 * 依据规范解析主工作区及材料 Locator
 * F02_WORKSPACE_FALLBACK: 显式指定的 preferredWorkspaceId 无效时必须立即抛出 WORKSPACE_NOT_FOUND 错误拒绝，不得回退；
 * 单工作区自动选择；多工作区必须由 project.primary_repo_id 唯一定位，若未配置或不唯一抛出 WORKSPACE_AMBIGUOUS 错误，
 * 禁止静默 fallback 到 workspaces[0] 或未声明的属性。
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
  const existingPath = kind === "plan" && customRelPath === undefined ? originalPlanPath(store, workflowId) : undefined;
  requireCondition(workspaces.length > 0, "NO_WORKSPACES", `工作流 ${workflowId} 无可用工作区`, 404);

  let targetWs: Workspace | undefined;
  if (preferredWorkspaceId) {
    targetWs = workspaces.find((w) => w.id === preferredWorkspaceId);
    requireCondition(targetWs, "WORKSPACE_NOT_FOUND", `显式指定的工作区不存在: ${preferredWorkspaceId}`, 404);
  } else if (workspaces.length === 1) {
    targetWs = workspaces[0];
  } else {
    // 多工作区必须由 project.primary_repo_id 唯一定位，未配置或不唯一抛出 WORKSPACE_AMBIGUOUS
    requireCondition(
      project?.primary_repo_id,
      "WORKSPACE_AMBIGUOUS",
      "存在多个工作区但项目未配置 primary_repo_id，无法唯一定位工作区",
      409,
    );
    const matched = workspaces.filter((w) => w.repo_id === project!.primary_repo_id);
    requireCondition(
      matched.length > 0,
      "WORKSPACE_NOT_FOUND",
      `未找到主代码库 (${project!.primary_repo_id}) 对应的工作区`,
      404,
    );
    requireCondition(
      matched.length === 1,
      "WORKSPACE_AMBIGUOUS",
      `主代码库 (${project!.primary_repo_id}) 对应多个工作区，无法唯一定位`,
      409,
    );
    targetWs = matched[0];
  }

  requireCondition(targetWs, "WORKSPACE_NOT_FOUND", "未找到适用的工作区进行材料定位", 404);

  if (existingPath) {
    const roots = preferredWorkspaceId ? [targetWs] : [...workspaces,
      ...(project?.repositories ?? []).map(r => ({ id: `project:${r.id}`, repo_id: r.id, root: r.path } as Workspace))];
    const root = roots.find(w => { const rel = relative(resolve(w.root), resolve(existingPath)); return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel); });
    requireCondition(root, "PATH_ESCAPE", "计划原件必须属于项目或任务工作区", 400);
    targetWs = root;
  }

  const repoConfig = project?.repositories?.find((r) => r.id === targetWs!.repo_id);
  const matPaths = repoConfig?.material_paths;

  let relPath: string;
  if (existingPath) {
    relPath = sanitizeRelativePath(targetWs.root, relative(targetWs.root, existingPath));
  } else if (customRelPath !== undefined) {
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

  relPath = sanitizeRelativePath(targetWs.root, relPath);
  const permitted = [matPaths?.plan_dir ?? "docs/plan", matPaths?.review_dir ?? "docs/plan", matPaths?.repair_dir ?? "docs/plan", matPaths?.process_dir ?? "docs/process", matPaths?.evidence_dir ?? "docs/test/evidence"].map(materialRelativePath);
  requireCondition(permitted.some((dir) => relPath.startsWith(`${dir}/`)), "INVALID_PATH", "材料路径不在允许的材料目录中", 400);
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

interface MaterialBinding {
  workflow_id: string;
  workspace_id: string;
  repo_id: string;
  workspace_root: string;
  root_identity: string;
  generation: number;
}

function workspaceBinding(store: Store, locator: MaterialLocator, rootIdentity: string): MaterialBinding {
  const ws = store.get<Workspace>("workspace", locator.workspace_id);
  requireCondition(ws && ws.workflow_id === locator.workflow_id && ws.repo_id === locator.repo_id && resolve(ws.root) === resolve(locator.workspace_root), "MATERIAL_BINDING_CONFLICT", "材料工作区绑定已变化", 409);
  const old = store.get<MaterialBinding>("material_binding", locator.workspace_id);
  if (old) {
    requireCondition(old.workflow_id === locator.workflow_id && old.repo_id === locator.repo_id && resolve(old.workspace_root) === resolve(ws.root) && old.root_identity === rootIdentity, "MATERIAL_BINDING_CONFLICT", "材料根目录身份已变化，须通过迁移恢复绑定", 409);
    return old;
  }
  const binding: MaterialBinding = { workflow_id: locator.workflow_id, workspace_id: ws.id, repo_id: ws.repo_id, workspace_root: resolve(ws.root), root_identity: rootIdentity, generation: 1 };
  try { return store.compareAndSwap<MaterialBinding>("material_binding", ws.id, locator.workflow_id, 0, binding).data; }
  catch (error) {
    if (!(error instanceof FlowError && error.code === "VERSION_CONFLICT")) throw error;
    const raced = store.get<MaterialBinding>("material_binding", ws.id);
    requireCondition(raced && raced.workflow_id === binding.workflow_id && raced.repo_id === binding.repo_id && raced.workspace_root === binding.workspace_root && raced.root_identity === binding.root_identity && raced.generation === 1, "MATERIAL_BINDING_CONFLICT", "材料根目录绑定被其他迁移改变", 409);
    return raced;
  }
}

/** Keep migration/rollback and normal reads on the same declared hash protocol. */
function materialBodyMatches(material: ProjectMaterial, body: Buffer): boolean {
  return computeSha256(body.toString("utf8")) === material.source_hash &&
    (material.protocol_version !== 2 || createHash("sha256").update(body).digest("hex") === material.object_hash);
}

/** Read-only preflight, used before moving a worktree and again before committing its binding. */
export function validateMaterialMigration(store: Store, workspaceId: string, root: string): string {
  const ws = store.must<Workspace>("workspace", workspaceId);
  const materials = store.list<ProjectMaterial>("project_material", ws.workflow_id).filter((m) => m.workspace_id === ws.id && m.status === "verified");
  return withMaterialRoot(root, (port) => {
    for (const material of materials) {
      requireCondition(!material.repo_id || material.repo_id === ws.repo_id, "MATERIAL_MIGRATION_CONFLICT", "材料工作区归属不一致", 409);
      resolveMaterialLocator({ store, workflowId: ws.workflow_id, kind: material.kind, revision: material.revision, preferredWorkspaceId: ws.id, customRelPath: material.path });
      const body = port.read(materialRelativePath(material.path));
      requireCondition(body && materialBodyMatches(material, body), "MATERIAL_MIGRATION_CONFLICT", "迁移材料原件未通过协议哈希核验，已保留原件和绑定", 409);
    }
    port.validate();
    requireCondition(withMaterialRoot(root, (current) => current.identity) === port.identity, "MATERIAL_MIGRATION_CONFLICT", "材料根目录在迁移核验期间发生变化", 409);
    return port.identity;
  });
}

/** Called by the authorized workspace migration transaction, including rollback. */
export function migrateMaterialBinding(store: Store, workspaceId: string, newRoot: string): void {
  // Validate every original before any binding write, including an otherwise idempotent call.
  const rootIdentity = validateMaterialMigration(store, workspaceId, newRoot);
  store.transaction(() => {
    const ws = store.must<Workspace>("workspace", workspaceId);
    const old = store.getWithVersion<MaterialBinding>("material_binding", workspaceId);
    if (old && old.data.workspace_root === resolve(newRoot) && old.data.root_identity === rootIdentity && old.data.repo_id === ws.repo_id && old.data.workflow_id === ws.workflow_id) return;
    const next: MaterialBinding = { workflow_id: ws.workflow_id, workspace_id: ws.id, repo_id: ws.repo_id, workspace_root: resolve(newRoot), root_identity: rootIdentity, generation: (old?.data.generation ?? 0) + 1 };
    store.compareAndSwap("material_binding", ws.id, ws.workflow_id, old?.version ?? 0, next);
    for (const material of store.list<ProjectMaterial>("project_material", ws.workflow_id).filter((m) => m.workspace_id === ws.id)) {
      const current = store.getWithVersion<ProjectMaterial>("project_material", material.id)!;
      // A pending intent belongs to its frozen old root and is never transplanted.
      const updated = material.status === "verified"
        ? { ...material, repo_id: ws.repo_id, workspace_root: next.workspace_root, root_identity: next.root_identity, material_binding_generation: next.generation }
        : { ...material, status: "conflict" as const, publication_error: "MATERIAL_BINDING_CHANGED" };
      store.compareAndSwap("project_material", material.id, ws.workflow_id, current.version, { ...updated, updated_at: now() });
    }
  });
}

export function readVerifiedProjectMaterial(store: Store, material: ProjectMaterial): string {
  requireCondition(material.status === "verified", "PLAN_MATERIAL_CONFLICT", "材料尚未核验", 409);
  const ws = store.get<Workspace>("workspace", material.workspace_id);
  requireCondition(ws && ws.workflow_id === material.workflow_id && (!material.repo_id || material.repo_id === ws.repo_id), "PLAN_MATERIAL_CONFLICT", "材料工作区归属不一致", 409);
  resolveMaterialLocator({ store, workflowId: material.workflow_id, kind: material.kind, revision: material.revision, preferredWorkspaceId: ws.id, customRelPath: material.path });
  return withMaterialRoot(ws.root, (port) => {
    if (material.protocol_version === 2 || material.root_identity) assertFrozenBinding(store, material, port.identity);
    const data = port.read(materialRelativePath(material.path));
    requireCondition(data, "PLAN_MATERIAL_LOST", "已发布的项目计划原件已丢失，禁止以平台缓存掩盖", 409);
    const text = data.toString("utf8");
    requireCondition(materialBodyMatches(material, data), "PLAN_MATERIAL_CONFLICT", "项目中的计划原件已被修改，发生原件冲突", 409);
    port.validate();
    requireCondition(withMaterialRoot(ws.root, (current) => current.identity) === port.identity, "MATERIAL_BINDING_CONFLICT", "材料根目录已迁移", 409);
    if (!material.root_identity && material.protocol_version !== 2) {
      // Lazy additive v1 mapping: preserve the original ID/path/LF hash and bind only this exact record.
      const locator = resolveMaterialLocator({ store, workflowId: material.workflow_id, kind: material.kind, revision: material.revision, preferredWorkspaceId: ws.id, customRelPath: material.path });
      const current = store.getWithVersion<ProjectMaterial>("project_material", material.id);
      requireCondition(current && current.data.status === "verified" && current.data.path === material.path && current.data.source_hash === material.source_hash, "MATERIAL_BINDING_CONFLICT", "材料记录已被其他操作更新", 409);
      const binding = workspaceBinding(store, locator, port.identity);
      store.compareAndSwap("project_material", material.id, material.workflow_id, current.version, { ...current.data, repo_id: ws.repo_id, workspace_root: binding.workspace_root, root_identity: binding.root_identity, material_binding_generation: binding.generation });
    }
    return text;
  });
}

function assertFrozenBinding(store: Store, material: ProjectMaterial, identity: string): void {
  const ws = store.get<Workspace>("workspace", material.workspace_id);
  const binding = store.get<MaterialBinding>("material_binding", material.workspace_id);
  requireCondition(ws && binding && ws.workflow_id === material.workflow_id && ws.repo_id === material.repo_id && binding.workflow_id === material.workflow_id && binding.repo_id === material.repo_id && binding.generation === material.material_binding_generation && binding.root_identity === identity && material.root_identity === identity && material.workspace_root === binding.workspace_root && resolve(ws.root) === binding.workspace_root, "MATERIAL_BINDING_CONFLICT", "材料发布意图绑定已变化", 409);
}

function finishIntent(store: Store, material: ProjectMaterial, version: number, content: string): { material: ProjectMaterial; writtenToDisk: boolean } {
  let status: ProjectMaterial["status"] = "pending";
  let publicationError: string | undefined;
  try {
    requireCondition(computeSha256(content) === material.source_hash, "MATERIAL_CACHE_CONFLICT", "材料恢复缓存已变化", 409);
    requireCondition(material.operation_id && material.workspace_root && material.protocol_version === 2, "MATERIAL_LEGACY_PENDING", "旧发布意图缺少唯一绑定，不能自动恢复", 409);
    return withMaterialRoot(material.workspace_root, (port) => {
      assertFrozenBinding(store, material, port.identity);
      const logical = material.logical_path && port.read(materialRelativePath(material.logical_path));
      const logicalHash = logical && computeSha256(logical.toString("utf8"));
      requireCondition(!logical || logicalHash === material.source_hash || logicalHash === material.expected_source_hash, "MATERIAL_FILE_CONFLICT", "原路径已有不同正文，已保护原件", 409);
      const path = materialRelativePath(material.path);
      const body = Buffer.from(content.replace(/\r\n/g, "\n"), "utf8");
      port.publish(path, body, material.operation_id!);
      const actual = port.read(path);
      requireCondition(actual?.equals(body), "MATERIAL_FILE_CONFLICT", "不可变材料对象冲突", 409);
      // Still within the held directory handles when validating and committing authority.
      assertFrozenBinding(store, material, port.identity);
      const currentRootIdentity = withMaterialRoot(material.workspace_root!, (current) => current.identity);
      requireCondition(currentRootIdentity === port.identity, "MATERIAL_BINDING_CONFLICT", "材料根目录已迁移", 409);
      port.validate();
      status = "verified";
      const finalRecord: ProjectMaterial = { ...material, status, publication_error: undefined, updated_at: now() };
      store.compareAndSwap("project_material", material.id, material.workflow_id, version, finalRecord);
      return { material: finalRecord, writtenToDisk: true };
    });
  } catch (error) {
    if (error instanceof FlowError && error.code === "VERSION_CONFLICT") throw error;
    publicationError = error instanceof FlowError ? error.code : "MATERIAL_FS_UNSUPPORTED";
    status = publicationError.includes("CONFLICT") || publicationError === "MATERIAL_LEGACY_PENDING" ? "conflict" : "pending";
  }
  const finalRecord: ProjectMaterial = { ...material, status, publication_error: publicationError, updated_at: now() };
  // The intent's exact CAS version is the only permitted fence. Never merge a newer operation.
  store.compareAndSwap("project_material", material.id, material.workflow_id, version, finalRecord);
  return { material: finalRecord, writtenToDisk: false };
}

export function publishProjectMaterialSafely(options: {
  store: Store; locator: MaterialLocator; content: string; cachePath?: string; expectedHash?: string;
}): { material: ProjectMaterial; writtenToDisk: boolean } {
  const { store, locator, content, cachePath } = options;
  resolveMaterialLocator({ store, workflowId: locator.workflow_id, kind: locator.kind, revision: locator.revision, preferredWorkspaceId: locator.workspace_id, customRelPath: locator.relative_path });
  const contentHash = computeSha256(content);
  const materialId = locator.material_id ?? `mat_${locator.workflow_id}_${locator.kind}_r${locator.revision}_${locator.run_id ?? "na"}_${locator.round ?? "na"}`;
  let existing = store.getWithVersion<ProjectMaterial>("project_material", materialId);
  if (existing) requireCondition(existing.data.workflow_id === locator.workflow_id && existing.data.workspace_id === locator.workspace_id && (!existing.data.repo_id || existing.data.repo_id === locator.repo_id) && existing.data.kind === locator.kind && existing.data.revision === locator.revision && existing.data.run_id === locator.run_id && existing.data.round === locator.round, "MATERIAL_BINDING_CONFLICT", "材料标识已绑定其他来源", 409);
  if (existing?.data.status === "verified") {
    // Validate the previous original before allowing a new pointer; never repair missing verified originals from cache.
    readVerifiedProjectMaterial(store, existing.data);
    const refreshed = store.getWithVersion<ProjectMaterial>("project_material", materialId);
    requireCondition(refreshed && refreshed.data.status === "verified" && refreshed.data.path === existing.data.path && refreshed.data.source_hash === existing.data.source_hash && refreshed.data.operation_id === existing.data.operation_id && refreshed.data.workspace_id === existing.data.workspace_id && refreshed.data.run_id === existing.data.run_id, "MATERIAL_BINDING_CONFLICT", "材料引用已前进", 409);
    existing = refreshed;
    if (existing.data.source_hash === contentHash) return { material: existing.data, writtenToDisk: true };
    requireCondition((options.expectedHash ?? locator.expected_hash) === existing.data.source_hash, "MATERIAL_FILE_CONFLICT", "材料更新缺少原版本匹配", 409);
  } else if (existing) {
    requireCondition(existing.data.status === "pending" && existing.data.source_hash === contentHash && existing.data.run_id === locator.run_id && existing.data.round === locator.round, "MATERIAL_INTENT_CONFLICT", "存在其他发布意图或冲突", 409);
    return finishIntent(store, existing.data, existing.version, content);
  }
  const operationId = randomUUID();
  const logical = materialRelativePath(locator.relative_path);
  const objectPath = `${logical}.object-${operationId}.md`;
  let binding: MaterialBinding | undefined;
  let failure: string | undefined;
  try { binding = withMaterialRoot(locator.workspace_root, (port) => workspaceBinding(store, locator, port.identity)); }
  catch (e) { failure = e instanceof FlowError ? e.code : "MATERIAL_FS_UNSUPPORTED"; }
  const intent: ProjectMaterial = {
    id: materialId, workflow_id: locator.workflow_id, repo_id: locator.repo_id, workspace_id: locator.workspace_id,
    path: objectPath, logical_path: logical, kind: locator.kind, revision: locator.revision, run_id: locator.run_id, round: locator.round,
    protocol_version: 2, hash_scheme: "sha256-lf-utf8", source_hash: contentHash, content_hash: contentHash, object_hash: contentHash,
    operation_id: operationId, expected_material_version: existing?.version ?? 0,
    expected_source_hash: options.expectedHash ?? locator.expected_hash,
    workspace_root: resolve(locator.workspace_root), root_identity: binding?.root_identity, material_binding_generation: binding?.generation,
    cache_path: cachePath, status: failure?.includes("CONFLICT") ? "conflict" : "pending", publication_error: failure, created_at: existing?.data.created_at ?? now(), updated_at: now(),
  };
  const saved = store.compareAndSwap("project_material", materialId, locator.workflow_id, existing?.version ?? 0, intent);
  if (!binding) return { material: intent, writtenToDisk: false };
  return finishIntent(store, intent, saved.version, content);
}

export function readProjectMaterialByLocator(options: { store: Store; locator: MaterialLocator; fallbackPendingContent?: string; platformCachePath?: string }): MaterialReadResult {
  const { store, locator } = options;
  const candidates = store.list<ProjectMaterial>("project_material", locator.workflow_id).filter((m) => m.kind === locator.kind && m.revision === locator.revision && m.workspace_id === locator.workspace_id && m.run_id === locator.run_id && m.round === locator.round);
  const material = locator.material_id ? store.get<ProjectMaterial>("project_material", locator.material_id) : candidates.length === 1 ? candidates[0] : undefined;
  if (!material) return { content: "", exists: false, source: "none", is_conflict: candidates.length > 0, locator };
  if (material.workflow_id !== locator.workflow_id || material.workspace_id !== locator.workspace_id || material.kind !== locator.kind || material.revision !== locator.revision || material.run_id !== locator.run_id || material.round !== locator.round) return { content: "", exists: false, source: "project_material", is_conflict: true, conflict_reason: "材料不属于请求来源", locator };
  if (material.status === "pending") return { content: options.fallbackPendingContent ?? "", exists: Boolean(options.fallbackPendingContent), source: "result_pending", locator };
  try { const content = readVerifiedProjectMaterial(store, material); return { content, exists: true, source: "project_material", locator }; }
  catch { return { content: "", exists: false, source: "project_material", is_conflict: true, conflict_reason: "材料原件缺失、绑定变化或内容冲突", locator }; }
}

export function recoverPendingMaterials(store: Store, workflowId?: string): number {
  let count = 0;
  for (const item of store.list<ProjectMaterial>("project_material", workflowId).filter((m) => m.status === "pending")) {
    const current = store.getWithVersion<ProjectMaterial>("project_material", item.id);
    if (!current || current.data.status !== "pending") continue;
    const mat = current.data;
    if (!mat.cache_path || !existsSync(mat.cache_path)) continue;
    let content: string; try { content = readFileSync(mat.cache_path, "utf8"); } catch { continue; }
    try {
      if (finishIntent(store, mat, current.version, content).writtenToDisk) {
        count++;
        store.transaction(() => {
          const doc = store.getWithVersion<{ material_id?: string; plan_revision?: number; run_id?: string; material_status?: string; material_error?: string }>("planning_document", mat.workflow_id);
          if (doc?.data.material_id !== mat.id || doc.data.plan_revision !== mat.revision || doc.data.run_id !== mat.run_id) return;
          store.compareAndSwap("planning_document", mat.workflow_id, mat.workflow_id, doc.version, { ...doc.data, material_status: "verified", material_error: undefined });
          const wf = store.getWithVersion<Workflow>("workflow", mat.workflow_id);
          if (wf && wf.data.plan_revision === mat.revision && wf.data.stage === "material_pending" && ["PLAN_PENDING", "REPAIR_PLAN_PENDING"].includes(wf.data.state) && ["MATERIAL_PENDING", "MATERIAL_CONFLICT"].includes(wf.data.blocker?.code ?? "")) {
            store.compareAndSwap("workflow", mat.workflow_id, mat.workflow_id, wf.version, { ...wf.data, stage: "plan_approval", blocker: undefined, version: wf.data.version + 1, updated_at: now() });
          }
        });
      }
    }
    catch (e) { if (!(e instanceof FlowError && e.code === "VERSION_CONFLICT")) throw e; }
  }
  return count;
}

export const reconcileMaterialOutbox = recoverPendingMaterials;

// 保持向下兼容的轻量 helper 导出
export function getPlanMaterialPath(
  workspaceRoot: string,
  workflowId: string,
  revision?: number,
) {
  const file = revision !== undefined ? `plan-r${revision}.md` : "plan.md";
  const rel = materialRelativePath(`docs/plan/${workflowId}/${file}`);
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
  const rel = materialRelativePath(`docs/plan/${workflowId}/${file}`);
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
  const rel = materialRelativePath(`docs/process/${workflowId}/${filename}`);
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
  const rel = materialRelativePath(`docs/test/evidence/${workflowId}/${round}/${filename}`);
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
  if (rel === undefined) {
    if (options.category === "evidence" || options.category === "test_evidence") {
      rel = `docs/test/evidence/${options.workflowId}/${options.round ?? 1}/${options.filename}`;
    } else {
      rel = `docs/plan/${options.workflowId}/${options.filename}`;
    }
  }
  rel = materialRelativePath(rel);
  requireCondition(["docs/plan/", "docs/process/", "docs/test/evidence/"].some((prefix) => rel!.startsWith(prefix)), "INVALID_PATH", "材料路径不在允许目录中", 400);
  const abs = normalize(resolve(options.workspaceRoot, rel));
  publishMaterialFile(options.workspaceRoot, rel, Buffer.from(options.content, "utf8"), randomUUID());
  return { relativePath: rel, absolutePath: abs };
}

export function readProjectMaterial(options: {
  workspaceRoot: string;
  relativePath: string;
  cachePath?: string;
}) {
  const data = readMaterialFile(options.workspaceRoot, options.relativePath);
  if (data) {
    return {
      exists: true,
      isFromProject: true,
      isFromCache: false,
      content: data.toString("utf8"),
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
