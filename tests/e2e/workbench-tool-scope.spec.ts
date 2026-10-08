import { test, expect } from "@playwright/test";

test("首次使用与旧向导链接直接进入工作台，所有模型入口只有 Codex 和 AGY", async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
  await page.goto("/?setup=1&onboarding=1");
  await expect(page.getByRole("heading", { name: "任务总览" })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "新手配置向导" })).toHaveCount(0);
  await expect(page).not.toHaveURL(/setup=|onboarding=/);
  const response = await page.request.get("/api/model-tools");
  expect(response.ok()).toBeTruthy();
  expect((await response.json()).map((tool: { adapterId: string }) => tool.adapterId)).toEqual(["codex", "agy"]);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "设置" });
  for (const role of ["规划", "执行"]) {
    await settings.getByRole("tab", { name: role, exact: true }).click();
    const tools = settings.getByLabel("工具", { exact: true });
    expect(await tools.locator("option").evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value))).toEqual(["codex", "agy"]);
  }
  await settings.getByRole("button", { name: "关闭对话框", exact: true }).click();
  await page.getByRole("button", { name: "+ 新建", exact: true }).click();
  const modal = page.locator(".modal-backdrop").last();
  for (const role of ["规划", "执行"]) {
    await modal.getByRole("tab", { name: role, exact: true }).click();
    expect(await modal.getByLabel("工具", { exact: true }).locator("option").evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value))).toEqual(["codex", "agy"]);
  }
});
