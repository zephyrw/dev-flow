import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Store } from "../../packages/store/src/store.js";
import { CreateWorkflowService } from "../../packages/core/src/create-workflow.js";
import { FlowError } from "../../packages/contracts/src/index.js";

describe("NV-I02 & NV-I13: 项目工作区归属与工作树路径集成测试", () => {
  let tempDir: string;
  let repoDir: string;
  let store: Store;
  let service: CreateWorkflowService;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "devflow-ws-ownership-"));
    repoDir = join(tempDir, "sample-repo");
    const dbPath = join(tempDir, "test.db");
    store = new Store(dbPath);
    service = new CreateWorkflowService(store);

    // 初始化测试 Git 仓库
    execFileSync("git", ["init", repoDir]);
    execFileSync("git", ["config", "user.name", "DevFlow Test"], { cwd: repoDir });
    execFileSync("git", ["config", "user.email", "test@devflow.local"], { cwd: repoDir });
    execFileSync("git", ["commit", "--allow-empty", "-m", "initial commit"], {
      cwd: repoDir,
    });
  });

  afterEach(() => {
    try {
      store.close();
    } catch {}
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it("默认创建模式为 existing_workspace，工作区根直接指向项目目录", () => {
    const result = service.execute({
      request_id: "req-default-001",
      workspace_root: repoDir,
      request_text: "默认现有工作区测试",
    });

    expect(result.workflow.workspace_mode).toBe("existing_workspace");
    const wsList = store.list<any>("workspace", result.workflow.id);
    expect(wsList.length).toBe(1);
    const ws = wsList[0];
    expect(ws.root.toLowerCase()).toBe(repoDir.toLowerCase());
    expect(ws.owned).toBe(false);
  });

  it("显式选择 new_worktree 时，工作树路径位于项目内部 .worktrees 下且加入 git exclude", () => {
    const result = service.execute({
      request_id: "req-worktree-001",
      workspace_root: repoDir,
      request_text: "显式worktree测试",
      workspace_mode: "new_worktree",
    });

    expect(result.workflow.workspace_mode).toBe("new_worktree");
    const wsList = store.list<any>("workspace", result.workflow.id);
    expect(wsList.length).toBe(1);
    const ws = wsList[0];
    expect(ws.root).toContain(".worktrees");
    expect(ws.root).toContain(result.workflow.id);
    expect(ws.owned).toBe(true);

    // 检查 .git/info/exclude 自动包含了 .worktrees/
    const excludeFile = join(repoDir, ".git", "info", "exclude");
    expect(existsSync(excludeFile)).toBe(true);
    const excludeContent = readFileSync(excludeFile, "utf8");
    expect(excludeContent).toContain(".worktrees/");
  });

  it("当工作区已有活动任务时，existing_workspace 拒绝创建，而 new_worktree 允许并行工作", () => {
    // 先创建一个任务占用 existing_workspace
    service.execute({
      request_id: "req-first-busy",
      workspace_root: repoDir,
      request_text: "第一个任务",
      workspace_mode: "existing_workspace",
    });

    // 尝试在同一个工作区创建第二个 existing_workspace 任务，应报错 WORKSPACE_BUSY
    expect(() => {
      service.execute({
        request_id: "req-second-busy",
        workspace_root: repoDir,
        request_text: "第二个任务尝试占用",
        workspace_mode: "existing_workspace",
      });
    }).toThrowError(/已有未完成任务/);

    // 但如果指定 new_worktree，则允许创建独立工作树
    const parallelResult = service.execute({
      request_id: "req-second-parallel",
      workspace_root: repoDir,
      request_text: "并行worktree任务",
      workspace_mode: "new_worktree",
    });

    expect(parallelResult.workflow.workspace_mode).toBe("new_worktree");
  });
});
