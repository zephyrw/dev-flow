import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { GitDeliveryCoordinator } from "../../packages/git/src/delivery-coordinator.js";
import { git, repositoryInfo } from "../../packages/git/src/git.js";

/**
 * C01–C08（可隔离验证部分）：规划模型已提交后的本地集成必须执行真实 Git 操作。
 * 不用纯路由结果替代 Git 行为；不生成第二次候选提交，不删除工作树或外部改动。
 */

const scratchRoots: string[] = [];
function scratch(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchRoots.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of scratchRoots)
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
});

function shell(cwd: string, args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
function initRepo(dir: string) {
  shell(dir, ["init", "-b", "main"]);
  shell(dir, ["config", "user.email", "t@example.com"]);
  shell(dir, ["config", "user.name", "t"]);
  shell(dir, ["config", "commit.gpgsign", "false"]);
  shell(dir, ["config", "core.autocrlf", "false"]);
}
function commitAll(dir: string, message: string) {
  shell(dir, ["add", "-A"]);
  shell(dir, ["commit", "-m", message]);
  return shell(dir, ["rev-parse", "HEAD"]);
}

type Seed = Record<string, Record<string, unknown>>;
function memoryStore(seed: Seed = {}) {
  const data = new Map<string, unknown>();
  const events: { type: string; payload: Record<string, unknown> }[] = [];
  const outbox: {
    id: string;
    workflow_id: string;
    kind: string;
    data: string;
    status: string;
  }[] = [];
  let seq = 0;
  for (const [kind, rows] of Object.entries(seed))
    for (const [id, value] of Object.entries(rows)) data.set(kind + ":" + id, value);
  return {
    data,
    events,
    get<T>(kind: string, id: string): T | undefined {
      return data.get(kind + ":" + id) as T | undefined;
    },
    put(kind: string, id: string, _parent: string, value: unknown) {
      data.set(kind + ":" + id, value);
    },
    list<T>(kind: string, _parent: string): T[] {
      const rows: T[] = [];
      for (const [key, value] of data) if (key.startsWith(kind + ":")) rows.push(value as T);
      return rows;
    },
    must<T>(kind: string, id: string): T {
      const value = data.get(kind + ":" + id);
      if (!value) throw new Error("missing " + kind + ":" + id);
      return value as T;
    },
    remove(kind: string, id: string) {
      data.delete(kind + ":" + id);
    },
    transaction<T>(fn: () => T): T {
      return fn();
    },
    event(_w: string, _p: string, type: string, payload: Record<string, unknown>) {
      events.push({ type, payload });
    },
    enqueue(workflowId: string, kind: string, payload: unknown) {
      const id = "job-" + ++seq;
      outbox.push({ id, workflow_id: workflowId, kind, data: JSON.stringify(payload), status: "pending" });
      return id;
    },
    jobs() {
      return outbox
        .filter((job) => job.status === "pending")
        .map(({ id, workflow_id, kind, data }) => ({ id, workflow_id, kind, data }));
    },
    jobStatus(id: string, status: string) {
      const job = outbox.find((item) => item.id === id);
      if (job) job.status = status;
    },
  };
}

const baseWorkflow = (extra: Record<string, unknown> = {}) => ({
  id: "wf",
  project_id: "p",
  title: "t",
  request: "r",
  complexity: "simple",
  workspace_mode: "new_worktree",
  state: "COMMITTING",
  stage: "planner_commit",
  version: 3,
  plan_revision: 1,
  environment_revision: 1,
  run_id: "run-1",
  created_at: "2026-09-23T00:00:00.000Z",
  updated_at: "2026-09-23T00:00:00.000Z",
  feedback: [],
  quality_policy_version: 2,
  ...extra,
});

function coordinator(store: ReturnType<typeof memoryStore>, workspaceRoot: string) {
  return new GitDeliveryCoordinator(store as never, workspaceRoot);
}

async function fastForwardFixture(taskPath = "task.txt", ignored = false) {
  const sourceRepo = scratch("devflow-ff-source-");
  initRepo(sourceRepo);
  writeFileSync(join(sourceRepo, "base.txt"), "base\n");
  if (ignored) writeFileSync(join(sourceRepo, ".gitignore"), taskPath + "\n");
  const baseline = commitAll(sourceRepo, "baseline");
  const taskRoot = join(scratch("devflow-ff-task-"), "task");
  shell(sourceRepo, ["worktree", "add", "-b", "devflow/task", taskRoot]);
  mkdirSync(dirname(join(taskRoot, taskPath)), { recursive: true });
  writeFileSync(join(taskRoot, taskPath), "task content\n");
  if (ignored) shell(taskRoot, ["add", "-f", "--", taskPath]);
  const taskCommit = commitAll(taskRoot, "task by planner");
  const commonDir = realpathSync(
    resolve(realpathSync(taskRoot), await git(taskRoot, ["rev-parse", "--git-common-dir"])),
  );
  const store = memoryStore({
    workflow: { wf: baseWorkflow() },
    project: { p: { id: "p", repositories: [{ id: "main", path: sourceRepo }] } },
    workspace: {
      ws: {
        id: "ws", workflow_id: "wf", repo_id: "main",
        root: realpathSync(taskRoot), common_dir: commonDir,
        baseline, branch: "devflow/task",
        source_root: realpathSync(sourceRepo), source_branch: "main", owned: true,
      },
    },
  });
  const delivery = coordinator(store, scratch("devflow-ff-coordinator-"));
  const integrate = () => delivery.integrateCommittedDelivery("wf", [
    { repo_id: "main", commit: taskCommit },
  ]);
  return { sourceRepo, taskRoot, baseline, taskCommit, store, integrate };
}

describe("planner-commit 真实 Git 集成", () => {
  it("同文件未提交修改阻挡快进时保留原件与 index，并交模型处理而非停在错误", async () => {
    const { sourceRepo, baseline, taskCommit, store, integrate } = await fastForwardFixture("base.txt");
    shell(sourceRepo, ["config", "merge.autoStash", "true"]);
    writeFileSync(join(sourceRepo, "base.txt"), "local staged content\n");
    shell(sourceRepo, ["add", "base.txt"]);
    writeFileSync(join(sourceRepo, "base.txt"), "local unstaged content\n");
    const index = shell(sourceRepo, ["write-tree"]);
    const result = await integrate();
    expect(result.repairInstructions).toContain("保留原有已暂存/未暂存边界");
    expect(result.repairInstructions).toContain("user_interaction");
    expect(result.recoveryFailures?.[0]?.code).toBe("GIT_INTEGRATION_FAILED");
    expect(result.integrations[0]).toMatchObject({ status: "failed", candidate_commit: taskCommit });
    expect(shell(sourceRepo, ["rev-parse", "HEAD"])).toBe(baseline);
    expect(shell(sourceRepo, ["write-tree"])).toBe(index);
    expect(readFileSync(join(sourceRepo, "base.txt"), "utf8")).toBe("local unstaged content\n");
    expect(shell(sourceRepo, ["show", ":base.txt"])).toBe("local staged content");
    expect(store.events.find(event => event.type === "PlannerIntegrationFailed")?.payload.recovery_scheduled).toBe(true);
  });
  it("源工作区不重叠的未跟踪计划文档允许快进，保留原字节和未暂存状态，重试幂等", async () => {
    const { sourceRepo, taskRoot, taskCommit, store, integrate } = await fastForwardFixture();
    const planPath = "docs/plans/current-plan.md";
    const planBytes = Buffer.from("\ufeff# 批准计划\r\n保留原件与换行。\r\n", "utf8");
    mkdirSync(dirname(join(sourceRepo, planPath)), { recursive: true });
    writeFileSync(join(sourceRepo, planPath), planBytes);
    store.put("workflow", "wf", "p", {
      ...store.must<Record<string, unknown>>("workflow", "wf"),
      state: "COMMIT_PARTIAL",
      blocker: { code: "SOURCE_BUSY", message: "上轮被未跟踪计划文档阻塞" },
    });

    const first = await integrate();
    expect(first.integrations[0]!.status).toBe("success");
    expect(shell(sourceRepo, ["rev-parse", "HEAD"])).toBe(taskCommit);
    expect(readFileSync(join(sourceRepo, planPath))).toEqual(planBytes);
    expect(shell(sourceRepo, ["status", "--porcelain", "--untracked-files=all"])).toBe("?? " + planPath);
    expect(shell(sourceRepo, ["diff", "--cached", "--name-only"])).toBe("");
    expect(shell(sourceRepo, ["ls-files", "--", planPath])).toBe("");
    expect(store.must<{ state: string; blocker?: unknown }>("workflow", "wf")).toMatchObject({ state: "COMPLETED" });
    expect(store.must<{ blocker?: unknown }>("workflow", "wf").blocker).toBeUndefined();

    // 模拟回执已持久化但阶段恢复后再次收尾，必须复用同一回执和提交。
    store.put("workflow", "wf", "p", {
      ...store.must<Record<string, unknown>>("workflow", "wf"), state: "COMMIT_PARTIAL",
    });
    const retry = await integrate();
    expect(retry.integrations).toEqual(first.integrations);
    expect(shell(sourceRepo, ["rev-parse", "HEAD"])).toBe(taskCommit);
    expect(shell(sourceRepo, ["rev-list", "--count", "HEAD"])).toBe("2");
    expect(shell(taskRoot, ["rev-parse", "HEAD"])).toBe(taskCommit);
    expect(readFileSync(join(sourceRepo, planPath))).toEqual(planBytes);
    expect(shell(sourceRepo, ["status", "--porcelain", "--untracked-files=all"])).toBe("?? " + planPath);
    expect(shell(sourceRepo, ["diff", "--cached", "--name-only"])).toBe("");
    expect(store.must<{ state: string }>("workflow", "wf").state).toBe("COMPLETED");
  }, 30_000);

  it.each([
    { name: "未跟踪同名文件", taskPath: "overlap.txt", localPath: "overlap.txt", ignored: false },
    { name: "未跟踪父路径文件", taskPath: "overlap/child.txt", localPath: "overlap", ignored: false },
    { name: "未跟踪子路径文件", taskPath: "overlap", localPath: "overlap/child.txt", ignored: false },
    { name: "被忽略的同名文件", taskPath: "overlap.txt", localPath: "overlap.txt", ignored: true },
  ])("$name 阻止快进覆盖，保留文件、候选与具体 blocker", async ({ taskPath, localPath, ignored }) => {
    const { sourceRepo, taskRoot, baseline, taskCommit, store, integrate } = await fastForwardFixture(taskPath, ignored);
    const localBytes = Buffer.from("本地独立内容\r\n\u0000保留\r\n", "utf8");
    mkdirSync(dirname(join(sourceRepo, localPath)), { recursive: true });
    writeFileSync(join(sourceRepo, localPath), localBytes);
    const statusBefore = shell(sourceRepo, ["status", "--porcelain", "--untracked-files=all", "--ignored"]);
    if (ignored) expect(statusBefore).toContain("!! " + localPath);
    const indexBefore = shell(sourceRepo, ["write-tree"]);

    const result = await integrate();

    expect(result.integrations[0]).toMatchObject({ status: "failed", candidate_commit: taskCommit });
    expect(result.repairInstructions).toContain("user_interaction");
    expect(shell(sourceRepo, ["rev-parse", "HEAD"])).toBe(baseline);
    expect(shell(taskRoot, ["rev-parse", "HEAD"])).toBe(taskCommit);
    expect(readFileSync(join(sourceRepo, localPath))).toEqual(localBytes);
    expect(shell(sourceRepo, ["write-tree"])).toBe(indexBefore);
    expect(shell(sourceRepo, ["status", "--porcelain", "--untracked-files=all", "--ignored"])).toBe(statusBefore);
    const wf = store.must<{ state: string; blocker?: { code: string; message: string } }>("workflow", "wf");
    expect(wf.state).toBe("COMMIT_PARTIAL");
    expect(wf.blocker?.code).toBe("GIT_INTEGRATION_FAILED");
    expect(wf.blocker?.message).toContain("overlap");
    expect(store.events.find((event) => event.type === "PlannerIntegrationFailed")?.payload).toMatchObject({
      repo_id: "main", code: "GIT_INTEGRATION_FAILED", message: expect.stringContaining("overlap"),
    });
    expect(store.get<{ commit: string }>("planner_commit_candidate", "wf:run-1:main")?.commit).toBe(taskCommit);
  }, 30_000);

  it.each(["unstaged", "staged"] as const)("源工作区无关 tracked %s 改动允许快进并保留暂存边界", async (change) => {
    const { sourceRepo, taskRoot, baseline, taskCommit, store, integrate } = await fastForwardFixture();
    shell(sourceRepo, ["config", "merge.autoStash", "true"]);
    const localBytes = Buffer.from("用户已有修改\r\n", "utf8");
    writeFileSync(join(sourceRepo, "base.txt"), localBytes);
    if (change === "staged") shell(sourceRepo, ["add", "base.txt"]);
    const statusBefore = shell(sourceRepo, ["status", "--porcelain"]);
    const stagedBefore = shell(sourceRepo, ["diff", "--cached", "--", "base.txt"]);
    const unstagedBefore = shell(sourceRepo, ["diff", "--", "base.txt"]);

    const result = await integrate();

    expect(result.integrations[0]).toMatchObject({ status: "success", candidate_commit: taskCommit });
    expect(shell(sourceRepo, ["rev-parse", "HEAD"])).toBe(taskCommit);
    expect(shell(taskRoot, ["rev-parse", "HEAD"])).toBe(taskCommit);
    expect(readFileSync(join(sourceRepo, "base.txt"))).toEqual(localBytes);
    expect(shell(sourceRepo, ["diff", "--cached", "--", "base.txt"])).toBe(stagedBefore);
    expect(shell(sourceRepo, ["diff", "--", "base.txt"])).toBe(unstagedBefore);
    expect(shell(sourceRepo, ["status", "--porcelain"])).toBe(statusBefore);
    expect(existsSync(join(sourceRepo, "task.txt"))).toBe(true);
    const wf = store.must<{ state: string; blocker?: { code: string; message: string } }>("workflow", "wf");
    expect(wf.state).toBe("COMPLETED");
    expect(wf.blocker).toBeUndefined();
    expect(store.events.find((event) => event.type === "PlannerIntegrationFailed")).toBeUndefined();
  }, 30_000);

  it("C01 existing_workspace 已有规划提交：不重复生成提交，保留无关 index 与工作区内容", async () => {
    const repo = scratch("devflow-c01-");
    initRepo(repo);
    writeFileSync(join(repo, "base.txt"), "base\n");
    const baseline = commitAll(repo, "baseline");
    // 他人未提交改动与未暂存内容
    writeFileSync(join(repo, "other.txt"), "someone else\n");
    shell(repo, ["add", "other.txt"]);
    writeFileSync(join(repo, "loose.txt"), "unstaged\n");
    // 规划模型已提交任务改动
    writeFileSync(join(repo, "task.txt"), "task\n");
    const taskCommit = commitAll(repo, "task by planner");
    // 提交后又出现他人改动，必须保留
    writeFileSync(join(repo, "after.txt"), "kept\n");

    const store = memoryStore({
      workflow: { wf: baseWorkflow({ workspace_mode: "existing_workspace", state: "COMMITTING" }) },
      project: { p: { id: "p", repositories: [{ id: "main", path: repo }] } },
      workspace: {
        ws: {
          id: "ws",
          workflow_id: "wf",
          repo_id: "main",
          root: realpathSync(repo),
          common_dir: join(realpathSync(repo), ".git"),
          baseline,
          branch: "main",
          owned: false,
        },
      },
    });

    const result = await coordinator(store, scratch("devflow-c01-root-")).integrateCommittedDelivery("wf", [
      { repo_id: "main", commit: taskCommit },
    ]);

    expect(result.integrations).toHaveLength(1);
    expect(result.integrations[0]!.status).toBe("success");
    expect(result.integrations[0]!.candidate_commit).toBe(taskCommit);
    expect(result.integrations[0]!.target_branch).toBe("main");
    expect(result.integrations[0]!.source_root).toBe(realpathSync(repo));
    // 平台未生成第二次候选提交
    expect(shell(repo, ["rev-parse", "HEAD"])).toBe(taskCommit);
    // 无关 index 与工作区内容保留
    expect(existsSync(join(repo, "other.txt"))).toBe(true);
    expect(existsSync(join(repo, "loose.txt"))).toBe(true);
    expect(existsSync(join(repo, "after.txt"))).toBe(true);
    expect(shell(repo, ["status", "--porcelain"])).toContain("after.txt");
    expect(store.must<{ state: string }>("workflow", "wf").state).toBe("COMMITTED");
  });

  it("C02 new_worktree 已提交且源分支可快进：源分支包含完整任务历史，回执指向登记源", async () => {
    const sourceRepo = scratch("devflow-c02-src-");
    initRepo(sourceRepo);
    writeFileSync(join(sourceRepo, "base.txt"), "base\n");
    const baseline = commitAll(sourceRepo, "baseline");

    // 受管工作树：从源仓库创建任务分支
    const taskRoot = join(scratch("devflow-c02-task-"), "task");
    shell(sourceRepo, ["worktree", "add", "-b", "devflow/task", taskRoot]);
    writeFileSync(join(taskRoot, "a.txt"), "a\n");
    const commitA = commitAll(taskRoot, "task A");
    writeFileSync(join(taskRoot, "b.txt"), "b\n");
    const commitB = commitAll(taskRoot, "task B");

    const commonDir = realpathSync(
      resolve(realpathSync(taskRoot), await git(taskRoot, ["rev-parse", "--git-common-dir"])),
    );
    const store = memoryStore({
      workflow: { wf: baseWorkflow({ workspace_mode: "new_worktree" }) },
      project: { p: { id: "p", repositories: [{ id: "main", path: sourceRepo }] } },
      workspace: {
        ws: {
          id: "ws",
          workflow_id: "wf",
          repo_id: "main",
          root: realpathSync(taskRoot),
          common_dir: commonDir,
          baseline,
          branch: "devflow/task",
          source_root: realpathSync(sourceRepo),
          source_branch: "main",
          owned: true,
        },
      },
    });

    const result = await coordinator(store, scratch("devflow-c02-root-")).integrateCommittedDelivery("wf", [
      { repo_id: "main", commit: commitB },
    ]);

    expect(result.integrations[0]!.status).toBe("success");
    expect(result.integrations[0]!.candidate_commit).toBe(commitB);
    expect(result.integrations[0]!.source_root).toBe(realpathSync(sourceRepo));
    expect(result.integrations[0]!.target_branch).toBe("main");
    // 源分支包含完整任务历史（快进，两个提交都在）
    expect(shell(sourceRepo, ["rev-parse", "HEAD"])).toBe(commitB);
    const history = shell(sourceRepo, ["log", "--oneline", "--format=%s"]);
    expect(history).toContain("task A");
    expect(history).toContain("task B");
    expect(store.must<{ state: string }>("workflow", "wf").state).toBe("COMPLETED");
    // 工作树保留，不删除
    expect(existsSync(taskRoot)).toBe(true);
  });

  it("C03 多仓库部分失败：成功记录保留，COMMIT_PARTIAL，只重试未完成仓库", async () => {
    const goodRepo = scratch("devflow-c03-good-");
    initRepo(goodRepo);
    writeFileSync(join(goodRepo, "g.txt"), "g\n");
    const goodBase = commitAll(goodRepo, "baseline");
    writeFileSync(join(goodRepo, "gt.txt"), "gt\n");
    const goodCommit = commitAll(goodRepo, "good task");

    const badRepo = scratch("devflow-c03-bad-");
    initRepo(badRepo);
    writeFileSync(join(badRepo, "b.txt"), "b\n");
    const badBase = commitAll(badRepo, "baseline");
    // 目标分支与登记不符（登记 main，实际在 wrong 分支）
    shell(badRepo, ["checkout", "-b", "wrong"]);
    writeFileSync(join(badRepo, "bt.txt"), "bt\n");
    const badCommit = commitAll(badRepo, "bad task");

    const store = memoryStore({
      workflow: { wf: baseWorkflow({ workspace_mode: "existing_workspace", state: "COMMITTING" }) },
      project: {
        p: {
          id: "p",
          repositories: [
            { id: "good", path: goodRepo },
            { id: "bad", path: badRepo },
          ],
        },
      },
      workspace: {
        w1: {
          id: "w1", workflow_id: "wf", repo_id: "good",
          root: realpathSync(goodRepo), common_dir: join(realpathSync(goodRepo), ".git"),
          baseline: goodBase, branch: "main", owned: false,
        },
        w2: {
          id: "w2", workflow_id: "wf", repo_id: "bad",
          root: realpathSync(badRepo), common_dir: join(realpathSync(badRepo), ".git"),
          baseline: badBase, branch: "main", owned: false,
        },
      },
    });

    const result = await coordinator(store, scratch("devflow-c03-root-")).integrateCommittedDelivery("wf", [
      { repo_id: "good", commit: goodCommit },
      { repo_id: "bad", commit: badCommit },
    ]);

    const goodReceipt = result.integrations.find((r) => r.repo_id === "good")!;
    const badReceipt = result.integrations.find((r) => r.repo_id === "bad")!;
    expect(goodReceipt.status).toBe("success");
    expect(badReceipt.status).toBe("failed");
    expect(store.must<{ state: string }>("workflow", "wf").state).toBe("COMMIT_PARTIAL");

    // 再次重试：成功仓库复用已有记录，不再重做
    const retry = await coordinator(store, scratch("devflow-c03-root2-")).integrateCommittedDelivery("wf", [
      { repo_id: "good", commit: goodCommit },
      { repo_id: "bad", commit: badCommit },
    ]);
    expect(retry.integrations.find((r) => r.repo_id === "good")!.candidate_commit).toBe(goodCommit);
    expect(retry.integrations.find((r) => r.repo_id === "good")!.status).toBe("success");
    expect(shell(goodRepo, ["rev-parse", "HEAD"])).toBe(goodCommit);
  });

  it("C04 源仓库不可用：不产生 success 回执，不写 COMMITTED 假结果", async () => {
    const goneRepo = scratch("devflow-c04-");
    initRepo(goneRepo);
    writeFileSync(join(goneRepo, "g.txt"), "g\n");
    const baseline = commitAll(goneRepo, "baseline");
    writeFileSync(join(goneRepo, "t.txt"), "t\n");
    const taskCommit = commitAll(goneRepo, "task");
    // 仓库被移除
    rmSync(goneRepo, { recursive: true, force: true });

    const store = memoryStore({
      workflow: { wf: baseWorkflow({ workspace_mode: "existing_workspace", state: "COMMITTING" }) },
      project: { p: { id: "p", repositories: [{ id: "main", path: goneRepo }] } },
      workspace: {
        ws: {
          id: "ws", workflow_id: "wf", repo_id: "main",
          root: goneRepo, common_dir: join(goneRepo, ".git"),
          baseline, branch: "main", owned: false,
        },
      },
    });

    const result = await coordinator(store, scratch("devflow-c04-root-")).integrateCommittedDelivery("wf", [
      { repo_id: "main", commit: taskCommit },
    ]);
    expect(result.integrations[0]!.status).toBe("failed");
    expect(result.integrations[0]!.status).not.toBe("success");
    const wf = store.must<{ state: string }>("workflow", "wf");
    expect(wf.state).not.toBe("COMMITTED");
    expect(wf.state).not.toBe("COMPLETED");
    // 候选提交仍被冻结记录，供重试使用
    const saved = store.get<{ commit: string }>("planner_commit_candidate", "wf:run-1:main");
    expect(saved?.commit).toBe(taskCommit);
  });

  it("C05 结果重放：集成幂等，不重复 commit，第二次复用成功回执", async () => {
    const sourceRepo = scratch("devflow-c05-src-");
    initRepo(sourceRepo);
    writeFileSync(join(sourceRepo, "base.txt"), "base\n");
    const baseline = commitAll(sourceRepo, "baseline");
    const taskRoot = join(scratch("devflow-c05-task-"), "task");
    shell(sourceRepo, ["worktree", "add", "-b", "devflow/task", taskRoot]);
    writeFileSync(join(taskRoot, "t.txt"), "t\n");
    const taskCommit = commitAll(taskRoot, "task");
    const commonDir = realpathSync(
      resolve(realpathSync(taskRoot), await git(taskRoot, ["rev-parse", "--git-common-dir"])),
    );

    const store = memoryStore({
      workflow: { wf: baseWorkflow({ workspace_mode: "new_worktree" }) },
      project: { p: { id: "p", repositories: [{ id: "main", path: sourceRepo }] } },
      workspace: {
        ws: {
          id: "ws", workflow_id: "wf", repo_id: "main",
          root: realpathSync(taskRoot), common_dir: commonDir,
          baseline, branch: "devflow/task",
          source_root: realpathSync(sourceRepo), source_branch: "main", owned: true,
        },
      },
    });

    const first = await coordinator(store, scratch("devflow-c05-root-")).integrateCommittedDelivery("wf", [
      { repo_id: "main", commit: taskCommit },
    ]);
    expect(first.integrations[0]!.status).toBe("success");
    const headAfterFirst = shell(sourceRepo, ["rev-parse", "HEAD"]);
    expect(headAfterFirst).toBe(taskCommit);

    // 模拟集成已写回执但状态推进前断连：回到可恢复的提交收尾位置再重放
    store.put("workflow", "wf", "p", {
      ...store.must<Record<string, unknown>>("workflow", "wf"),
      state: "COMMIT_PARTIAL",
    });

    // 重放同一完成回调
    const replay = await coordinator(store, scratch("devflow-c05-root2-")).integrateCommittedDelivery("wf", [
      { repo_id: "main", commit: taskCommit },
    ]);
    expect(replay.integrations[0]!.status).toBe("success");
    expect(replay.integrations[0]!.candidate_commit).toBe(taskCommit);
    expect(shell(sourceRepo, ["rev-parse", "HEAD"])).toBe(headAfterFirst);
    // 不产生重复提交
    expect(shell(sourceRepo, ["rev-list", "--count", "HEAD"])).toBe("2");
    // 候选提交冻结不漂移
    const frozen = store.get<{ commit: string }>("planner_commit_candidate", "wf:run-1:main");
    expect(frozen?.commit).toBe(taskCommit);
  });

  it("C07 源分支无冲突分叉：仅预演并交规划模型在最终提交阶段吸收固定源提交", async () => {
    const sourceRepo = scratch("devflow-c07-src-");
    initRepo(sourceRepo);
    writeFileSync(join(sourceRepo, "base.txt"), "base\n");
    const baseline = commitAll(sourceRepo, "baseline");
    const taskRoot = join(scratch("devflow-c07-task-"), "task");
    shell(sourceRepo, ["worktree", "add", "-b", "devflow/task", taskRoot]);
    writeFileSync(join(taskRoot, "t.txt"), "t\n");
    const taskCommit = commitAll(taskRoot, "task");

    // 源分支被推进，形成分叉
    shell(sourceRepo, ["checkout", "main"]);
    writeFileSync(join(sourceRepo, "advance.txt"), "advance\n");
    const advanceCommit = commitAll(sourceRepo, "source advanced");

    const commonDir = realpathSync(
      resolve(realpathSync(taskRoot), await git(taskRoot, ["rev-parse", "--git-common-dir"])),
    );
    const store = memoryStore({
      workflow: { wf: baseWorkflow({ workspace_mode: "new_worktree" }) },
      project: { p: { id: "p", repositories: [{ id: "main", path: sourceRepo }] } },
      workspace: {
        ws: {
          id: "ws", workflow_id: "wf", repo_id: "main",
          root: realpathSync(taskRoot), common_dir: commonDir,
          baseline, branch: "devflow/task",
          source_root: realpathSync(sourceRepo), source_branch: "main", owned: true,
        },
      },
    });

    const result = await coordinator(store, scratch("devflow-c07-root-")).integrateCommittedDelivery("wf", [
      { repo_id: "main", commit: taskCommit },
    ]);

    // 不做 cherry-pick：源分支 HEAD 仍是推进提交
    expect(shell(sourceRepo, ["rev-parse", "HEAD"])).toBe(advanceCommit);
    // 任务提交未被丢弃
    expect(shell(taskRoot, ["rev-parse", "HEAD"])).toBe(taskCommit);
    // 预演无冲突后继续最终提交，不再交实施或执行测试轮次。
    expect(result.repairInstructions).toBeTruthy();
    expect(result.repairInstructions).toContain("吸收");
    expect(result.repairInstructions).toContain("提交阶段");
    expect(result.repairInstructions).toContain(advanceCommit);
    expect(result.repairInstructions).toContain("--no-autostash");
    expect(result.repairInstructions).not.toContain("交执行模型测试后");
    expect(result.integrations).toHaveLength(0);
    expect(store.must<{ state: string }>("workflow", "wf").state).toBe("COMMIT_PARTIAL");
    // 不强迫空提交、不改写任一方历史
    expect(shell(sourceRepo, ["rev-list", "--count", "HEAD"])).toBe("2");
    expect(shell(sourceRepo, ["status", "--porcelain"])).toBe("");
    expect(shell(taskRoot, ["status", "--porcelain"])).toBe("");
    expect(existsSync(resolve(sourceRepo, shell(sourceRepo, ["rev-parse", "--git-path", "MERGE_HEAD"])))).toBe(false);
    expect(existsSync(resolve(taskRoot, shell(taskRoot, ["rev-parse", "--git-path", "MERGE_HEAD"])))).toBe(false);
  });

  it("C07 真实冲突交模型在最终提交阶段解决，预演保留双方现场，新提交合入双方历史后完成", async () => {
    const { sourceRepo, taskRoot, taskCommit, store, integrate } = await fastForwardFixture("base.txt");
    writeFileSync(join(sourceRepo, "base.txt"), "source branch content\n");
    const sourceCommit = commitAll(sourceRepo, "source changes same line");
    const sourceBytes = readFileSync(join(sourceRepo, "base.txt"));
    const taskBytes = readFileSync(join(taskRoot, "base.txt"));
    const sourceIndex = shell(sourceRepo, ["write-tree"]);
    const taskIndex = shell(taskRoot, ["write-tree"]);
    const sourceMergeHead = resolve(sourceRepo, shell(sourceRepo, ["rev-parse", "--git-path", "MERGE_HEAD"]));
    const taskMergeHead = resolve(taskRoot, shell(taskRoot, ["rev-parse", "--git-path", "MERGE_HEAD"]));

    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await integrate();

      expect(result.repairInstructions).toContain("自动逐项解决冲突");
      expect(result.repairInstructions).toContain("user_interaction");
      expect(result.repairInstructions).toContain("base.txt");
      expect(result.repairTargets).toEqual([{ repo_id: "main", source_commit: sourceCommit, candidate_commit: taskCommit }]);
      expect(result.integrations).toEqual([]);
      expect(store.must<{ state: string; blocker?: { code: string; message: string } }>("workflow", "wf")).toMatchObject({
        state: "COMMIT_PARTIAL",
      });
      expect(shell(sourceRepo, ["rev-parse", "HEAD"])).toBe(sourceCommit);
      expect(shell(taskRoot, ["rev-parse", "HEAD"])).toBe(taskCommit);
      expect(readFileSync(join(sourceRepo, "base.txt"))).toEqual(sourceBytes);
      expect(readFileSync(join(taskRoot, "base.txt"))).toEqual(taskBytes);
      expect(shell(sourceRepo, ["write-tree"])).toBe(sourceIndex);
      expect(shell(taskRoot, ["write-tree"])).toBe(taskIndex);
      expect(shell(sourceRepo, ["status", "--porcelain"])).toBe("");
      expect(shell(taskRoot, ["status", "--porcelain"])).toBe("");
      expect(existsSync(sourceMergeHead)).toBe(false);
      expect(existsSync(taskMergeHead)).toBe(false);
    }
    const failures = store.events.filter((event) => event.type === "PlannerIntegrationFailed");
    expect(failures).toHaveLength(0);
    expect(store.get<{ commit: string }>("planner_commit_candidate", "wf:run-1:main")?.commit).toBe(taskCommit);

    store.put("planner_integration_repair", "wf", "wf", { source_run_id: "run-1",
      targets: [{ repo_id: "main", source_commit: sourceCommit, candidate_commit: taskCommit }] });
    store.put("workflow", "wf", "p", { ...store.must<object>("workflow", "wf"), run_id: "run-2" });
    // A model returning the unchanged commit must not cause an automatic retry loop.
    const incomplete = await integrate();
    expect(incomplete.repairInstructions).toContain("INTEGRATION_REPAIR_INCOMPLETE");
    expect(store.must<any>("workflow", "wf").blocker.code).toBe("INTEGRATION_REPAIR_INCOMPLETE");

    // Simulate the model's actual Git work, with a real conflict and merge commit.
    expect(() => shell(taskRoot, ["merge", "--no-commit", "--no-ff", sourceCommit])).toThrow();
    writeFileSync(join(taskRoot, "base.txt"), "task content\nsource branch content\n");
    const resolvedCommit = commitAll(taskRoot, "resolve both changes");
    store.put("workflow", "wf", "p", { ...store.must<object>("workflow", "wf"), run_id: "run-3" });
    const done = await coordinator(store, scratch("devflow-conflict-done-")).integrateCommittedDelivery("wf", [
      { repo_id: "main", commit: resolvedCommit },
    ]);
    expect(done.integrations[0]?.status).toBe("success");
    expect(store.must<any>("workflow", "wf").state).toBe("COMPLETED");
    expect(shell(sourceRepo, ["rev-parse", "HEAD"])).toBe(resolvedCommit);
    expect(shell(sourceRepo, ["merge-base", taskCommit, resolvedCommit])).toBe(taskCommit);
    expect(shell(sourceRepo, ["merge-base", sourceCommit, resolvedCommit])).toBe(sourceCommit);
    expect(readFileSync(join(sourceRepo, "base.txt"), "utf8")).toBe("task content\nsource branch content\n");
  });

  it("C08 无须新提交：existing_workspace 不伪造集成成功，也不删除外部改动", async () => {
    const repo = scratch("devflow-c08-");
    initRepo(repo);
    writeFileSync(join(repo, "base.txt"), "base\n");
    const baseline = commitAll(repo, "baseline");
    // 外部未提交改动
    writeFileSync(join(repo, "base.txt"), "base\nexternal change\n");

    const store = memoryStore({
      workflow: { wf: baseWorkflow({ workspace_mode: "existing_workspace", state: "COMMITTING" }) },
      project: { p: { id: "p", repositories: [{ id: "main", path: repo }] } },
      workspace: {
        ws: {
          id: "ws", workflow_id: "wf", repo_id: "main",
          root: realpathSync(repo), common_dir: join(realpathSync(repo), ".git"),
          baseline, branch: "main", owned: false,
        },
      },
    });

    // 不提供提交信息：按当前工作区实际 Git 对象表达完成，不伪造空提交
    const result = await coordinator(store, scratch("devflow-c08-root-")).integrateCommittedDelivery("wf", []);
    expect(result.integrations[0]!.status).toBe("success");
    expect(result.integrations[0]!.candidate_commit).toBe(baseline);
    // 没有新提交
    expect(shell(repo, ["rev-parse", "HEAD"])).toBe(baseline);
    expect(shell(repo, ["rev-list", "--count", "HEAD"])).toBe("1");
    // 外部改动保留
    expect(shell(repo, ["status", "--porcelain"])).toContain("base.txt");
  });
});
