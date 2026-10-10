import { test, expect, type Page } from "@playwright/test";
import type { RepairBatchView } from "../../packages/contracts/src/index.js";
import { executionSpec, exactLabel, fixturePost, openFixtureWorkflow, openTaskModels, pickListedModel, repairBatches, workflowDetail } from "./native-helper.js";

test.describe.configure({ mode: "serial" });

async function saveModels(page: Page) {
  const dialog = page.getByRole("dialog", { name: "工具与模型", exact: true });
  await dialog.getByRole("button", { name: /^(保存|保存供后续使用)$/ }).click();
  await expect(dialog).not.toBeVisible({ timeout: 20000 });
}

test("E2E-U05 保存规划和执行配置只影响后续派发", async ({ page }) => {
  const id = await openFixtureWorkflow(page);
  const before = await executionSpec(page, id);
  const initial = (await workflowDetail(page, id)).workflow;
  expect(initial.state).toBe("PLAN_PENDING");
  const dialog = await openTaskModels(page);
  await exactLabel(dialog, "工具").selectOption("codex");
  await pickListedModel(dialog, "工具", "gpt-5.6-luna");
  await dialog.getByRole("tab", { name: "执行", exact: true }).click();
  await exactLabel(dialog, "工具").selectOption("agy");
  await pickListedModel(dialog, "工具", "gemini-3.8-flash-high");
  await saveModels(page);
  const saved = await executionSpec(page, id);
  expect(saved.spec_revision).toBe(before.spec_revision + 1);
  expect(saved.spec.plannerProfile.modelId).toBe("gpt-5.6-luna");
  expect(saved.spec.executorProfile.modelId).toBe("gemini-3.8-flash-high");
  expect((await workflowDetail(page, id)).workflow).toMatchObject({ state: initial.state, version: initial.version });
});

test("E2E-U06 配置弹窗按职责编辑，不显示统一继续开发操作", async ({ page }) => {
  await openFixtureWorkflow(page);
  const dialog = await openTaskModels(page);
  await expect(dialog.getByRole("tab", { name: "规划", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(dialog.getByRole("tab", { name: "执行", exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "继续开发", exact: true })).toHaveCount(0);
});

test("E2E-U11 两窗口配置CAS冲突保留草稿，重新载入后可提交", async ({ page, context }) => {
  test.setTimeout(120000);
  const id = await openFixtureWorkflow(page);
  const dialog = await openTaskModels(page, "执行");
  await pickListedModel(dialog, "工具", "gemini-3.7-flash-medium");
  const page2 = await context.newPage();
  await openFixtureWorkflow(page2);
  const dialog2 = await openTaskModels(page2);
  await pickListedModel(dialog2, "工具", "gpt-5.6-sol");
  await saveModels(page);
  const afterFirst = await executionSpec(page, id);
  await dialog2.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog2.getByRole("alert")).toContainText("配置版本已变化", { timeout: 20000 });
  await expect(dialog2.getByRole("alert")).toContainText("草稿已保留");
  await expect(exactLabel(dialog2, "工具模型搜索")).toHaveValue("GPT-5.6 Sol");
  await dialog2.getByRole("button", { name: "重新载入", exact: true }).click();
  await expect(dialog2.getByRole("alert")).toHaveCount(0);
  await expect(exactLabel(dialog2, "工具模型搜索")).toHaveValue("GPT-5.6 Sol");
  await saveModels(page2);
  const final = await executionSpec(page, id);
  expect(final.spec_revision).toBe(afterFirst.spec_revision + 1);
  expect(final.spec.plannerProfile.modelId).toBe("gpt-5.6-sol");
  expect(final.spec.executorProfile.modelId).toBe("gemini-3.7-flash-medium");
  await page2.close();
});

test("E2E-U07 审查时安全换规划模型并继续仍保留原阶段与用途", async ({ page }) => {
  test.setTimeout(180000);
  const id = await openFixtureWorkflow(page);
  for (const [phase, stage, model] of [["before_human", "quality_before_human", "gpt-5.6-sol"], ["after_human", "review", "gpt-5.6-luna"]] as const) {
    const seeded = await fixturePost(page, "/__fixture/enter-review", { phase });
    await openFixtureWorkflow(page);
    const dialog = await openTaskModels(page);
    await pickListedModel(dialog, "工具", model);
    const responsePromise = page.waitForResponse(response => response.url().endsWith("/model-switch") && response.request().method() === "POST");
    await dialog.getByRole("button", { name: "切换并继续", exact: true }).click();
    const response = await responsePromise;
    expect(response.ok(), await response.text()).toBeTruthy();
    expect(response.request().postDataJSON()).toMatchObject({ expected_run_id: seeded.run_id, resume_after_switch: true });
    await expect(dialog).not.toBeVisible({ timeout: 30000 });
    await expect.poll(async () => (await workflowDetail(page, id)).workflow, { timeout: 30000 }).toMatchObject({ state: "REVIEWING", stage });
    const detail = await workflowDetail(page, id);
    const activeRun = detail.runs.find((run: { id: string }) => run.id === detail.workflow.run_id);
    expect(activeRun).toMatchObject({ purpose: "quality_review", stage, profile: { modelId: model } });
    expect(activeRun.id).not.toBe(seeded.run_id);
  }
});

test("E2E-R21 活跃修复中保存任务后续模型不改当前Run和批次覆盖", async ({ page }) => {
  test.setTimeout(90000);
  const seeded = await fixturePost(page, "/__fixture/seed-repair-batches");
  const id = await openFixtureWorkflow(page);
  const beforeBatches = await repairBatches(page, id);
  const beforeSpec = await executionSpec(page, id);
  const beforeDetail = await workflowDetail(page, id);
  const beforeRun = beforeDetail.runs.find((run: { id: string }) => run.id === seeded.run_id);
  expect(beforeRun).toMatchObject({ profile: { modelId: seeded.run_model }, purpose: "functional_fix", status: "running" });
  const dialog = await openTaskModels(page, "执行");
  await exactLabel(dialog, "工具").selectOption("codex");
  await pickListedModel(dialog, "工具", "gpt-5.6-luna");
  await dialog.getByRole("button", { name: "保存供后续使用", exact: true }).click();
  await expect(dialog).not.toBeVisible({ timeout: 20000 });
  const afterSpec = await executionSpec(page, id);
  expect(afterSpec.spec_revision).toBe(beforeSpec.spec_revision + 1);
  expect(afterSpec.spec.executorProfile.modelId).toBe("gpt-5.6-luna");
  const afterDetail = await workflowDetail(page, id);
  expect(afterDetail.workflow.run_id).toBe(seeded.run_id);
  expect(afterDetail.runs.find((run: { id: string }) => run.id === seeded.run_id)).toEqual(beforeRun);
  const afterBatches = await repairBatches(page, id);
  const storedAssignments = (views: RepairBatchView[]) => views.map(({ inherited_profile, ...view }) => view);
  expect(storedAssignments(afterBatches)).toEqual(storedAssignments(beforeBatches));
  // Inheritance describes the next dispatch; persisted batch overrides and the
  // active Run remain frozen while that live default follows the saved spec.
  for (const view of afterBatches) expect(view.inherited_profile).toEqual(afterSpec.spec.executorProfile);
});
