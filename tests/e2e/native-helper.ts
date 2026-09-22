import { expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { loadTestInstanceConfig } from "../helpers/test-isolation.js";

export function testInstance() {
  return loadTestInstanceConfig();
}

export const fixtureState = () =>
  JSON.parse(readFileSync(testInstance().stateFile, "utf8"));

export async function createNative(
  page: Page,
  title: string,
  mode = "new_worktree",
  waitForPlan = true,
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
  if (waitForPlan) {
    await expect(page.locator(".header-title-wrapper .badge")).toContainText(
      "等待计划批准",
      { timeout: 45000 },
    );
  }
  return id;
}

export async function setNativeFixture(
  page: Page,
  options: Record<string, unknown>,
) {
  const state = fixtureState();
  const origin = state.humanOrigin || testInstance().humanOrigin;
  const response = await page.request.post("/__fixture/native-options", {
    headers: { Origin: origin },
    data: { token: state.shutdownToken, options },
  });
  expect(response.ok(), await response.text()).toBe(true);
}

export async function openExecutionSidebar(page: Page) {
  const sidebar = page.locator(".execution-sidebar");
  if (await sidebar.isVisible()) return;
  const opener = page.getByRole("button", { name: "执行过程", exact: true });
  await expect(sidebar.or(opener)).toBeVisible({ timeout: 15000 });
  if (await sidebar.isVisible()) return;
  await opener.click();
  await expect(sidebar).toBeVisible();
}

export function composerInput(page: Page) {
  return page.locator(".conversation-composer-input");
}

export async function sendComposerText(page: Page, text: string) {
  await openExecutionSidebar(page);
  await composerInput(page).fill(text);
  await page.getByRole("button", { name: "发送", exact: true }).click();
}

export async function conversationTree(page: Page, workflowId: string) {
  const response = await page.request.get(
    `/api/workflows/${workflowId}/conversations`,
  );
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

export async function waitForSubagents(
  page: Page,
  workflowId: string,
  minCount = 1,
) {
  await expect
    .poll(
      async () => {
        const tree = await conversationTree(page, workflowId);
        return (tree.nodes ?? []).filter((node: { kind?: string }) => node.kind === "subagent")
          .length;
      },
      { timeout: 30000 },
    )
    .toBeGreaterThanOrEqual(minCount);
  return conversationTree(page, workflowId);
}

export async function showInteraction(page: Page) {
  await openExecutionSidebar(page);
}

export function workCard(page: Page) {
  return page.getByLabel("子 Agent 工作卡", { exact: true });
}

export function workCardRow(page: Page, name: string) {
  return workCard(page)
    .locator(".subagent-work-card-row")
    .filter({ has: page.locator(".subagent-work-card-name", { hasText: name }) });
}

export function workCardName(page: Page, name: string) {
  return workCard(page)
    .locator(".subagent-work-card-name")
    .filter({ hasText: name })
    .first();
}

export async function waitForWorkflowState(
  page: Page,
  workflowId: string,
  state: string,
  timeout = 60000,
) {
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/workflows/${workflowId}`)).json())
          .workflow.state,
      { timeout },
    )
    .toBe(state);
}

export async function approvePlan(page: Page) {
  await page.getByRole("button", { name: "批准当前计划", exact: true }).click();
}

export function latestAttemptMap(tree: {
  attempts?: Array<{ conversation_id: string; status: string; generation?: number }>;
}) {
  const latest = new Map<string, { status: string }>();
  for (const attempt of tree.attempts ?? []) {
    const previous = latest.get(attempt.conversation_id);
    if (!previous || (attempt.generation ?? 0) >= 0) {
      latest.set(attempt.conversation_id, attempt);
    }
  }
  return latest;
}
