import { test, expect } from "@playwright/test";

const flow = (id: string) => ({
  id,
  title: `紧凑工作台任务 ${id}`,
  project_id: "compact",
  state: "EXECUTING",
  version: 1,
  plan_revision: 1,
  environment_revision: 1,
});
const flows = [flow("wf-a"), flow("wf-b")];
const event = (id: string, seq: number) => ({
  workflow_id: id,
  event_seq: seq,
  created_at: new Date().toISOString(),
  type: "TaskStarted",
  payload: {
    title: `${id} 正在处理第 ${seq} 项`,
    summary: `${id} 正在处理第 ${seq} 项：检查文件与调用关系`,
  },
});
const detail = (id: string) => ({
  workflow: flow(id),
  tasks: Array.from({ length: 42 }, (_, i) => ({
    id: `t${i}`,
    title: `任务 ${i}`,
    completed: i < 10,
  })),
  test_progress: { total: 81, passed: 22, cases: [] },
  plan: {
    plan: {
      task_model: "leaf-v1",
      markdown: "# 计划\n" + "计划内容\n\n".repeat(200),
    },
  },
  runs: [],
  evidence: [],
  events: Array.from({ length: 80 }, (_, i) => event(id, i + 1)),
  project: {
    repositories: [],
    commands: [],
    data: { mode: "external_lock", fixture_command_id: "fixture" },
    services: [
      { id: "backend", port_pool: "backend" },
      { id: "frontend", port_pool: "frontend" },
    ],
  },
  environment: {
    status: "ready",
    services: [
      { id: "backend", status: "ready" },
      { id: "frontend", status: "ready", origin: "http://localhost:9999" },
    ],
  },
});

test("compact workspace keeps content space and preserves independent live sidebar controls", async ({
  page,
}) => {
  let firstDetail = true;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/workflows/wf-a" && firstDetail) {
      firstDetail = false;
      await new Promise((resolve) => setTimeout(resolve, 1800));
    }
    await route.fulfill({
      json: /\/(functional-issues|asides)$/.test(path)
        ? []
        : path.endsWith("/projects")
          ? [{ id: "compact", name: "布局验收" }]
          : path.endsWith("/workflows")
            ? flows
            : detail(path.split("/").at(-1)!),
    });
  });
  let socket: any;
  await page.routeWebSocket("**/api/notifications", () => {});
  await page.routeWebSocket("**/api/events?*", (ws) => {
    socket = ws;
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?workflow=wf-a");
  await expect(
    page.getByRole("button", { name: "暂停", exact: true }),
  ).toBeEnabled();
  await expect(page.locator(".execution-sidebar")).toBeVisible();
  const body = await page.locator(".module-body").boundingBox();
  // Preserve the current three-row control header while keeping most of the
  // 900 px viewport available to content and its independently scrolling sidebar.
  expect(body!.y).toBeLessThanOrEqual(300);
  expect(body!.height).toBeGreaterThanOrEqual(580);
  await expect(page.getByLabel("开发完成进度")).toHaveAttribute("value", "0");
  await expect(page.locator(".tabs")).not.toContainText("执行过程");
  const handle = page.getByRole("separator");
  await handle.focus();
  await page.keyboard.press("ArrowLeft");
  expect((await page.locator(".execution-sidebar").boundingBox())!.width).toBe(
    400,
  );
  await page.getByRole("button", { name: "开发计划", exact: true }).click();
  await page.locator(".module-body").evaluate((el) => {
    el.scrollTop = 350;
  });
  await page.locator(".logs").evaluate((el) => {
    el.scrollTop = 0;
    el.dispatchEvent(new Event("scroll"));
  });
  await expect(page.getByRole("button", { name: "回到最新" })).toBeVisible();
  socket.send(JSON.stringify(event("wf-a", 81)));
  await expect(page.locator(".logs")).toContainText("第 81 项");
  expect(
    await page.locator(".module-body").evaluate((el) => el.scrollTop),
  ).toBe(350);
  await page.getByRole("button", { name: "收起执行过程" }).click();
  socket.send(JSON.stringify(event("wf-a", 82)));
  await expect(page.locator(".latest-activity")).toContainText("第 82 项");
  await expect(page.locator(".execution-toggle .unread")).toHaveCount(0);
  socket.send(
    JSON.stringify({
      ...event("wf-a", 83),
      type: "EnvironmentFailed",
      payload: { message: "测试服务未就绪" },
    }),
  );
  await expect(page.locator(".execution-toggle .unread")).toHaveCount(0);
  await expect(page.locator(".execution-sidebar")).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".execution-sidebar")).toHaveCount(0);
  await expect(page.locator(".tabs .active")).toHaveText("开发计划");
  await page.getByRole("button", { name: "执行过程", exact: true }).click();
  await page
    .getByRole("button", { name: "紧凑工作台任务 wf-b", exact: true })
    .click();
  await expect(page.locator(".logs")).toContainText("wf-b 正在处理");
  await expect(page.locator(".logs")).not.toContainText("wf-a 正在处理");
  await page.getByRole("button", { name: "本机验证副本", exact: true }).click();
  await expect(page.locator(".environment-summary")).toContainText(
    "数据验证尚未完成",
  );
  await expect(page.getByRole("link", { name: "打开验收页面 ↗" })).toHaveCount(
    0,
  );
  await page.route("**/api/workflows/wf-b/diff", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.fulfill({ json: [] });
  });
  await page.getByRole("button", { name: "代码变更", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "暂停", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "本机验证副本", exact: true }).click();
  await page.route("http://localhost:14811/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<html><script type="module" src="/assets/new-version.js"></script></html>',
    }),
  );
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator(".update-banner")).toContainText("界面已更新");
  await expect(page.locator(".tabs .active")).toHaveText("本机验证副本");
  for (const [width, height] of [
    [1440, 900],
    [1920, 1080],
    [800, 900],
  ]) {
    await page.setViewportSize({ width: width!, height: height! });
    await expect(
      page.getByRole("button", { name: "暂停", exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({ path: `.cache/compact-${width}.png` });
  }
});
