import { describe, it, expect } from "vitest";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setup, repository, project } from "../helpers.js";
import { git } from "../../packages/git/src/git.js";
import { GitDeliveryCoordinator } from "../../packages/git/src/delivery-coordinator.js";
describe("Git 真实副作用与拒绝路径", { timeout: 60000 }, () => {
  it("旧交付路径使用主工作区实际当前分支", async () => {
    const s = setup(), r = await repository(s.root), p = project(r.repo), workflowId = "current-branch";
    try {
      s.store.put("project", p.id, "global", p);
      s.store.put("workflow", workflowId, p.id, {
        id: workflowId, project_id: p.id, title: "current branch", version: 1,
        plan_revision: 1, plan_hash: "plan", state: "COMMITTING", stage: "review", workspace_mode: "new_worktree",
      });
      s.store.put("quality_gate", workflowId + ":gate:after_human", workflowId, {
        status: "passed", passed_input_fingerprint: { plan_hash: "plan" },
      });
      s.store.put("acceptance", workflowId, workflowId, { confirmed_by: "fixture" });
      const [ws] = await s.engine.git.prepare(p, workflowId, "new_worktree", { main: r.baseline });
      const originalBranch = await git(r.repo, ["symbolic-ref", "--short", "HEAD"]);
      await git(r.repo, ["switch", "-c", "dev"]);
      writeFileSync(join(ws!.root, "app.txt"), "task delivery\n");
      const coordinator = new GitDeliveryCoordinator(s.store, s.config.workspace_root, s.engine.git);
      const result = await coordinator.executeDelivery(workflowId);
      expect(result.integrations[0]).toMatchObject({ status: "success", target_branch: "dev" });
      expect(await git(r.repo, ["symbolic-ref", "--short", "HEAD"])).toBe("dev");
      expect(await git(r.repo, ["rev-parse", originalBranch])).toBe(r.baseline);
      expect(readFileSync(join(r.repo, "app.txt"), "utf8")).toBe("task delivery\n");
      await git(r.repo, ["switch", originalBranch]);
      s.store.put("workflow", workflowId, p.id, { ...s.engine.get(workflowId), state: "COMMIT_PARTIAL" });
      const replay = await coordinator.executeDelivery(workflowId);
      expect(replay.integrations).toEqual(result.integrations);
      expect(await git(r.repo, ["rev-parse", originalBranch])).toBe(r.baseline);
      expect(await git(r.repo, ["symbolic-ref", "--short", "HEAD"])).toBe(originalBranch);
    } finally { s.store.close(); }
  });

  it("主工作区任务提交保留原有 staged/unstaged 文件，且提交只含任务补丁", async () => {
    const s = setup(),
      r = await repository(s.root),
      p = project(r.repo),
      id = "wf-git";
    try {
      writeFileSync(join(r.repo, "user-staged.txt"), "staged\n");
      await git(r.repo, ["add", "user-staged.txt"]);
      writeFileSync(join(r.repo, "user-untracked.txt"), "untracked\n");
      await s.engine.git.prepare(p, id, "existing_workspace", {
        main: r.baseline,
      });
      writeFileSync(join(r.repo, "app.txt"), "after\n");
      const snapshot = await s.engine.git.snapshot(id, 1);
      const commits = await s.engine.git.commit(snapshot, p, "fix: fixture");
      expect(commits).toHaveLength(1);
      const names = await git(r.repo, [
        "diff-tree",
        "--no-commit-id",
        "--name-only",
        "-r",
        "HEAD",
      ]);
      expect(names).toBe("app.txt");
      const status = await git(r.repo, ["status", "--porcelain"]);
      expect(status).toContain("A  user-staged.txt");
      expect(status).toContain("?? user-untracked.txt");
      expect(readFileSync(join(r.repo, "user-staged.txt"), "utf8")).toBe(
        "staged\n",
      );
      expect(await s.engine.git.commit(snapshot, p, "fix: fixture")).toEqual(
        commits,
      );
    } finally {
      s.store.close();
    }
  });
  it("PLANNING 不能清理工作树或伪装提交完成，目录和分支保持不变", async () => {
    const s = setup(),
      r = await repository(s.root),
      p = project(r.repo);
    try {
      s.store.put("project", p.id, "global", p);
      const w = s.engine.create(
        {
          project_id: p.id,
          title: "拒绝清理",
          request: "检查清理门禁",
          complexity: "simple",
          workspace_mode: "new_worktree",
        },
        "create",
      );
      const ws = await s.engine.git.prepare(p, w.id, "new_worktree", {
        main: r.baseline,
      });
      const manager = new GitDeliveryCoordinator(
        s.store,
        s.config.workspace_root,
        s.engine.git,
      );
      await expect(manager.cleanupWorkspaces(w.id, ws)).rejects.toMatchObject({
        code: "EXPLICIT_SELECTION_REQUIRED",
      });
      await expect(manager.cleanupWorkspaces(w.id, ws, { explicit_selection: true })).rejects.toMatchObject({
        code: "INVALID_STATE",
      });
      await expect(manager.executeDelivery(w.id)).rejects.toMatchObject({
        code: "INVALID_STATE",
      });
      expect(await git(ws[0]!.root, ["rev-parse", "HEAD"])).toBe(r.baseline);
      expect(s.engine.get(w.id).state).not.toBe("COMPLETED");
    } finally {
      s.store.close();
    }
  });

  it("轻量调度支持多个任务共用主工作区，前置任务暂停/归档不阻碍新任务准备工作区", async () => {
    const s = setup(),
      r = await repository(s.root),
      p = project(r.repo),
      id1 = "wf-task-1",
      id2 = "wf-task-2";
    try {
      s.store.put("project", p.id, "global", p);
      s.store.put("workflow", id1, p.id, {
        id: id1,
        project_id: p.id,
        title: "前置任务",
        version: 1,
        state: "STOPPED",
        stage: "stopped",
        workspace_mode: "existing_workspace",
      });
      // 前置任务在主工作区有 workspace 记录
      await s.engine.git.prepare(p, id1, "existing_workspace", { main: r.baseline });

      // 新任务也使用主工作区
      s.store.put("workflow", id2, p.id, {
        id: id2,
        project_id: p.id,
        title: "新任务共用主工作区",
        version: 1,
        state: "PLANNING",
        stage: "planning",
        workspace_mode: "existing_workspace",
      });
      // 准备工作区不应抛出 WORKSPACE_BUSY 或 "该工作区已属于其他工作流"
      const ws2 = await s.engine.git.prepare(p, id2, "existing_workspace", { main: r.baseline });
      expect(ws2).toHaveLength(1);
      expect(ws2[0]!.workflow_id).toBe(id2);
      expect(ws2[0]!.root.toLowerCase()).toBe(r.repo.toLowerCase());

      // 验证两个任务的工作区记录独立共存于 store 中
      const allWs = s.store.list<any>("workspace");
      expect(allWs.filter((w) => w.workflow_id === id1)).toHaveLength(1);
      expect(allWs.filter((w) => w.workflow_id === id2)).toHaveLength(1);
    } finally {
      s.store.close();
    }
  });
});
