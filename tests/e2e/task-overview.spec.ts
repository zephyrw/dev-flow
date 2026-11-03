import { test, expect } from "@playwright/test";
import { navigationFlows, navigationResponse } from "../fixtures/navigation-workbench.js";
import { fixtureState } from "./native-helper.js";

test("长任务卡片不溢出，底部状态和北京时间正确，项目可悬停编辑", async ({ page }) => {
  let name = "workspace-directory";
  const project = () => ({ id: "nav-a", name, repositories: [{ id: "main", path: "/work/workspace-directory" }] });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/projects/nav-a/name") {
      name = route.request().postDataJSON().name;
      return route.fulfill({ json: { name } });
    }
    return route.fulfill({ json: path === "/api/projects" ? [project()] : path === "/api/workflows" ? [{
      ...navigationFlows[0], request: "不换行的超长内容".repeat(100) + "x".repeat(500), updated_at: "2026-11-03T08:20:27Z",
    }] : navigationResponse(path) });
  });
  await page.routeWebSocket("**/api/notifications", () => {});
  await page.routeWebSocket("**/api/events?*", () => {});
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "全部任务", exact: true })).toBeVisible();
  const card = page.locator(".flow-card");
  await expect(card.locator("time")).toHaveText("2026-11-03 16:20:27");
  await expect(card.locator("footer")).toHaveCSS("border-top-width", "0px");
  for (const width of [1440, 800, 390]) {
    if (width === 390) await page.getByRole("button", { name: "收起", exact: true }).click();
    await page.setViewportSize({ width, height: 1000 });
    const bounds = (await card.boundingBox())!;
    for (const child of [card.locator("h3"), card.locator("p"), card.locator("footer")]) {
      const box = (await child.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(bounds.x);
      expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width);
    }
    expect(await card.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    const badge = (await card.locator("footer .badge").boundingBox())!;
    const time = (await card.locator("time").boundingBox())!;
    expect(time.x + time.width).toBeCloseTo(bounds.x + bounds.width - 21, 0);
    expect(badge.x).toBeCloseTo(bounds.x + 21, 0);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "展开", exact: true }).click();
  const label = card.locator(".project-name");
  await expect(label).toHaveAttribute("title", "/work/workspace-directory");
  const edit = card.getByRole("button", { name: "编辑项目名称：workspace-directory" });
  await label.hover();
  await expect(edit).toHaveCSS("opacity", "1");
  await edit.click();
  await card.getByLabel("项目名称", { exact: true }).fill("重新命名");
  await card.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.locator(".project-nav .project-name")).toContainText("重新命名");
  await page.reload();
  await expect(card.locator(".project-name")).toContainText("重新命名");
  await expect(card.locator(".project-name")).toHaveAttribute("title", "/work/workspace-directory");
  await card.getByRole("button", { name: "编辑项目名称：重新命名" }).click();
  await card.getByLabel("项目名称", { exact: true }).fill("未保存");
  await card.getByRole("button", { name: "取消", exact: true }).click();
  await expect(card.locator(".project-name")).toContainText("重新命名");
  await page.screenshot({ path: "output/playwright/task-overview.png", fullPage: true });
});

test("手动创建必须填写最多 20 字的名称，校验失败保留需求", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "+ 新建", exact: true }).click();
  const modal = page.getByRole("dialog", { name: "新建 DevFlow 任务" });
  const title = modal.getByLabel("任务名称", { exact: true });
  await expect(title).toHaveAttribute("required", "");
  await expect(title).toHaveAttribute("maxlength", "20");
  await modal.getByLabel("工作区真实路径").fill(fixtureState().nativeRepo);
  const requirement = "完整需求始终保留，名称与正文分开";
  await modal.locator("textarea").fill(requirement);
  await title.fill("   ");
  await modal.getByRole("button", { name: "创建并开始规划" }).click();
  await expect(modal).toContainText("请填写任务名称");
  await expect(modal.locator("textarea")).toHaveValue(requirement);
  await expect(modal.locator('label[for="create-task-title"] .required-marker')).toHaveCSS("color", "rgb(220, 38, 38)");
  await title.fill("字".repeat(21));
  await expect(title).toHaveValue("字".repeat(20));
  const created = page.waitForRequest((request) => request.url().endsWith("/api/workflows") && request.method() === "POST");
  await page.route("**/api/workflows", (route) => route.request().method() === "POST"
    ? route.fulfill({ status: 422, json: { message: "测试拒绝，保留草稿" } }) : route.continue());
  await modal.getByRole("button", { name: "创建并开始规划" }).click();
  expect((await created).postDataJSON()).toMatchObject({ title: "字".repeat(20), request_text: requirement });
  await expect(modal.locator("textarea")).toHaveValue(requirement);
});
