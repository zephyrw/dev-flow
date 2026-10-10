import { removeDirWithBoundedRetry } from "../fixtures/isolation.js";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getPlanMaterialPath,
  getReviewMaterialPath,
  getProcessMaterialPath,
  getEvidenceMaterialPath,
  readProjectMaterial,
  writeProjectMaterial,
  resolveProjectMaterialPath,
} from "../../packages/core/src/project-materials.js";

describe("项目材料与证据原件管理 (NV-U09)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(realpathSync.native(tmpdir()), "devflow-material-test-"));
  });

  afterEach(() => {
    removeDirWithBoundedRetry(tempDir);
  });

  it("NV-U09: 正式计划路径约定为 docs/plan/<任务ID>/plan-r<版本>.md", () => {
    const res = getPlanMaterialPath(tempDir, "wf-001", 2);
    expect(res.relativePath).toBe("docs/plan/wf-001/plan-r2.md");
    expect(res.absolutePath).toContain("docs");
  });

  it("NV-U09: 审查结论路径约定为 docs/plan/<任务ID>/review-r<轮次>.md", () => {
    const res = getReviewMaterialPath(tempDir, "wf-001", 1);
    expect(res.relativePath).toBe("docs/plan/wf-001/review-r1.md");
  });

  it("NV-U09: 过程接续说明路径约定为 docs/process/<任务ID>/handover.md", () => {
    const res = getProcessMaterialPath(tempDir, "wf-001");
    expect(res.relativePath).toBe("docs/process/wf-001/handover.md");
  });

  it("NV-U09: 长期测试证据路径约定为 docs/test/evidence/<任务ID>/<轮次>/evidence.json", () => {
    const res = getEvidenceMaterialPath(tempDir, "wf-001", 1, "test-report.json");
    expect(res.relativePath).toBe("docs/test/evidence/wf-001/1/test-report.json");
  });

  it("NV-U09: 原件优先读取：当项目原件存在时优先读取项目原件，忽略旧缓存", () => {
    const rel = "docs/plan/wf-test/plan.md";
    writeProjectMaterial({
      workspaceRoot: tempDir,
      workflowId: "wf-test",
      category: "plan",
      filename: "plan.md",
      content: "# 项目原件正文",
      customRelPath: rel,
    });

    const cacheFile = join(tempDir, "cache.md");
    writeFileSync(cacheFile, "# 平台旧缓存", "utf8");

    const readRes = readProjectMaterial({
      workspaceRoot: tempDir,
      relativePath: rel,
      cachePath: cacheFile,
    });

    expect(readRes.exists).toBe(true);
    expect(readRes.isFromProject).toBe(true);
    expect(readRes.isFromCache).toBe(false);
    expect(readRes.content).toBe("# 项目原件正文");
  });

  it("NV-U09: 缓存回退读取：项目原件缺失时允许从平台缓存读取", () => {
    const rel = "docs/plan/wf-missing/plan.md";
    const cacheFile = join(tempDir, "cache.md");
    writeFileSync(cacheFile, "# 平台备用缓存", "utf8");

    const readRes = readProjectMaterial({
      workspaceRoot: tempDir,
      relativePath: rel,
      cachePath: cacheFile,
    });

    expect(readRes.exists).toBe(true);
    expect(readRes.isFromProject).toBe(false);
    expect(readRes.isFromCache).toBe(true);
    expect(readRes.content).toBe("# 平台备用缓存");
  });
});

import { Store } from "../../packages/store/src/store.js";
import {
  sanitizeRelativePath,
  resolveMaterialLocator,
  publishProjectMaterialSafely,
  recoverPendingMaterials,
  migrateMaterialBinding,
  validateMaterialMigration,
  readVerifiedProjectMaterial,
} from "../../packages/core/src/project-materials.js";
import type { Workspace, Project, ProjectMaterial } from "../../packages/contracts/src/index.js";
import { createHash } from "node:crypto";
import { ProjectAssetMigrationService } from "../../packages/core/src/project-asset-migration.js";

function expectFlowError(fn: () => void, expectedCode: string) {
  try {
    fn();
    expect.unreachable("应当抛出异常");
  } catch (err: any) {
    expect(err.code).toBe(expectedCode);
  }
}

