import { expect, type Locator, type Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
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
  const pattern = new RegExp(nativeId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/[-_]/g, "[-_ ]"), "i");
  const baseName = nativeId.replace(/-(high|medium|low|xhigh|max)$/i, "");
  const basePattern = new RegExp(baseName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/[-_]/g, "[-_ ]"), "i");
  const listbox = root.page().getByRole("listbox", { name: "模型选项列表" });
  await expect(listbox).toBeVisible({ timeout: 15000 });
  let option = listbox.getByRole("option").filter({ hasText: pattern }).first();
  if ((await option.count()) === 0) {
    option = listbox.getByRole("option").filter({ hasText: basePattern }).first();
  }
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
  await openExecutionSidebar(page);
}

export async function openTaskModels(page: Page, role: "规划" | "执行" = "规划") {
  await page.getByRole("button", { name: role === "规划" ? /^规划模型：/ : /^执行模型：/ }).click();
  const dialog = page.getByRole("dialog", { name: "工具与模型", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("tab", { name: role, exact: true }).click();
  await expect(exactLabel(dialog, "工具模型搜索")).toBeEnabled();
  return dialog;
}

export async function dismissFirstRun(page: Page) {
  try {
    await page.addInitScript(() => {
      try {
        window.localStorage.setItem("devflow.first_run_completed", "true");
      } catch {}
    });
  } catch {}
  try {
    await page.evaluate(() => {
      try {
        window.localStorage.setItem("devflow.first_run_completed", "true");
      } catch {}
    });
  } catch {}
}

export async function openFixtureWorkflow(page: Page) {
  const title = "验证审批与交付闭环";
  await dismissFirstRun(page);
  await page.goto("/");
  await dismissFirstRun(page);
  await expect(page.getByRole("heading", { name: "任务总览", exact: true })).toBeVisible();
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
  await dismissFirstRun(page);
  await page.goto("/");
  await dismissFirstRun(page);
  await page.getByRole("button", { name: "+ 新建", exact: true }).click();
  const modal = page.locator(".modal-backdrop").last();
  await modal.getByLabel("工作区真实路径").fill(state.nativeRepo);
  // ModelConfigTabs 每个职责 tab 只渲染一个「工具」选择器
  await modal.getByRole("tab", { name: "规划", exact: true }).click();
  await modal.getByLabel("工具", { exact: true }).selectOption("codex");
  await pickListedModel(modal, "工具", "gpt-6-astra");
  await modal.getByRole("tab", { name: "执行", exact: true }).click();
  await modal.getByLabel("工具", { exact: true }).selectOption("codex");
  await pickListedModel(modal, "工具", "gpt-6-astra");
  if (mode === "existing_workspace")
    await modal.locator('input[name="workspaceMode"][value="existing_workspace"]').check();
  await modal.locator("textarea").fill(title);
  const fixtureCli = resolve("tests/fixtures/native-cli.mjs");
  await page.route("**/api/workflows", async (route) => {
    const req = route.request();
    if (req.method() === "POST") {
      try {
        const data = req.postDataJSON();
        if (data && typeof data === "object") {
          if (data.planner_profile && data.planner_profile.adapterId === "codex") {
            data.planner_profile.executableRef = process.execPath;
            data.planner_profile.options = { prefixArgs: [fixtureCli] };
          }
          if (data.executor_profile && data.executor_profile.adapterId === "codex") {
            data.executor_profile.executableRef = process.execPath;
            data.executor_profile.options = { prefixArgs: [fixtureCli] };
          }
          await route.continue({ postData: JSON.stringify(data) });
          return;
        }
      } catch {}
    }
    await route.continue();
  });
  const created = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/workflows") && r.request().method() === "POST",
  );
  await modal.getByRole("button", { name: "创建并开始规划" }).click();
  const response = await created;
  await page.unroute("**/api/workflows");
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
  const submitted = page.waitForResponse(response => response.url().includes("/conversation-messages") &&
    response.request().method() === "POST");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  const response = await submitted;
  expect(response.ok(), await response.text()).toBe(true);
  await expect(composerInput(page)).toHaveValue("");
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
  const approval = page.getByRole("dialog", { name: "批准执行计划", exact: true });
  await expect(approval).toBeVisible();
  const approved = page.waitForResponse(response => /\/approve$/.test(new URL(response.url()).pathname) &&
    response.request().method() === "POST", { timeout: 45000 });
  await approval.getByRole("button", { name: "批准并开始执行", exact: true }).click();
  const response = await approved;
  expect(response.ok(), await response.text()).toBe(true);
  await expect(approval).not.toBeVisible();
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
