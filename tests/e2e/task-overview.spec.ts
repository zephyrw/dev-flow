import { test, expect } from "@playwright/test";
import { navigationFlows, navigationResponse } from "../fixtures/navigation-workbench.js";
import { fixtureState } from "./native-helper.js";

test("长任务卡片不溢出，底部状态和北京时间正确，项目可悬停编辑", async ({ page }) => {
  let name = "workspace-directory";
  let title = navigationFlows[0]!.title;
  let detached = false;
  let deleteRequests = 0;
  let rejectRename = true;
  const project = () => ({ id: "nav-a", name, repositories: [{ id: "main", path: "/work/workspace-directory" }] });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/projects/nav-a" && route.request().method() === "DELETE") {
      deleteRequests += 1;
      expect(route.request().postDataJSON()).toEqual({ confirmed: true });
      detached = true;
      return route.fulfill({ json: { detached: true } });
    }
    if (path === "/api/workflows/nav-a-0/name") {
      if (rejectRename) { rejectRename = false; return route.fulfill({ status: 500, json: { error: { message: "名称保存失败" } } }); }
      title = route.request().postDataJSON().title;
      return route.fulfill({ json: { title } });
    }
    if (path === "/api/projects/nav-a/name") {
      name = route.request().postDataJSON().name;
      return route.fulfill({ json: { name } });
    }
    return route.fulfill({ json: path === "/api/projects" ? (detached ? [] : [project()]) : path === "/api/workflows" ? (detached ? [] : [{
      ...navigationFlows[0], title, request: "不换行的超长内容".repeat(100) + "x".repeat(500), updated_at: "2026-11-03T08:20:27Z",
    }]) : navigationResponse(path) });
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
  await expect(label).not.toHaveAttribute("title");
  await label.hover();
  await expect(page.getByRole("tooltip")).toHaveText("/work/workspace-directory", { timeout: 400 });
  await expect(page.getByRole("tooltip")).toHaveCount(1);
  const edit = card.getByRole("button", { name: "编辑项目名称：workspace-directory" });
  await label.hover();
  await expect(edit).toHaveCSS("opacity", "1");
  await edit.click();
  const projectDialog = page.getByRole("dialog", { name: "修改项目名称", exact: true });
  await expect(projectDialog).toBeVisible();
  const dialogBox = (await projectDialog.boundingBox())!;
  expect(dialogBox.x + dialogBox.width / 2).toBeCloseTo(720, 0);
  expect(dialogBox.y + dialogBox.height / 2).toBeCloseTo(500, 0);
  await expect(card.locator("input")).toHaveCount(0);
  await projectDialog.getByLabel("项目名称", { exact: true }).fill("重新命名");
  await projectDialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.locator(".project-nav .project-name")).toContainText("重新命名");
  await page.reload();
  await expect(card.locator(".project-name")).toContainText("重新命名");
  await card.locator(".project-name").hover();
  await expect(page.getByRole("tooltip")).toHaveText("/work/workspace-directory", { timeout: 400 });
  await card.getByRole("button", { name: "编辑项目名称：重新命名" }).click();
  await projectDialog.getByLabel("项目名称", { exact: true }).fill("未保存");
  await projectDialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(card.locator(".project-name")).toContainText("重新命名");
  const taskTitle = card.locator("h3");
  await taskTitle.hover();
  await expect(page.getByRole("tooltip")).toHaveText(title, { timeout: 400 });
  await expect(page.getByRole("tooltip")).toHaveCount(1);
  expect(await taskTitle.evaluate((element) => element.closest("[title]"))).toBeNull();
  const taskEdit = card.getByRole("button", { name: `编辑任务名称：${title}`, exact: true });
  await expect(taskEdit).toHaveCSS("opacity", "1");
  await taskEdit.click();
  const taskDialog = page.getByRole("dialog", { name: "修改任务名称", exact: true });
  await taskDialog.getByLabel("任务名称", { exact: true }).fill(" ");
  await expect(taskDialog.getByRole("button", { name: "保存", exact: true })).toBeDisabled();
  await taskDialog.getByLabel("任务名称", { exact: true }).fill("更新后的任务名");
  await taskDialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(taskDialog.getByRole("alert")).toHaveText("名称保存失败");
  await expect(taskDialog.getByLabel("任务名称", { exact: true })).toHaveValue("更新后的任务名");
  await taskDialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(taskDialog).toBeHidden();
  await expect(taskTitle).toHaveText("更新后的任务名");
  await expect(page.locator(".flow-nav-item .flow-title-text")).toHaveText("更新后的任务名");
  await page.reload();
  await expect(taskTitle).toHaveText("更新后的任务名");
  await page.locator(".flow-nav-item").hover();
  await page.locator(".flow-nav-item").getByRole("button", { name: "编辑任务名称：更新后的任务名", exact: true }).click();
  await expect(taskDialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(taskDialog).toBeHidden();
  await page.getByRole("heading", { name: "全部任务", exact: true }).hover();
  await page.screenshot({ path: "output/playwright/task-name-actions.png", fullPage: true });
  await card.locator(".project-name").hover();
  const remove = card.getByRole("button", { name: "删除项目：重新命名", exact: true });
  await expect(remove).toHaveCSS("opacity", "1");
  await remove.click();
  const confirmation = page.getByRole("dialog", { name: "删除项目", exact: true });
  await expect(confirmation).toContainText("只删除这个工作台的项目关联，不会删除项目文件");
  expect(deleteRequests).toBe(0);
  await confirmation.getByRole("button", { name: "取消", exact: true }).click();
  await expect(card).toBeVisible();
  expect(deleteRequests).toBe(0);
  await remove.click();
  await confirmation.getByRole("button", { name: "确认删除", exact: true }).click();
  await expect(card).toHaveCount(0);
  expect(deleteRequests).toBe(1);
  await page.reload();
  await expect(page.locator(".project-nav")).toHaveCount(0);
  await expect(card).toHaveCount(0);
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


test("运行任务隐藏归档和项目删除入口，包括已有归档任务仍在运行的项目", async ({ page }) => {
  let running = true;
  let archivedRunning = false;
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({ json: path === "/api/projects"
      ? [{ id: "nav-a", name: "运行限制项目", has_running_tasks: archivedRunning }]
      : path === "/api/workflows"
        ? [{ ...navigationFlows[0], state: running ? "EXECUTING" : "STOPPED" }]
        : navigationResponse(path) });
  });
  await page.routeWebSocket("**/api/notifications", () => {});
  await page.routeWebSocket("**/api/events?*", () => {});
  await page.goto("/");
  await page.locator(".project-nav .project-name").hover();
  await expect(page.locator(".project-name-delete")).toHaveCount(0);
  await expect(page.locator(".project-name-edit")).toHaveCount(2);
  await page.locator(".flow-nav-item").hover();
  await expect(page.getByRole("button", { name: "归档", exact: true })).toHaveCount(0);
  running = false;
  archivedRunning = true;
  await page.reload();
  await expect(page.locator(".flow-card")).toBeVisible();
  await expect(page.locator(".project-name-delete")).toHaveCount(0);
  archivedRunning = false;
  await page.reload();
  await page.locator(".project-nav .project-name").hover();
  await expect(page.locator(".project-nav .project-name-delete")).toBeVisible();
  await expect(page.locator(".project-name-delete")).toHaveCount(2);
  await page.locator(".flow-nav-item").hover();
  await expect(page.getByRole("button", { name: "归档", exact: true })).toBeVisible();
});
