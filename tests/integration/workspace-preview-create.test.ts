import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { Store } from "../../packages/store/src/store.js";
import { CreateWorkflowService, generateWorkflowId } from "../../packages/core/src/create-workflow.js";
import { previewWorktreePath } from "../../packages/git/src/workspace-paths.js";
import type { Workspace } from "../../packages/contracts/src/index.js";

describe("CW2-T05: 工作区预览与创建一致性集成测试", () => {
  let tempDir: string;
  let repoDir: string;
  let store: Store;
  let service: CreateWorkflowService;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "devflow-preview-create-"));
    repoDir = join(tempDir, "sample-repo");
    const dbPath = join(tempDir, "test.db");
    store = new Store(dbPath);
    service = new CreateWorkflowService(store);

    execFileSync("git", ["init", repoDir]);
    execFileSync("git", ["config", "user.name", "DevFlow Test"], { cwd: repoDir });
    execFileSync("git", ["config", "user.email", "test@devflow.local"], { cwd: repoDir });
    writeFileSync(join(repoDir, "README.md"), "# Test Project\n");
    execFileSync("git", ["add", "README.md"], { cwd: repoDir });
    execFileSync("git", ["commit", "-m", "initial commit"], { cwd: repoDir });
  });

  afterEach(() => {
    try {
      store.close();
    } catch {}
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it("CW2-T05: 同一 request 未指定 repo 时，preview 与实际 create 逐字段一致", () => {
    const requestId = "req-preview-align-001";
    const mode = "new_worktree";

    // 1. 调用 previewWorktreePath (使用 generateWorkflowId 计算稳定 workflowId)
    const preview = previewWorktreePath({
      sourceRoot: repoDir,
      workflowId: generateWorkflowId(requestId),
      mode,
    });

    // 2. 验证 preview 前后 FS 和 DB 均无副作用变化
    const wsListBefore = store.list<Workspace>("workspace");
    expect(wsListBefore.length).toBe(0);
    expect(existsSync(preview.target_path)).toBe(false);

    // 3. 实际执行 create
    const result = service.execute({
      request_id: requestId,
      workspace_root: repoDir,
      workspace_mode: mode,
      request_text: "测试创建与预览一致",
    });

    // 4. 验证两者路径、分支、仓库一致
    const ws = store.must<Workspace>("workspace", store.list<Workspace>("workspace", result.workflow.id)[0]!.id);
    expect(ws.root.toLowerCase()).toBe(preview.target_path.toLowerCase());
    expect(ws.branch).toBe(preview.task_branch);
    expect(ws.repo_id).toBe(preview.repo_id);
    expect(result.workflow.workspace_mode).toBe(preview.mode);
    expect(ws.owned).toBe(true);
  });

  it("CW2-T05: existing_workspace 模式下，预览与创建均直接使用选中根，且不建新 worktree", () => {
    const requestId = "req-existing-001";
    const mode = "existing_workspace";

    const preview = previewWorktreePath({
      sourceRoot: repoDir,
      workflowId: `wf-${requestId}`,
      mode,
    });

    expect(preview.target_path.toLowerCase()).toBe(normalize(resolve(repoDir)).toLowerCase());
    expect(preview.mode).toBe("existing_workspace");

    const result = service.execute({
      request_id: requestId,
      workspace_root: repoDir,
      workspace_mode: mode,
      request_text: "测试现有工作区",
    });

    const ws = store.list<Workspace>("workspace", result.workflow.id)[0]!;
    expect(ws.root.toLowerCase()).toBe(normalize(resolve(repoDir)).toLowerCase());
    expect(ws.owned).toBe(false);
  });

  it("CW2-T05: 单 repo 显式路径传入时，preview 与 create 严格使用显式路径", () => {
    const requestId = "req-explicit-001";
    const explicitWorktree = join(tempDir, "custom-worktrees", "custom-branch");

    const preview = previewWorktreePath({
      sourceRoot: repoDir,
      workflowId: `wf-${requestId}`,
      mode: "new_worktree",
      explicitPath: explicitWorktree,
    });

    expect(preview.target_path.toLowerCase()).toBe(normalize(resolve(explicitWorktree)).toLowerCase());

    const result = service.execute({
      request_id: requestId,
      workspace_root: repoDir,
      workspace_mode: "new_worktree",
      worktree_path: explicitWorktree,
      request_text: "显式路径测试",
    });

    const ws = store.list<Workspace>("workspace", result.workflow.id)[0]!;
    expect(ws.root.toLowerCase()).toBe(normalize(resolve(explicitWorktree)).toLowerCase());
  });

  it("CW2-T05: 模糊或不存在的 source_root 必须被拒绝，不猜祖先或任意回退", () => {
    const invalidPath = join(tempDir, "non-existent-folder-xyz");
    expect(() => {
      service.execute({
        request_id: "req-invalid-001",
        workspace_root: invalidPath,
        request_text: "非法路径测试",
      });
    }).toThrow();
  });
});