describe("F05_FILESYSTEM_BOUNDARY: 相对路径安全校验与边界保护", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(realpathSync.native(tmpdir()), "devflow-f05-test-"));
  });

  afterEach(() => {
    removeDirWithBoundedRetry(tempDir);
  });

  it("先检查绝对路径/盘符/UNC路径，禁止以 / 或 \\ 开头或包含盘符/UNC，抛出 INVALID_PATH", () => {
    expectFlowError(() => sanitizeRelativePath(tempDir, "/etc/passwd"), "INVALID_PATH");
    expectFlowError(() => sanitizeRelativePath(tempDir, "\\Windows\\System32"), "INVALID_PATH");
    expectFlowError(() => sanitizeRelativePath(tempDir, "C:/Users/file.txt"), "INVALID_PATH");
    expectFlowError(() => sanitizeRelativePath(tempDir, "D:\\data\\file.txt"), "INVALID_PATH");
    expectFlowError(() => sanitizeRelativePath(tempDir, "//server/share/file.txt"), "INVALID_PATH");
    expectFlowError(() => sanitizeRelativePath(tempDir, "\\\\server\\share\\file.txt"), "INVALID_PATH");
  });

  it("按路径段检查 '..' 父目录段，禁止目录穿越抛出 INVALID_PATH", () => {
    expectFlowError(() => sanitizeRelativePath(tempDir, "docs/../secret.txt"), "INVALID_PATH");
    expectFlowError(() => sanitizeRelativePath(tempDir, ".."), "INVALID_PATH");
    expectFlowError(() => sanitizeRelativePath(tempDir, "a/b/../../c"), "INVALID_PATH");
  });

  it("不误伤包含 '..' 的合法文件名，如 a..b.md", () => {
    const res1 = sanitizeRelativePath(tempDir, "docs/plan/a..b.md");
    expect(res1).toBe("docs/plan/a..b.md");

    const res2 = sanitizeRelativePath(tempDir, "report..v2.json");
    expect(res2).toBe("report..v2.json");
  });
});

describe("F02_WORKSPACE_FALLBACK: 工作区唯一定位与歧义拦截", () => {
  let tempDir: string;
  let store: Store;
  const wfId = "wf-ws-fallback-test";

  beforeEach(() => {
    tempDir = mkdtempSync(join(realpathSync.native(tmpdir()), "devflow-f02-test-"));
    store = new Store(join(tempDir, "test.db"));
  });

  afterEach(() => {
    store.close();
    removeDirWithBoundedRetry(tempDir);
  });

  it("显式指定的 preferredWorkspaceId 无效时立即抛出 WORKSPACE_NOT_FOUND，不得回退", () => {
    const ws1: Workspace = {
      id: "ws-valid-1",
      workflow_id: wfId,
      repo_id: "repo-1",
      source_root: tempDir,
      root: tempDir,
    } as any;
    store.put("workspace", ws1.id, wfId, ws1);

    expectFlowError(() => {
      resolveMaterialLocator({
        store,
        workflowId: wfId,
        kind: "plan",
        preferredWorkspaceId: "ws-non-existent",
      });
    }, "WORKSPACE_NOT_FOUND");
  });

  it("单工作区时自动选择唯一定位", () => {
    const ws1: Workspace = {
      id: "ws-single",
      workflow_id: wfId,
      repo_id: "repo-1",
      source_root: tempDir,
      root: tempDir,
    } as any;
    store.put("workspace", ws1.id, wfId, ws1);

    const loc = resolveMaterialLocator({
      store,
      workflowId: wfId,
      kind: "plan",
    });
    expect(loc.workspace_id).toBe("ws-single");
  });

  it("多工作区未配置 project.primary_repo_id 抛出 WORKSPACE_AMBIGUOUS，禁止 fallback 到 workspaces[0]", () => {
    const ws1: Workspace = {
      id: "ws-multi-1",
      workflow_id: wfId,
      repo_id: "repo-1",
      source_root: tempDir,
      root: tempDir,
    } as any;
    const ws2: Workspace = {
      id: "ws-multi-2",
      workflow_id: wfId,
      repo_id: "repo-2",
      source_root: tempDir,
      root: tempDir,
    } as any;
    store.put("workspace", ws1.id, wfId, ws1);
    store.put("workspace", ws2.id, wfId, ws2);

    expectFlowError(() => {
      resolveMaterialLocator({
        store,
        workflowId: wfId,
        kind: "plan",
      });
    }, "WORKSPACE_AMBIGUOUS");
  });

  it("多工作区配置了 primary_repo_id 但对应多个工作区抛出 WORKSPACE_AMBIGUOUS", () => {
    const projId = "proj-test";
    store.put("workflow", wfId, wfId, { id: wfId, project_id: projId });
    store.put("project", projId, projId, {
      id: projId,
      primary_repo_id: "repo-main",
    } as any);

    const ws1: Workspace = {
      id: "ws-dup-1",
      workflow_id: wfId,
      repo_id: "repo-main",
      source_root: tempDir,
      root: tempDir,
    } as any;
    const ws2: Workspace = {
      id: "ws-dup-2",
      workflow_id: wfId,
      repo_id: "repo-main",
      source_root: tempDir,
      root: tempDir,
    } as any;
    store.put("workspace", ws1.id, wfId, ws1);
    store.put("workspace", ws2.id, wfId, ws2);

    expectFlowError(() => {
      resolveMaterialLocator({
        store,
        workflowId: wfId,
        kind: "plan",
      });
    }, "WORKSPACE_AMBIGUOUS");
  });
});

