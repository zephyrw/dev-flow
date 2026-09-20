import { expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
export const fixtureState = () =>
  JSON.parse(readFileSync(".cache/e2e-state.json", "utf8"));
export async function createNative(
  page: Page,
  title: string,
  mode = "new_worktree",
) {
  const state = fixtureState();
  await page.goto("/");
  await page.getByRole("button", { name: "+ 新建", exact: true }).click();
  const modal = page.locator(".modal-backdrop").last();
  await modal.getByLabel("工作区真实路径").fill(state.nativeRepo);
  await modal.getByLabel("规划工具").selectOption("codex");
  await modal.getByLabel("执行工具").selectOption("codex");
  if (mode === "existing_workspace")
    await modal.getByRole("radio", { name: "主工作区直接执行" }).check();
  await modal.locator("textarea").fill(title);
  const created = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/workflows") && r.request().method() === "POST",
  );
  await modal.getByRole("button", { name: "创建并开始规划" }).click();
  const response = await created;
  expect(response.status(), await response.text()).toBe(200);
  const id = (await response.json()).workflow.id;
  await expect(page.locator(".header-title-wrapper .badge")).toContainText(
    "等待计划批准",
    { timeout: 45000 },
  );
  return id;
}
export async function showInteraction(page: Page) {
  await page.getByRole("button", { name: "执行过程", exact: true }).click();
  await expect(page.locator(".execution-sidebar")).toBeVisible();
  await page
    .getByRole("button", { name: "指导或提问", exact: true })
    .click();
}
