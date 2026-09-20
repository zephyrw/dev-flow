import { test, expect, type Page } from "@playwright/test";

test("不完整审查的继续按钮交给规划复核，不重启开发或清空证据", async ({
  page,
}) => {
  const workflow = {
    id: "wf-review-completion",
    title: "审查结论待辨认验证",
    project_id: "p1",
    state: "BLOCKED",
    stage: "blocked",
    version: 1,
    plan_revision: 1,
    environment_revision: 0,
    feedback: [],
    run_id: "run-review",
    updated_at: new Date().toISOString(),
    blocker: {
      code: "REVIEW_INCOMPLETE",
      message: "未能辨认审查结论",
    },
  };
  const detail = {
    workflow,
    plan: null,
    tasks: [],
    evidence: [],
    operations: [],
    events: [],
    runs: [],
  };
  const posts: string[] = [];
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === "POST") {
      posts.push(path);
      workflow.state = "REVIEW_QUEUED";
      workflow.stage = "quality_before_human";
      return route.fulfill({ json: workflow });
    }
    return route.fulfill({
      json:
        path === "/api/projects"
          ? [{ id: "p1", name: "隔离页面" }]
          : path === "/api/workflows"
            ? [workflow]
            : /\/(asides|functional-issues|messages)$/.test(path)
              ? []
              : detail,
    });
  });
  await page.routeWebSocket("**/api/notifications", () => {});
  await page.routeWebSocket("**/api/events?*", () => {});
  await page.goto("/");
  await page
    .getByRole("button")
    .filter({ has: page.getByRole("heading", { name: workflow.title }) })
    .click();
  await page.getByRole("button", { name: "继续审查", exact: true }).click();
  await expect
    .poll(() => posts)
    .toEqual(["/api/workflows/wf-review-completion/review/retry"]);
  await expect(
    page.getByRole("button", { name: "继续审查", exact: true }),
  ).toHaveCount(0);
});

test("审查需要用户时等待指导，回答后回到原审查队列", async ({ page }) => {
  const workflow = {
    id: "wf-review-need-user",
    title: "审查求助恢复",
    project_id: "p1",
    state: "WAITING_INPUT",
    stage: "quality_before_human",
    version: 2,
    plan_revision: 1,
    run_id: "run-review-ask",
    updated_at: new Date().toISOString(),
    blocker: {
      code: "REVIEW_NEEDS_USER",
      message: "缺配置项名称",
    } as { code: string; message: string } | undefined,
  };
  const detail = reviewDetail(workflow, {
    developed: 1,
    attention: {
      category: "guidance",
      message: "缺配置项名称",
      action: "输入指导并继续",
      at: workflow.updated_at,
    },
  });
  const posts: { path: string; body: any }[] = [];
  await mockWorkbench(page, {
    workflow,
    detail,
    onPost: (path, body) => {
      posts.push({ path, body });
      workflow.state = "REVIEW_QUEUED";
      workflow.blocker = undefined;
      detail.attention = {
        category: "queue",
        message: "执行已完成，等待规划模型审查代码质量",
        action: "查看执行过程",
        at: workflow.updated_at,
      };
      return workflow;
    },
  });
  await page.goto("/?workflow=" + workflow.id);
  await expect(page.locator(".header-title-wrapper .badge")).toContainText(
    "等待你的指导",
  );
  await expect(page.locator(".attention-strip")).toContainText("缺配置项名称");
  await expect(
    page.getByRole("button", { name: "继续审查", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "输入指导并继续", exact: true }).click();
  await expect(page.locator(".guidance-form textarea")).toBeVisible();
  await page.locator(".guidance-form textarea").fill("配置项名为 API_BASE");
  await page.getByRole("button", { name: "发送指导并继续", exact: true }).click();
  await expect.poll(() => posts.map((item) => item.path)).toEqual([
    "/api/workflows/wf-review-need-user/feedback",
  ]);
  expect(posts[0]?.body).toMatchObject({
    text: "配置项名为 API_BASE",
    scope: "within_plan",
  });
  await expect(page.locator(".header-title-wrapper .badge")).toContainText(
    "等待代码审查",
  );
  await expect(
    page.getByRole("button", { name: "继续审查", exact: true }),
  ).toHaveCount(0);
});

test("审查结论不明时留在审查队列续问，不进入等待用户", async ({ page }) => {
  const workflow = {
    id: "wf-review-unclear",
    title: "审查不明续问",
    project_id: "p1",
    state: "REVIEW_QUEUED",
    stage: "quality_before_human",
    version: 3,
    plan_revision: 1,
    run_id: "run-review-unclear",
    updated_at: new Date().toISOString(),
  };
  await mockWorkbench(page, {
    workflow,
    detail: reviewDetail(workflow, {
      developed: 1,
      attention: {
        category: "queue",
        message: "规划模型正在审查。",
        action: "查看执行过程",
        at: workflow.updated_at,
      },
    }),
  });
  await page.goto("/?workflow=" + workflow.id);
  await expect(page.locator(".header-title-wrapper .badge")).toContainText(
    "等待代码审查",
  );
  await expect(page.locator(".header-title-wrapper .badge")).not.toContainText(
    "等待你的指导",
  );
  await expect(
    page.getByRole("button", { name: "继续审查", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".guidance-form textarea")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "发送指导并继续", exact: true }),
  ).toHaveCount(0);
});