describe("F03_PUBLICATION_OVERWRITE & F03_RECOVERY_BINDING: 不可变发布与对账协议", () => {
  let tempDir: string;
  let store: Store;
  const wfId = "wf-f03-test";
  const wsId = "ws-f03-1";

  beforeEach(() => {
    tempDir = mkdtempSync(join(realpathSync.native(tmpdir()), "devflow-f03-test-"));
    store = new Store(join(tempDir, "test.db"));
    store.put("workspace", wsId, wfId, {
      id: wsId,
      workflow_id: wfId,
      repo_id: "main",
      source_root: tempDir,
      root: tempDir,
    } as any);
  });

  afterEach(() => {
    store.close();
    removeDirWithBoundedRetry(tempDir);
  });

  it("发布新材料时使用短事务 CAS 创建发布意图，目标既有异内容未传 expectedHash 判定为 conflict", () => {
    const loc = resolveMaterialLocator({ store, workflowId: wfId, kind: "plan", revision: 1 });
    
    // 磁盘预先写入已有异内容
    mkdirSync(join(tempDir, "docs", "plan", wfId), { recursive: true });
    writeFileSync(loc.absolute_path, "# 外部已有冲突内容");

    const res = publishProjectMaterialSafely({
      store,
      locator: loc,
      content: "# 新计划正文",
    });

    expect(res.writtenToDisk).toBe(false);
    expect(res.material.status).toBe("conflict");
    // 磁盘内容未被覆盖
    expect(readFileSync(loc.absolute_path, "utf8")).toBe("# 外部已有冲突内容");
  });

  it("匹配 expectedHash 后发布独立对象并保留既有原件", () => {
    const loc = resolveMaterialLocator({ store, workflowId: wfId, kind: "plan", revision: 1 });
    const oldContent = "# 旧版正文";
    const oldHash = createHash("sha256").update(oldContent, "utf8").digest("hex");
    mkdirSync(join(tempDir, "docs", "plan", wfId), { recursive: true });
    writeFileSync(loc.absolute_path, oldContent);

    const res = publishProjectMaterialSafely({
      store,
      locator: loc,
      content: "# 新版正文",
      expectedHash: oldHash,
    });

    expect(res.writtenToDisk).toBe(true);
    expect(res.material.status).toBe("verified");
    expect(readFileSync(loc.absolute_path, "utf8")).toBe(oldContent);
    expect(readFileSync(join(tempDir, res.material.path), "utf8")).toBe("# 新版正文");
  });

  it("旧 pending 缺少冻结根身份和 operation 时明确冲突，不猜测当前工作区", () => {
    const loc = resolveMaterialLocator({ store, workflowId: wfId, kind: "plan", revision: 1 });
    const content = "# 待恢复正文";
    const contentHash = createHash("sha256").update(content, "utf8").digest("hex");
    const cacheFile = join(tempDir, "cache-plan.md");
    writeFileSync(cacheFile, content, "utf8");

    // 模拟初始 pending 意图记录
    const mat: ProjectMaterial = {
      id: loc.material_id!,
      workflow_id: wfId,
      repo_id: loc.repo_id,
      workspace_id: wsId,
      path: loc.relative_path,
      kind: "plan",
      revision: 1,
      source_hash: contentHash,
      cache_path: cacheFile,
      status: "pending",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    store.put("project_material", mat.id, wfId, mat);

    const count = recoverPendingMaterials(store, wfId);
    expect(count).toBe(0);

    const recovered = store.get<ProjectMaterial>("project_material", mat.id);
    expect(recovered?.status).toBe("conflict");
    expect(existsSync(loc.absolute_path)).toBe(false);
  });

  it("recoverPendingMaterials 当缓存文件哈希与 source_hash 不一致时标记为 conflict，不写入磁盘", () => {
    const loc = resolveMaterialLocator({ store, workflowId: wfId, kind: "plan", revision: 1 });
    const content = "# 真实正文";
    const contentHash = createHash("sha256").update(content, "utf8").digest("hex");
    const cacheFile = join(tempDir, "tampered-cache.md");
    writeFileSync(cacheFile, "# 被篡改的缓存正文", "utf8");

    const mat: ProjectMaterial = {
      id: loc.material_id!,
      workflow_id: wfId,
      repo_id: loc.repo_id,
      workspace_id: wsId,
      path: loc.relative_path,
      kind: "plan",
      revision: 1,
      source_hash: contentHash, // 真实预期哈希
      cache_path: cacheFile,
      status: "pending",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    store.put("project_material", mat.id, wfId, mat);

    const count = recoverPendingMaterials(store, wfId);
    expect(count).toBe(0);

    const recovered = store.get<ProjectMaterial>("project_material", mat.id);
    expect(recovered?.status).toBe("conflict");
    expect(existsSync(loc.absolute_path)).toBe(false);
  });
  it("v2 已发布对象但未提交状态的重放固定 operation 与对象，恢复两次不产生新正文", () => {
    const loc = resolveMaterialLocator({ store, workflowId: wfId, kind: "plan", revision: 1 });
    const cache = join(tempDir, "replay.md");
    writeFileSync(cache, "# replay\r\nbody", "utf8");
    const published = publishProjectMaterialSafely({ store, locator: loc, content: "# replay\r\nbody", cachePath: cache });
    expect(published.material.status).toBe("verified");
    store.put("project_material", published.material.id, wfId, { ...published.material, status: "pending" });
    expect(recoverPendingMaterials(store, wfId)).toBe(1);
    expect(recoverPendingMaterials(store, wfId)).toBe(0);
    const actual = store.get<ProjectMaterial>("project_material", published.material.id)!;
    expect(actual.operation_id).toBe(published.material.operation_id);
    expect(actual.path).toBe(published.material.path);
    expect(readFileSync(join(tempDir, actual.path), "utf8")).toBe("# replay\nbody");
  });

  it("v2 CRLF 字节变更在迁移和回滚前拒绝，保留记录、绑定及原件", async () => {
    const loc = resolveMaterialLocator({ store, workflowId: wfId, kind: "plan", revision: 1 });
    const published = publishProjectMaterialSafely({ store, locator: loc, content: "# original\nbody\n" });
    const bindingBefore = store.getWithVersion("material_binding", wsId);
    const materialBefore = store.getWithVersion("project_material", published.material.id);
    const changed = "# original\r\nbody\r\n";
    writeFileSync(join(tempDir, published.material.path), changed);
    expectFlowError(() => validateMaterialMigration(store, wsId, tempDir), "MATERIAL_MIGRATION_CONFLICT");
    expectFlowError(() => migrateMaterialBinding(store, wsId, tempDir), "MATERIAL_MIGRATION_CONFLICT");
    const initialRoot = join(tempDir, "original-location");
    const record = { id: "migration-crlf", workflow_id: wfId, workspace_id: wsId, request_id: "rollback-crlf", mode: "move_worktree", stage: "committed", source_root: tempDir, initial_root: initialRoot, target_root: tempDir, files: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    store.put("project_asset_migration", record.id, wfId, record);
    const service = new ProjectAssetMigrationService(store, tempDir);
    await expect(service.rollback(wfId, record.id, record.request_id)).rejects.toMatchObject({ code: "MATERIAL_MIGRATION_CONFLICT" });
    expect(store.get("project_asset_migration", record.id)).toEqual(record);
    expect(store.getWithVersion("material_binding", wsId)).toEqual(bindingBefore);
    expect(store.getWithVersion("project_material", published.material.id)).toEqual(materialBefore);
    expect(existsSync(initialRoot)).toBe(false);
    expect(readFileSync(join(tempDir, published.material.path), "utf8")).toBe(changed);
  });

  it.each([1, 2])("协议 v%s 原件迁移后仍可核验，v1 保留 CRLF 兼容", (protocol) => {
    const original = "# original\nbody\n";
    const text = protocol === 1 ? original.replace(/\n/g, "\r\n") : original;
    const destination = join(tempDir, "moved-root");
    mkdirSync(join(destination, "docs", "plan"), { recursive: true });
    const path = "docs/plan/original.md";
    writeFileSync(join(destination, path), text);
    const digest = createHash("sha256").update(original).digest("hex");
    const material: ProjectMaterial = { id: "mat-migrate", workflow_id: wfId, workspace_id: wsId, repo_id: "main", kind: "plan", revision: 1, path, status: "verified", source_hash: digest, ...(protocol === 2 ? { protocol_version: 2 as const, object_hash: digest, content_hash: digest, hash_scheme: "sha256-lf-utf8" as const } : {}), created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    store.put("project_material", material.id, wfId, material);
    const ws = store.must<Workspace>("workspace", wsId);
    store.put("workspace", wsId, wfId, { ...ws, root: destination });
    migrateMaterialBinding(store, wsId, destination);
    const migrated = store.must<ProjectMaterial>("project_material", material.id);
    expect(readVerifiedProjectMaterial(store, migrated)).toBe(text);
    expect(migrated.path).toBe(path);
    expect(migrated.source_hash).toBe(digest);
    expect(migrated.material_binding_generation).toBe(1);
  });

  it("pending 的绑定 generation 已前进时不可恢复到新工作区", () => {
    const loc = resolveMaterialLocator({ store, workflowId: wfId, kind: "plan", revision: 1 });
    const cache = join(tempDir, "binding.md");
    writeFileSync(cache, "# binding", "utf8");
    const published = publishProjectMaterialSafely({ store, locator: loc, content: "# binding", cachePath: cache });
    store.put("project_material", published.material.id, wfId, { ...published.material, status: "pending" });
    const binding = store.get<{ generation: number }>("material_binding", wsId)!;
    store.put("material_binding", wsId, wfId, { ...binding, generation: binding.generation + 1 });
    expect(recoverPendingMaterials(store, wfId)).toBe(0);
    expect(store.get<ProjectMaterial>("project_material", published.material.id)?.status).toBe("conflict");
  });

  it("verified 原件丢失后相同正文不能借缓存重建并伪装重放成功", () => {
    const loc = resolveMaterialLocator({ store, workflowId: wfId, kind: "plan", revision: 1 });
    const first = publishProjectMaterialSafely({ store, locator: loc, content: "# original" });
    rmSync(join(tempDir, first.material.path));
    expect(() => publishProjectMaterialSafely({ store, locator: loc, content: "# original" })).toThrow();
  });

  it("ADS、空路径段与生成配置目录穿越均拒绝，a..b.md 保持合法", () => {
    expect(() => resolveProjectMaterialPath(tempDir, "docs/plan/a.md:secret")).toThrow();
    expect(() => resolveProjectMaterialPath(tempDir, "docs//a.md")).toThrow();
    expect(resolveProjectMaterialPath(tempDir, "docs/plan/a..b.md")).toContain("a..b.md");
    store.put("workflow", wfId, wfId, { id: wfId, project_id: "project-path-config" });
    store.put("project", "project-path-config", "project-path-config", { id: "project-path-config", repositories: [{ id: "main", material_paths: { plan_dir: "docs/../outside" } }] });
    expect(() => resolveMaterialLocator({ store, workflowId: wfId, kind: "plan" })).toThrow();
    expect(() => resolveMaterialLocator({ store, workflowId: wfId, kind: "plan", customRelPath: " " })).toThrow();
  });

  it("最终 CAS 遇到已前进的指针时保留新意图，不能把旧操作标为 verified", () => {
    const loc = resolveMaterialLocator({ store, workflowId: wfId, kind: "plan", revision: 1 });
    const original = store.compareAndSwap.bind(store);
    const spy = vi.spyOn(store, "compareAndSwap").mockImplementation(<T>(kind: string, key: string, owner: string, version: number, value: T) => {
      if (kind === "project_material" && (value as ProjectMaterial).status === "verified") {
        store.put(kind, key, owner, { ...(value as ProjectMaterial), operation_id: "newer-operation", status: "pending" });
      }
      return original<T>(kind, key, owner, version, value);
    });
    try {
      expect(() => publishProjectMaterialSafely({ store, locator: loc, content: "# CAS" })).toThrow();
      const current = store.get<ProjectMaterial>("project_material", loc.material_id!)!;
      expect(current.operation_id).toBe("newer-operation");
      expect(current.status).toBe("pending");
    } finally { spy.mockRestore(); }
  });

  it("材料目录被 junction/symlink 指向另一目录时拒绝且不写入目标", () => {
    const target = join(tempDir, "attacker");
    mkdirSync(target);
    symlinkSync(target, join(tempDir, "docs"), process.platform === "win32" ? "junction" : "dir");
    const loc = resolveMaterialLocator({ store, workflowId: wfId, kind: "plan", revision: 1 });
    const published = publishProjectMaterialSafely({ store, locator: loc, content: "# blocked" });
    expect(published.material.status).toBe("conflict");
    expect(existsSync(join(target, "plan"))).toBe(false);
  });

});
