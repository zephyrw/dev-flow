import { test, expect } from "@playwright/test";

test("build failure retains submitted progress and explains the local verification copy", async ({
  page,
}) => {
  const workflow = {
    id: "wf-build-failure",
    project_id: "p1",
    title: "编译失败现场",
    state: "BLOCKED",
    stage: "blocked",
    version: 5,
    plan_revision: 1,
    environment_revision: 0,
    run_id: "run-failed",
    updated_at: "2026-09-14T11:00:00Z",
    blocker: {
      code: "BUILD_FAILED",
      message: "engine.ts(759): error TS1127: Invalid character.",
    },
  };
  const tasks = [
    "needs_changes",
    "needs_recheck",
    "needs_recheck",
    "needs_recheck",
  ].map((status, i) => ({
    id: `T0${i + 1}`,
    title: `实现 ${i + 1}`,
    module_id: "M1",
    has_implementation: true,
    completed: false,
    implementation_status: status,
    status: "claimed",
    summary: "之前已提交的实现记录仍然保留",
    recheck_reason: i
      ? "前置任务变更，等待前置实现核验；本任务实现记录保留"
      : "本任务文件已修改，需要重新核验实现",
  }));
  const detail = {
    workflow,
    tasks,
    plan: {
      plan: {
        task_model: "leaf-v1",
        modules: [{ id: "M1", title: "实现清单" }],
        tasks,
        tests: [],
        markdown: "# 修复",
      },
    },
    test_progress: { total: 17, passed: 0, failed: 0, stale: 0, cases: [] },
    project: {
      id: "p1",
      name: "本机项目",
      repositories: [],
      commands: [],
      services: [{ id: "frontend", port_pool: "frontend" }],
      data: { mode: "directory" },
    },
    runs: [],
    evidence: [],
    environment: {
      status: "failed",
      error: workflow.blocker.message,
      services: [],
    },
    events: [
      {
        workflow_id: workflow.id,
        event_seq: 1,
        created_at: "2026-09-14T11:00:00Z",
        run_id: "run-failed",
        type: "BuildFailed",
        payload: { message: workflow.blocker.message },
      },
    ],
  };
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({
      json: path.endsWith("/projects")
        ? [detail.project]
        : path.endsWith("/workflows")
          ? [workflow]
          : detail,
    });
  });
  await page.routeWebSocket("**/api/notifications", () => {});
  await page.routeWebSocket("**/api/events?*", () => {});
  await page.goto("/?workflow=" + workflow.id);
  await expect(page.getByLabel("实现提交进度")).toHaveAttribute("value", "4");
  await expect(page.getByLabel("测试通过进度")).toHaveAttribute("value", "0");
  await expect(page.locator(".delivery-strip")).toContainText("已提交实现");
  await expect(page.locator(".delivery-strip")).not.toContainText("已完成任务");
  await page.getByRole("button", { name: "执行过程", exact: true }).click();
  await expect(page.locator(".logs")).toContainText("构建失败，执行已阻断");
  await page.getByRole("button", { name: "任务进度", exact: true }).click();
  await expect(page.locator(".task-module")).toContainText("已提交 4 / 4");
  await expect(page.locator(".task .badge.needs_recheck")).toHaveCount(3);
  await expect(page.locator(".task-module")).not.toContainText("未开始");
  await page.getByRole("button", { name: "本机验证副本", exact: true }).click();
  await expect(page.locator(".environment-summary")).toContainText("127.0.0.1");
  await expect(page.locator(".environment-summary")).toContainText(
    "端口由本机空闲端口池分配",
  );
  await expect(page.locator(".environment-summary")).toContainText("TS1127");
  await page.screenshot({
    path: ".cache/resume-loop-incident/local-copy-ui.png",
    fullPage: true,
  });
});
