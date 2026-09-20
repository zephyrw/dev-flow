import { expect, type Locator, type Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type FixtureState = {
  shutdownToken: string;
  workflow_id: string;
  root: string;
  repo: string;
  nativeRepo: string;
  probeCli: string;
  probeLogDir: string;
};

export const fixtureState = (): FixtureState =>
  JSON.parse(readFileSync(".cache/e2e-state.json", "utf8"));

export function exactLabel(root: Locator, name: string) {
  return root.getByLabel(name, { exact: true });
}

export async function fixturePost(
  page: Page,
  path: string,
  data: Record<string, unknown> = {},
) {
  const state = fixtureState();
  const origin = `http://localhost:${process.env.E2E_PORT || "14811"}`;
  const response = await page.request.post(path, {
    headers: {
      Origin: origin,
      "content-type": "application/json",
    },
    data: { token: state.shutdownToken, ...data },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json().catch(() => ({}));
}

export async function fixtureProbeCount(page: Page): Promise<number> {
  const data = await fixturePost(page, "/__fixture/probe-count");
  return Number(data.count ?? 0);
}

export function diskProbeCount(): number {
  const file = join(fixtureState().probeLogDir, "invocations.jsonl");
  if (!existsSync(file)) return 0;
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { kind?: string })
    .filter((item) => item.kind === "probe").length;
}

export async function pickListedModel(
  root: Locator,
  toolLabel: string,
  nativeId: string,
) {
  const search = exactLabel(root, `${toolLabel}模型搜索`);
  await expect(search).toBeEnabled({ timeout: 20000 });
  await search.click();
  await search.fill(nativeId);
  const option = root.getByRole("option").filter({ hasText: nativeId }).first();
  await expect(option).toBeVisible({ timeout: 15000 });
  await option.click();
}

export async function waitAccessStatus(root: Locator, text: string | RegExp) {
  await expect(root.locator(".ms-access").first()).toContainText(text, {
    timeout: 20000,
  });
}

export async function workflowDetail(page: Page, id: string) {
  const response = await page.request.get("/api/workflows/" + id);
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}

export async function executionSpec(page: Page, id: string) {
  const response = await page.request.get(
    "/api/workflows/" + id + "/execution-spec",
  );
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}

export async function repairBatches(page: Page, id: string) {
  const response = await page.request.get(
    "/api/workflows/" + id + "/repair-batches",
  );
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}

export async function showExecutionSidebar(page: Page) {
  if (!(await page.locator(".execution-sidebar").isVisible())) {
    await page.getByRole("button", { name: "执行过程", exact: true }).click();
  }
  await expect(page.locator(".execution-sidebar")).toBeVisible();
}

export async function openFixtureWorkflow(page: Page) {
  const title = "验证审批与交付闭环";
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "工作流总览" })).toBeVisible();
  await page
    .getByRole("button")
    .filter({ has: page.getByRole("heading", { name: title }) })
    .click();
  return fixtureState().workflow_id as string;
}

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
    .getByRole("button", { name: "给执行模型补充指导", exact: true })
    .click();
}
