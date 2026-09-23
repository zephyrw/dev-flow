import { expect, type Locator, type Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadTestInstanceConfig } from "../helpers/test-isolation.js";
export function testInstance() { return loadTestInstanceConfig(); }

export type FixtureState = {
  shutdownToken: string;
  workflow_id: string;
  root: string;
  repo: string;
  nativeRepo: string;
  probeCli: string;
  probeLogDir: string;
  humanOrigin: string;
  port: number;
  runDir?: string;
  stateFile: string;
};

export const fixtureState = (): FixtureState =>
  JSON.parse(readFileSync(testInstance().stateFile, "utf8"));

export function exactLabel(root: Locator, name: string) {
  return root.getByLabel(name, { exact: true });
}

export async function fixturePost(
  page: Page,
  path: string,
  data: Record<string, unknown> = {},
) {
  const state = fixtureState();
  const origin = testInstance().humanOrigin;
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
  waitForPlan = true,
) {
  const state = fixtureState();
  await page.goto("/");
  await page.getByRole("button", { name: "+ 新建", exact: true }).click();
  const modal = page.locator(".modal-backdrop").last();
  await modal.getByLabel("工作区真实路径").fill(state.nativeRepo);
  // ModelConfigTabs 每个职责 tab 只渲染一个「工具」选择器
  const pickModel = async (query: string) => {
    const search = modal.getByLabel("模型", { exact: true });
    await expect(search).toBeEnabled({ timeout: 20000 });
    await search.click();
    await search.fill(query);
    const option = modal
      .locator('[aria-label="模型选项列表"] [role="option"]')
      .first();
    await expect(option).toBeVisible({ timeout: 15000 });
    await option.click();
  };
  await modal.getByRole("tab", { name: "规划", exact: true }).click();
  await modal.getByLabel("工具", { exact: true }).selectOption("codex");
  await pickModel("Astra");
  await modal.getByRole("tab", { name: "执行", exact: true }).click();
  await modal.getByLabel("工具", { exact: true }).selectOption("codex");
  await pickModel("Astra");
  if (mode === "existing_workspace")
    await modal.locator('input[name="workspaceMode"][value="existing_workspace"]').check();
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