test("规划求助结束后运行故障仍回到执行，不再派发规划", async ({ page }) => {
  const workflow = {
    id: "wf-planner-recover",
    title: "规划求助后恢复",
    project_id: "p1",
    state: "BLOCKED",
    stage: "execute",
    version: 8,
    plan_revision: 2,
    run_id: "run-exec-retry",
    updated_at: new Date().toISOString(),
    blocker: {
      code: "NATIVE_RUN_FAILED",
      message: "CLI 未正常完成",
    },
  };
  await mockWorkbench(page, {
    workflow,
    detail: reviewDetail(workflow, {
      developed: 0,
      attention: {
        category: "runtime",
        message: "CLI 未正常完成",
        action: "已处理，继续原任务",
        at: workflow.updated_at,
      },
    }),
  });
  await page.goto("/?workflow=" + workflow.id);
  await expect(page.locator(".header-title-wrapper .badge")).toContainText(
    "需要处理",
  );
  await expect(page.locator(".header-title-wrapper .badge")).not.toContainText(
    "规划中",
  );
  await expect(page.getByLabel("运行问题处理方法")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "已处理，继续原任务", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "批准计划", exact: true }),
  ).toHaveCount(0);
});

test("执行中不把旧完成进度当成已完成，审查中显示本轮完成", async ({
  page,
}) => {
  const executing = {
    id: "wf-review-progress",
    title: "整改进度投影",
    project_id: "p1",
    state: "EXECUTING",
    stage: "execute",
    version: 4,
    plan_revision: 1,
    run_id: "run-repair",
    updated_at: new Date().toISOString(),
  };
  await mockWorkbench(page, {
    workflow: executing,
    detail: reviewDetail(executing, { developed: 0 }),
  });
  await page.goto("/?workflow=" + executing.id);
  const strip = page.getByLabel("交付进度");
  await expect(
    strip.locator(".metric-chip").filter({ hasText: "开发完成" }),
  ).toContainText("0/1");
  await page.getByRole("button", { name: "任务进度", exact: true }).click();
  await expect(page.locator(".task .badge")).toHaveText("进行中");

  const reviewing = {
    ...executing,
    state: "REVIEWING",
    stage: "quality_before_human",
    run_id: "run-review-current",
    version: 5,
  };
  await page.unroute("**/api/**");
  await mockWorkbench(page, {
    workflow: reviewing,
    detail: reviewDetail(reviewing, { developed: 1 }),
  });
  await page.reload();
  await expect(
    page.getByLabel("交付进度").locator(".metric-chip").filter({
      hasText: "开发完成",
    }),
  ).toContainText("1/1");
  await page.getByRole("button", { name: "任务进度", exact: true }).click();
  await expect(page.locator(".task .badge")).toHaveText("开发完成");
});

test("大积压历史补拉会把连续事件分段展示到执行过程", async ({ page }) => {
  const workflow = {
    id: "wf-review-catchup",
    title: "审查事件补拉",
    project_id: "p1",
    state: "REVIEWING",
    stage: "quality_before_human",
    version: 6,
    plan_revision: 1,
    run_id: "run-review-catchup",
    updated_at: new Date().toISOString(),
  };
  await mockWorkbench(page, {
    workflow,
    detail: reviewDetail(workflow, { developed: 1 }),
    history: (before) => {
      if (!before) {
        return {
          events: [
            stateEvent(workflow.id, 3, "REVIEWING"),
            stateEvent(workflow.id, 4, "REVIEWING"),
          ],
          next_before: 3,
        };
      }
      return {
        events: [
          stateEvent(workflow.id, 1, "REVIEW_QUEUED"),
          stateEvent(workflow.id, 2, "REVIEWING"),
        ],
        next_before: null,
      };
    },
  });
  await page.goto("/?workflow=" + workflow.id);
  await page.getByRole("button", { name: "执行过程", exact: true }).click();
  await expect(page.locator(".execution-sidebar")).toContainText(
    "等待规划模型审查",
    { timeout: 15000 },
  );
});

function reviewDetail(
  workflow: any,
  options: { developed: number; attention?: any },
) {
  const done = options.developed > 0;
  return {
    workflow,
    plan: {
      plan: {
        task_model: "leaf-v1",
        modules: [{ id: "M1", title: "文本修复" }],
        tasks: [],
        tests: [],
      },
    },
    tasks: [
      {
        id: "T1",
        title: "改文本",
        module_id: "M1",
        development_status: done ? "completed" : "in_progress",
        implementation_status: done ? "completed" : "in_progress",
        status: done ? "completed" : "pending",
        completed: done,
        has_implementation: done,
      },
    ],
    task_counts: { total: 1, developed: options.developed, verified: 0 },
    evidence: [],
    operations: [],
    events: [],
    runs: [],
    attention: options.attention ?? null,
  };
}

function stateEvent(workflow: string, event_seq: number, to: string) {
  return {
    workflow_id: workflow,
    event_seq,
    type: "StateChanged",
    created_at: new Date().toISOString(),
    payload: { to, stage: "quality_before_human" },
  };
}

async function mockWorkbench(
  page: Page,
  options: {
    workflow: any;
    detail: any;
    history?: (before: string | null) => any;
    onPost?: (path: string, body: any) => any;
  },
) {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (route.request().method() === "POST") {
      return route.fulfill({
        json: options.onPost?.(path, route.request().postDataJSON()) ?? options.workflow,
      });
    }
    if (path.endsWith("/history")) {
      return route.fulfill({
        json: options.history?.(url.searchParams.get("before")) ?? {
          events: [],
          next_before: null,
        },
      });
    }
    return route.fulfill({
      json:
        path === "/api/projects"
          ? [{ id: options.workflow.project_id, name: "隔离页面" }]
          : path === "/api/workflows"
            ? [options.workflow]
            : /\/(asides|functional-issues|messages)$/.test(path)
              ? []
              : options.detail,
    });
  });
  await page.routeWebSocket("**/api/notifications", () => {});
  await page.routeWebSocket("**/api/events?*", () => {});
}
