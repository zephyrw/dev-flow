import { test, expect, type Page, type WebSocketRoute } from "@playwright/test";

const workflowId = "wf-interaction-recovery";

async function setupPage(page: Page, failureStatus: number) {
  const workflow = {
    id: workflowId,
    project_id: "p1",
    title: "交互恢复核验",
    state: "HUMAN_PENDING",
    version: 1,
    plan_revision: 1,
  };
  const project = {
    id: "p1",
    name: "隔离测试",
    data: { mode: "directory" },
    repositories: [],
    commands: [],
  };
  const current = {
    available: false,
    queries: 0,
    sockets: [] as WebSocketRoute[],
  };
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/user-interactions/current")) {
      current.queries++;
      return route.fulfill(
        current.available
          ? { json: { interaction: null } }
          : {
              status: failureStatus,
              json: { error: { code: "TEST_FAILURE", message: "测试故障" } },
            },
      );
    }
    if (path === "/api/projects") return route.fulfill({ json: [project] });
    if (path === "/api/workflows") return route.fulfill({ json: [workflow] });
    if (path === `/api/workflows/${workflowId}`)
      return route.fulfill({
        json: {
          workflow,
          project,
          plan: {
            plan: { task_model: "leaf-v1", modules: [], tasks: [], tests: [] },
          },
          tasks: [],
          events: [],
          runs: [],
          evidence: [],
          attention: null,
        },
      });
    return route.fulfill({ json: [] });
  });
  await page.routeWebSocket("**/api/notifications", () => {});
  await page.routeWebSocket("**/api/events?*", (socket) =>
    current.sockets.push(socket),
  );
  await page.goto(`/?workflow=${workflowId}`);
  // At acceptance the execution sidebar starts collapsed; opening it mounts
  // the interaction query, matching the user's screenshot.
  await page.getByRole("button", { name: "执行过程", exact: true }).click();
  await expect(page.locator(".user-interaction-error-banner")).toContainText(
    `HTTP ${failureStatus}`,
  );
  await expect.poll(() => current.sockets.length).toBe(1);
  return current;
}

test("人工验收阶段服务暂时异常后自动恢复，保持当前任务", async ({ page }) => {
  const current = await setupPage(page, 503);
  current.available = true;
  await expect(
    page.locator(".user-interaction-error-banner"),
  ).not.toBeVisible();
  await expect(
    page.getByRole("heading", { name: "交互恢复核验", exact: true }),
  ).toBeVisible();
  await expect(
    page.locator(".user-interaction-pending-banner"),
  ).not.toBeVisible();
});

test("查询曾被拒绝时，WebSocket 重连重新查询并清除旧错误", async ({ page }) => {
  const current = await setupPage(page, 403);
  const before = current.queries;
  current.available = true;
  current.sockets[0]!.close();
  await expect.poll(() => current.sockets.length).toBe(2);
  await expect(
    page.locator(".user-interaction-error-banner"),
  ).not.toBeVisible();
  expect(current.queries).toBeGreaterThan(before);
});

test("查询曾被拒绝时，详情刷新同步交互且不需要点击重试", async ({ page }) => {
  const current = await setupPage(page, 403);
  current.available = true;
  await page.getByRole("button", { name: "开发计划", exact: true }).click();
  await expect(
    page.locator(".user-interaction-error-banner"),
  ).not.toBeVisible();
});
