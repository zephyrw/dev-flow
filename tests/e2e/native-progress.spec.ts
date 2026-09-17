import { test, expect } from "@playwright/test";

test("native work and test progress follow read-only facts while commands stay collapsed", async ({
  page,
}) => {
  const workflow = {
    id: "wf-native-progress",
    title: "原生进度验收",
    project_id: "p1",
    state: "EXECUTING",
    version: 1,
    plan_revision: 1,
    run_id: "r",
    environment_revision: 0,
    feedback: [],
  };
  const tasks = [
    {
      id: "A",
      title: "后端登录",
      module_id: "backend",
      repo_id: "main",
      paths: ["src"],
    },
    {
      id: "B",
      title: "前端登录",
      module_id: "frontend",
      repo_id: "front",
      paths: ["src/login.ts"],
    },
  ];
  const detail = {
    workflow,
    plan: {
      plan: {
        task_model: "native-v2",
        tasks,
        tests: [],
        markdown: "计划",
        modules: [
          { id: "backend", title: "后端" },
          { id: "frontend", title: "前端" },
        ],
      },
    },
    tasks: tasks.map((t) => ({
      ...t,
      development_status: "pending",
      implementation_status: "pending",
      validation_status: "not_run",
    })),
    runs: [
      {
        id: "r",
        plan_revision: 1,
        status: "running",
        started_at: "2026-09-17T01:00:00.000Z",
      },
    ],
    history_cursor: 5,
    evidence: [],
    events: [],
    workspaces: [
      { repo_id: "main", root: "C:/main" },
      { repo_id: "front", root: "C:/front" },
    ],
    test_progress: {
      total: 26,
      passed: 0,
      failed: 0,
      cases: [
        {
          id: "AT-01",
          test_id: "AT-01",
          task_ids: ["A"],
          layer: "unit",
          status: "not_run",
        },
      ],
    },
    review: null,
    environment: null,
  };
  const mutations: string[] = [];
  await page.route("**/api/**", async (route) => {
    if (route.request().method() !== "GET")
      mutations.push(route.request().url());
    const url = new URL(route.request().url()),
      path = url.pathname;
    await route.fulfill({
      json: /\/(functional-issues|asides)$/.test(path)
        ? []
        : path === "/api/projects"
          ? [{ id: "p1", name: "进度测试" }]
          : path === "/api/workflows"
            ? [workflow]
            : path.endsWith("/history")
              ? {
                  events: [
                    {
                      workflow_id: workflow.id,
                      run_id: "r",
                      event_seq: 0,
                      type: "AgentEvent",
                      created_at: "2026-09-17T01:01:00.000Z",
                      payload: {
                        event: "step_update",
                        step_update: {
                          step_type: "tool",
                          tool_name: "run_command",
                          step_index: 0,
                          state: "DONE",
                          tool_info: {
                            parameters: {
                              CommandLine:
                                "pnpm vitest run\nsecond-line-hidden",
                            },
                            output: " Tests 3 passed (3)",
                          },
                        },
                      },
                    },
                  ],
                  next_before: null,
                }
              : path.endsWith("/diff")
                ? [
                    {
                      repo_id: "main",
                      files: [{ path: "src/login.ts", status: "M" }],
                    },
                  ]
                : detail,
    });
  });
  let socket: any;
  await page.routeWebSocket("**/api/notifications", () => {});
  await page.routeWebSocket("**/api/events?*", (ws) => {
    socket = ws;
  });
  await page.goto(`/?workflow=${workflow.id}`);
  const strip = page.getByLabel("交付进度");
  await expect(strip).toContainText("工作包已开展1/2");
  await expect(strip.getByLabel("自测执行次数")).toContainText("1 次");
  await expect(strip).not.toContainText("尚未生成细项清单");
  await expect(strip).toContainText("计划用例已核验0/26");
  await expect(strip).toContainText(/最近自测：通过\s*3/);
  await page.getByRole("button", { name: "任务进度", exact: true }).click();
  await expect(page.locator(".task-module")).toHaveCount(2);
  await expect(page.locator(".task")).toHaveCount(2);
  await expect(
    page.locator(".task").filter({ hasText: "后端登录" }),
  ).toContainText("进行中");
  await page
    .locator(".task-module")
    .filter({ hasText: "前端登录" })
    .locator("summary")
    .first()
    .click();
  await expect(
    page.locator(".task").filter({ hasText: "前端登录" }),
  ).toContainText("未开始");
  const send = (seq: number, step: number, state: string, output?: string) =>
    socket.send(
      JSON.stringify({
        workflow_id: workflow.id,
        event_seq: seq,
        run_id: "r",
        created_at: new Date().toISOString(),
        type: "AgentEvent",
        payload: {
          event: "step_update",
          step_update: {
            step_type: "tool",
            tool_name: "run_command",
            step_index: step,
            state,
            tool_info: {
              parameters: {
                CommandLine: "pnpm vitest run\nsecond-line-hidden",
              },
              output,
            },
          },
        },
      }),
    );
  await expect.poll(() => !!socket).toBe(true);
  send(1, 1, "ACTIVE");
  await expect(strip).toContainText(/自测运行中\s*1/);
  await page.getByRole("button", { name: "测试结果", exact: true }).click();
  await expect(page.getByLabel("原生自测进度")).toContainText("测试运行中");
  send(
    2,
    1,
    "DONE",
    " Test Files 1 failed (1)\n Tests no tests\nError: bad config",
  );
  await expect(
    page.getByLabel("原生自测进度").locator(".native-test-run").first(),
  ).toContainText("自测失败");
  await expect(strip).toContainText("最近自测：执行失败");
  send(3, 2, "DONE", " Tests 5 passed (5)");
  await expect(strip).toContainText(/最近自测：通过\s*5\s*· 失败\s*0/);
  await expect(strip).toContainText("计划用例已核验0/26");
  const selfTests = page.getByLabel("原生自测进度");
  await expect(selfTests.locator(".native-test-run").first()).toContainText(
    "自测通过",
  );
  await expect(selfTests.locator(".command-full:visible")).toHaveCount(0);
  await selfTests
    .getByRole("button", { name: "展开命令", exact: true })
    .first()
    .click();
  await expect(selfTests.locator(".command-full:visible")).toHaveText(
    "pnpm vitest run\nsecond-line-hidden",
  );
  expect(mutations).toEqual([]);
  await page.screenshot({
    path: ".cache/e2e-native-progress.png",
    fullPage: true,
  });
});
