import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Store } from "../../packages/store/src/store.js";
import { CreateWorkflowService, generateWorkflowId, planWorkflowWorkspaces } from "../../packages/core/src/create-workflow.js";
import { resolveMaterialLocator } from "../../packages/core/src/project-materials.js";
import { DocumentService } from "../../packages/core/src/document-service.js";
import type { Project, Workspace } from "../../packages/contracts/src/index.js";
import { seedCreateAccess } from "../helpers.js";

describe("项目根目录不属于 Git 仓库", () => {
  let fixture: string;
  let root: string;
  let store: Store;
  let service: CreateWorkflowService;
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

  beforeEach(() => {
    fixture = mkdtempSync(join(realpathSync.native(tmpdir()), "devflow-multi-project-"));
    root = join(fixture, "前后端项目");
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "docs", "architecture.md"), "共享文档");
    for (const name of ["backend", "frontend"]) {
      const repo = join(root, name);
      mkdirSync(repo);
      git(repo, "init", "-b", "main");
      git(repo, "config", "user.name", "DevFlow Test");
      git(repo, "config", "user.email", "test@devflow.local");
      writeFileSync(join(repo, "source.txt"), name);
      git(repo, "add", "source.txt");
      git(repo, "commit", "-m", "initial");
    }
    store = new Store(join(fixture, "test.sqlite"));
    seedCreateAccess(store);
    service = new CreateWorkflowService(store);
  });
  afterEach(() => {
    store?.close();
    if (fixture) rmSync(fixture, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
  });

  it("创建两个独立工作树，并将计划原件保存到公共 docs", () => {
    const input = { request_id: "group-isolated", workspace_root: root, workspace_mode: "new_worktree", request_text: "修改前后端" } as const;
    const preview = planWorkflowWorkspaces(store, input, generateWorkflowId(input.request_id));
    expect(preview.repositories.map(r => r.id)).toEqual(["backend", "frontend"]);
    const dirtyPath = join(root, "frontend", "source.txt");
    writeFileSync(dirtyPath, "用户未提交修改");
    const { workflow } = service.execute({ ...input, preview_digest: preview.digest });
    const project = store.must<Project>("project", workflow.project_id);
    expect(project.project_root).toBe(root);
    const workspaces = store.list<Workspace>("workspace", workflow.id);
    expect(workspaces).toHaveLength(2);
    for (const ws of workspaces) {
      expect(ws.root).toBe(join(root, ".worktrees", workflow.id, ws.repo_id));
      expect(git(ws.root, "branch", "--show-current")).toBe(ws.branch);
      expect(readFileSync(join(ws.root, "source.txt"), "utf8")).toBe(ws.repo_id);
    }
    expect(readFileSync(dirtyPath, "utf8")).toBe("用户未提交修改");
    expect(existsSync(join(root, ".git"))).toBe(false);
    const document = new DocumentService(store).publishDocument(workflow.id, "plan", "# 双仓库任务");
    expect(document.path).toBe(join(root, "docs", "plan", workflow.id, "plan.md"));
    expect(resolveMaterialLocator({ store, workflowId: workflow.id, kind: "plan" }).repo_id).toBe("project-docs");
  });

  it("普通模式绑定两个源仓库，并拒绝复用被占用的任一仓库", () => {
    const input = { request_id: "group-existing", workspace_root: root, request_text: "修改前后端" };
    const { workflow } = service.execute(input);
    const workspaces = store.list<Workspace>("workspace", workflow.id);
    expect(workspaces.map(ws => ws.root).sort()).toEqual([join(root, "backend"), join(root, "frontend")]);
    expect(workspaces.every(ws => !ws.owned)).toBe(true);
    expect(() => service.execute({ ...input, request_id: "other" })).toThrow(/已有未完成任务/);
  });

  it("后一个工作树创建失败后保留意图，重开数据库可继续", () => {
    const input = { request_id: "group-recover", workspace_root: root, workspace_mode: "new_worktree", request_text: "修改前后端" } as const;
    const workflowId = generateWorkflowId(input.request_id);
    const obstruction = join(root, "frontend", ".git", "worktrees");
    writeFileSync(obstruction, "block");
    expect(() => service.execute(input)).toThrow();
    expect(existsSync(join(root, ".worktrees", workflowId, "backend", ".git"))).toBe(true);
    expect(store.get("workflow", workflowId)).toBeUndefined();
    expect(store.list("workspace", workflowId)).toHaveLength(0);
    rmSync(obstruction);
    store.close();
    store = new Store(join(fixture, "test.sqlite"));
    service = new CreateWorkflowService(store);
    expect(service.execute(input).workflow.id).toBe(workflowId);
    expect(store.list("workspace", workflowId)).toHaveLength(2);
    expect(service.execute(input).is_existing).toBe(true);
  });
});
