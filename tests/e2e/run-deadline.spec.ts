import { test, expect } from "@playwright/test";

test.describe("Run Deadline and Pause Display", () => {
  test("DF-STAGE-E01 timeout preserves progress and manual continuation", async ({
    page,
  }) => {
    const workflowId = "wf-timeout-test";

    const tasks = Array.from({ length: 42 }, (_, i) => ({
      id: `T${String(i + 1).padStart(2, "0")}`,
      title: `任务 ${i + 1}`,
      module_id: "M1",
      completed: i < 6,
      implementation_status:
        i < 6 ? "completed" : i === 6 ? "active" : "pending",
      status: i < 6 ? "claimed" : "pending",
      summary: i < 6 ? "已完成声明" : "",
    }));

    const progressCases = Array.from({ length: 81 }, (_, i) => ({
      test_id: `TEST-${i + 1}`,
      id: `case-${i + 1}`,
      status: "not_run" as const,
    }));

    const workflow = {
      id: workflowId,
      project_id: "p1",
      title: "超时暂停与恢复测试",
      request: "修复长耗时任务",
      complexity: "complex",
      workspace_mode: "new_worktree",
      state: "BLOCKED",
      stage: "execute",
      version: 5,
      plan_revision: 1,
      plan_hash: "test-hash",
      environment_revision: 1,
      run_id: "run-timeout-1",
      blocker: {
        code: "TIMEOUT",
        message: "本轮执行达到配置时限，现场已保留，可继续执行",
      },
      created_at: "2026-09-14T08:00:00.000Z",
      updated_at: "2026-09-14T09:00:00.000Z",
      feedback: [],
    };

    const events = [
      {
        workflow_id: workflowId,
        event_seq: 1,
        type: "WorkflowCreated",
        payload: { title: workflow.title },
        created_at: "2026-09-14T08:00:00.000Z",
      },
      {
        workflow_id: workflowId,
        event_seq: 2,
        type: "StateChanged",
        payload: {
          from: "EXECUTING",
          to: "BLOCKED",
          blocker: workflow.blocker,
        },
        created_at: "2026-09-14T09:00:00.000Z",
      },
    ];

    const detailData = {
      workflow,
      plan: {
        revision: 1,
        hash: "test-hash",
        plan: {
          task_model: "leaf-v1",
          modules: [{ id: "M1", title: "测试模块" }],
          tasks: [
            {
              id: "T01",
              module_id: "M1",
              title: "任务 1",
              implementation: "实现 1",
              completion: "完成 1",
              depends_on: [],
            },
          ],
          tests: [
            {
              id: "TEST-1",
              task_ids: ["T01"],
              layer: "unit",
              steps: ["step1"],
              assertions: ["assert1"],
              expected_case_ids: ["case-1"],
            },
          ],
        },
      },
      tasks,
      test_progress: {
        total: 81,
        passed: 0,
        failed: 0,
        skipped: 0,
        discovered: 81,
        cases: progressCases,
      },
      runs: [
        {
          id: "run-timeout-1",
          workflow_id: workflowId,
          plan_revision: 1,
          adapter: "agy",
          stage: "execute",
          status: "failed",
          started_at: "2026-09-14T08:00:00.000Z",
          ended_at: "2026-09-14T09:00:00.000Z",
        },
      ],
      events,
      evidence: [],
      project: { id: "p1", name: "测试项目", repositories: [] },
    };

    let resumeCalled = false;
    let approveCalled = false;

    await page.route("**/api/projects", (route) =>
      route.fulfill({ json: [detailData.project] }),
    );
    await page.route("**/api/workflows", (route) =>
      route.fulfill({ json: [workflow] }),
    );
    await page.route(`**/api/workflows/${workflowId}`, (route) =>
      route.fulfill({ json: detailData }),
    );
    await page.route(`**/api/workflows/${workflowId}/events`, (route) =>
      route.fulfill({ json: events }),
    );
    await page.route(`**/api/workflows/${workflowId}/feedback`, (route) => {
      resumeCalled = true;
      return route.fulfill({ json: { ok: true } });
    });
    await page.route(`**/api/workflows/${workflowId}/approve`, (route) => {
      approveCalled = true;
      return route.fulfill({ json: { ok: true } });
    });

    await page.goto("/");
    await page
      .getByRole("button", { name: "超时暂停与恢复测试", exact: true })
      .click();
    if (!await page.locator(".logs").isVisible())
      await page.getByRole("button", { name: "执行过程", exact: true }).click();
    await expect(page.getByLabel("实现提交进度")).toHaveAttribute("value", "6");
    await expect(page.getByLabel("测试通过进度")).toHaveAttribute("value", "0");

    await expect(page.locator("body")).toContainText("执行暂停");
    await expect(page.locator("body")).toContainText("达到配置时限");

    await expect(
      page.getByRole("button", { name: "继续这个任务", exact: true }),
    ).toBeVisible();

    expect(resumeCalled).toBe(false);
    expect(approveCalled).toBe(false);

    await page.screenshot({ path: ".reports/e2e-timeout.png", fullPage: true });
  });

  test("DF-STAGE-E02 manual and historical pauses are not mislabeled", async ({
    page,
  }) => {
    const workflowId = "wf-manual-test";
    const workflow = {
      id: workflowId,
      project_id: "p1",
      title: "人工停止与历史暂停测试",
      request: "测试",
      complexity: "simple",
      workspace_mode: "existing_workspace",
      state: "STOPPED",
      stage: "execute",
      version: 3,
      plan_revision: 1,
      plan_hash: "test-hash",
      environment_revision: 1,
      run_id: "run-stop-1",
      created_at: "2026-09-14T08:00:00.000Z",
      updated_at: "2026-09-14T08:30:00.000Z",
      feedback: [],
    };

    const events = [
      {
        workflow_id: workflowId,
        event_seq: 1,
        type: "Stopped",
        payload: {
          category: "stop",
          source: "local_console",
          message: "你在控制台停止了执行",
        },
        created_at: "2026-09-14T08:30:00.000Z",
      },
    ];

    const detailData = {
      workflow,
      plan: null,
      tasks: [],
      test_progress: {
        passed: 0,
        failed: 0,
        skipped: 0,
        discovered: 0,
        cases: [],
      },
      runs: [],
      events,
      evidence: [],
      project: { id: "p1", name: "测试项目", repositories: [] },
    };

    await page.route("**/api/projects", (route) =>
      route.fulfill({ json: [detailData.project] }),
    );
    await page.route("**/api/workflows", (route) =>
      route.fulfill({ json: [workflow] }),
    );
    await page.route(`**/api/workflows/${workflowId}`, (route) =>
      route.fulfill({ json: detailData }),
    );
    await page.route(`**/api/workflows/${workflowId}/events`, (route) =>
      route.fulfill({ json: events }),
    );

    await page.goto("/");
    await page
      .getByRole("button", { name: "人工停止与历史暂停测试", exact: true })
      .click();
    if (!await page.locator(".logs").isVisible())
      await page.getByRole("button", { name: "执行过程", exact: true }).click();

    await expect(page.locator("body")).toContainText("你在控制台停止了执行");
    await expect(page.locator("body")).not.toContainText("达到配置时限");

    await page.screenshot({
      path: ".reports/e2e-manual-stop.png",
      fullPage: true,
    });
  });
});
