import { test, expect } from "@playwright/test";
import { fixtureState } from "./native-helper.js";
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
