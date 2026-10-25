import { test, expect } from "@playwright/test";
import { dismissFirstRun, fixtureState } from "./native-helper.js";

test("项目列表晚到时保留正在编辑的任务，重新打开才采用新默认目录", async ({ page }) => {
  const state = fixtureState();
  const latePath = state.root + "/late-default";
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/projects", async route => {
    const response = await route.fetch();
    const projects = await response.json();
    await ready;
    await route.fulfill({ response, json: projects.map((project: any, index: number) => ({
      ...project, name: `晚到项目-${index}`,
      repositories: project.repositories.map((repo: any) => ({ ...repo, path: latePath })),
    })) });
  });
  try {
    await dismissFirstRun(page);
    await page.goto("/");
    await page.getByRole("button", { name: "+ 新建", exact: true }).click();
    const modal = page.locator(".modal-backdrop").last();
    const path = modal.getByLabel("工作区真实路径");
    await path.fill(state.nativeRepo);
    const existing = modal.locator('input[name="workspaceMode"][value="existing_workspace"]');
    await existing.check();
    await modal.locator("textarea").fill("保留完整需求\n不覆盖用户选择");
    release();
    await expect(page.locator(".project-name").first()).toContainText("晚到项目-");
    await expect(path).toHaveValue(state.nativeRepo);
    await expect(existing).toBeChecked();
    await expect(modal.locator("textarea")).toHaveValue("保留完整需求\n不覆盖用户选择");
    await modal.locator(".ms-head .ms-link").click();
    await page.getByRole("button", { name: "+ 新建", exact: true }).click();
    await expect(page.getByLabel("工作区真实路径")).toHaveValue(latePath);
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
  }
});

for (const width of [1366, 1440, 1920])
  test("真实创建拒绝保留需求草稿 " + width, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await page.getByRole("button", { name: "+ 新建", exact: true }).click();
    const modal = page.locator(".modal-backdrop").last();
    await modal.getByLabel("工作区真实路径").fill(fixtureState().root);
    const text = "无 Git 根目录必须拒绝，保留用户完整需求";
    await modal.locator("textarea").fill(text);
    await modal.getByRole("button", { name: "创建并开始规划" }).click();
    await expect(modal.locator("textarea")).toHaveValue(text);
    await expect(modal).toContainText(/失败|repository|Git/);
    const box = await modal.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
  });
