import { test, expect } from "@playwright/test";
import { navigationFlows, navigationResponse } from "../fixtures/navigation-workbench.js";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/**", (route) => route.fulfill({
    json: navigationResponse(new URL(route.request().url()).pathname),
  }));
  await page.routeWebSocket("**/api/notifications", () => {});
  await page.routeWebSocket("**/api/events?*", () => {});
});

test("项目默认显示五个任务且展开相互独立，截断名称 hover 显示全文", async ({ page }) => {
  await page.goto("/");
  const first = page.locator(".project-nav").nth(0);
  const second = page.locator(".project-nav").nth(1);
  const five = page.locator(".project-nav").nth(2);
  await expect(first.locator(".flow-nav-item")).toHaveCount(5);
  const taskTitle = first.locator(".flow-title-text").first();
  const taskRow = first.locator(".flow-nav-item").first();
  const titleBounds = (await taskTitle.boundingBox())!;
  const rowBounds = (await taskRow.boundingBox())!;
  expect(titleBounds.x + titleBounds.width).toBeGreaterThan(rowBounds.x + rowBounds.width - 12);
  await taskTitle.hover();
  await expect(taskRow.getByRole("button", { name: "归档", exact: true })).toHaveCSS("opacity", "1");
  expect(await taskTitle.boundingBox()).toEqual(titleBounds);
  expect(await taskRow.locator(".btn-archive-icon").evaluate((element) => getComputedStyle(element).backgroundImage)).toContain("linear-gradient");
  await page.getByRole("heading", { name: "任务总览", exact: true }).hover();
  await expect(second.locator(".flow-nav-item")).toHaveCount(5);
  await expect(five.locator(".flow-nav-item")).toHaveCount(5);
  await expect(five.locator(".project-tasks-toggle")).toHaveCount(0);
  const toggle = first.getByRole("button", { name: "展开剩余 2 个任务" });
  expect(await toggle.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe("rgb(31, 41, 55)");
  const fifthBox = await first.locator(".flow-nav-item").nth(4).boundingBox();
  expect((await toggle.boundingBox())!.y).toBeGreaterThanOrEqual(fifthBox!.y + fifthBox!.height);
  await toggle.click();
  await expect(first.locator(".flow-nav-item")).toHaveCount(7);
  await expect(second.locator(".flow-nav-item")).toHaveCount(5);
  await first.getByRole("button", { name: "收起任务" }).click();
  await expect(first.locator(".flow-nav-item")).toHaveCount(5);
  await first.locator(".flow-title-text").first().hover();
  await expect(page.getByRole("tooltip")).toHaveText(navigationFlows[0]!.title);
  await page.screenshot({ path: ".cache/navigation-hover.png" });
  await first.locator(".flow-title-text").nth(1).hover();
  await expect(page.getByRole("tooltip")).toHaveCount(0);
});

test("默认侧栏加宽四分之一，拖动和键盘调整保存并在重新打开后恢复", async ({ page, context }) => {
  await page.goto("/?workflow=nav-a-0");
  const sidebar = page.locator(".layout > aside");
  await expect(sidebar).toHaveCSS("width", "312.5px");
  const handle = page.getByRole("separator", { name: "调整任务导航宽度" });
  const bounds = (await handle.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width / 2, 450);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 + 100, 450, { steps: 8 });
  await page.mouse.up();
  await expect(sidebar).toHaveCSS("width", "412.5px");
  await handle.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(sidebar).toHaveCSS("width", "392.5px");
  await page.reload();
  await expect(sidebar).toHaveCSS("width", "392.5px");
  await page.getByRole("button", { name: "收起", exact: true }).click();
  await expect(handle).toBeHidden();
  await page.getByRole("button", { name: "展开", exact: true }).click();
  await expect(sidebar).toHaveCSS("width", "392.5px");
  const restored = await context.browser()!.newContext({ storageState: await context.storageState() });
  const nextPage = await restored.newPage();
  await nextPage.route("**/api/**", (route) => route.fulfill({ json: navigationResponse(new URL(route.request().url()).pathname) }));
  await nextPage.routeWebSocket("**/api/notifications", () => {});
  await nextPage.routeWebSocket("**/api/events?*", () => {});
  await nextPage.goto(page.url());
  await expect(nextPage.locator(".layout > aside")).toHaveCSS("width", "392.5px");
  await restored.close();
  await page.setViewportSize({ width: 800, height: 900 });
  await expect(sidebar).toHaveCSS("width", "68px");
  await expect(handle).toBeHidden();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(sidebar).toHaveCSS("width", "392.5px");
});

test("模型图标和文字左对齐且执行模型保留原横坐标，非法宽度回退默认值", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("devflow.navigationWidth", "Infinity"));
  await page.goto("/?workflow=nav-a-0");
  await expect(page.locator(".layout > aside")).toHaveCSS("width", "312.5px");
  await expect(page.locator(".runtime-row-btn")).toHaveCount(2);
  const icons = page.locator(".runtime-row-icon");
  const text = page.locator(".runtime-row-text");
  expect((await icons.nth(0).boundingBox())!.x).toBe((await icons.nth(1).boundingBox())!.x);
  expect((await text.nth(0).boundingBox())!.x).toBe((await text.nth(1).boundingBox())!.x);
  const executorX = (await icons.nth(1).boundingBox())!.x;
  await page.addStyleTag({ content: ".runtime-row-btn { justify-content: center; }" });
  expect((await icons.nth(1).boundingBox())!.x).toBe(executorX);
});
