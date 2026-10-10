import { test, expect } from "@playwright/test";
import {
  executionSpec,
  fixturePost,
  openFixtureWorkflow,
  pickListedModel,
  showExecutionSidebar,
  openTaskModels,
  composerInput,
  sendComposerText,
  waitAccessStatus,
  workflowDetail,
} from "./native-helper.js";

test.describe.configure({ mode: "serial" });

async function seedRetest(page: import("@playwright/test").Page) {
  const seeded = await fixturePost(page, "/__fixture/seed-retest");
  await expect
    .poll(
      async () =>
        (await workflowDetail(page, String(seeded.workflow_id))).workflow.state,
    )
    .toBe("HUMAN_PENDING");
  return seeded;
}

test("E2E 旁路提问不出现修复指派，正式反馈默认按任务配置", async ({ page }) => {
  const seeded = await fixturePost(page, "/__fixture/feedback");
  const detail = await workflowDetail(page, String(seeded.workflow_id));
  expect(detail.workflow.state).toBe("HUMAN_PENDING");
  expect(detail.plan.plan.task_model).toBe("native-v2");
  await page.goto(`/?workflow=${seeded.workflow_id}`);
  await expect(page.locator(".header-title-wrapper .badge")).toContainText(
    "等待你的验收",
  );
  await showExecutionSidebar(page);
  await composerInput(page).fill("/btw 只提问，不调整需求");
  await expect(page.locator(".conversation-composer").getByText("本次修复由谁处理")).toHaveCount(0);
  const posted = page.waitForResponse(response => response.url().endsWith("/conversation-messages") && response.request().method() === "POST");
  await sendComposerText(page, "正式反馈：修复筛选问题");
  const response = await posted;
  expect(response.ok(), await response.text()).toBeTruthy();
  expect(response.request().postDataJSON()).toMatchObject({ client_mode: "formal", text: "正式反馈：修复筛选问题" });
  expect(response.request().postDataJSON()).not.toHaveProperty("repair_model");
});

test("E2E-U08 人工问题自定义处理者显示在复测卡且复测仍人工", async ({
  page,
}) => {
  const seeded = await seedRetest(page);
  const first = String(seeded.first_description);
  const second = String(seeded.second_description);
  await openFixtureWorkflow(page);
  await openTaskModels(page);
  const activity = page.getByLabel("任务反馈记录");
  await expect(activity.getByText(first)).toContainText("等待你复测");
  await expect(activity.getByText(second)).toContainText("等待你复测");
  await activity
    .locator("article")
    .filter({ hasText: first })
    .getByRole("button", { name: "复测通过" })
    .click();
  await expect(activity.getByText(first)).toContainText("已确认", {
    timeout: 15000,
  });
  await expect(activity.getByText(second)).toContainText("等待你复测");
  expect(seeded.issue_ids).toHaveLength(2);
});

async function retestCard(
  page: import("@playwright/test").Page,
  description: string,
) {
  return page
    .getByLabel("任务反馈记录")
    .locator("article")
    .filter({ hasText: description })
    .filter({ hasText: "等待你复测" })
    .first();
}

test("E2E-R20 待复测问题指定另一模型确实提交", async ({ page }) => {
  const seeded = await seedRetest(page);
  await openFixtureWorkflow(page);
  await openTaskModels(page);
  const card = await retestCard(page, String(seeded.first_description));
  await card.getByText("本次修复由谁处理").click();
  await card.getByLabel("自定义工具/模型").check();
  await pickListedModel(card, "修复工具", "gpt-5.6-sol");
  await waitAccessStatus(card, "已验证可访问");
  const posted = page.waitForRequest(
    (request) =>
      request.url().includes("/functional-issues/") &&
      request.url().endsWith("/confirm") &&
      request.method() === "POST",
  );
  await card.getByRole("button", { name: "仍有问题，继续修复" }).click();
  const request = await posted;
  const body = request.postDataJSON() as Record<string, unknown>;
  expect(body.batch_id).toBe(seeded.batch_id);
  expect(body.repair_model).toMatchObject({
    mode: "custom",
    profile: { modelId: "gpt-5.6-sol" },
  });
});

test("E2E-R20 恢复任务默认会清除覆盖", async ({ page }) => {
  const seeded = await seedRetest(page);
  await openFixtureWorkflow(page);
  await openTaskModels(page);
  const card = await retestCard(page, String(seeded.first_description));
  await card.getByText("本次修复由谁处理").click();
  await card.getByLabel("按任务配置").check();
  const posted = page.waitForRequest(
    (request) =>
      request.url().includes("/functional-issues/") &&
      request.url().endsWith("/confirm") &&
      request.method() === "POST",
  );
  await card.getByRole("button", { name: "仍有问题，继续修复" }).click();
  const request = await posted;
  expect(request.postDataJSON().repair_model).toEqual({ mode: "task-default" });
});

test("E2E-R20 记为任务默认会写入执行配置", async ({ page }) => {
  const seeded = await seedRetest(page);
  await openFixtureWorkflow(page);
  await openTaskModels(page);
  const card = await retestCard(page, String(seeded.first_description));
  await card.getByText("本次修复由谁处理").click();
  await card.getByLabel("使用规划配置").check();
  await card.getByLabel("同时设为该任务后续人工问题修复默认值").check();
  await card.getByRole("button", { name: "仍有问题，继续修复" }).click();
  await expect
    .poll(
      async () => {
        const spec = await executionSpec(page, seeded.workflow_id as string);
        return spec.spec?.roleOverrides?.functional_fixer;
      },
      { timeout: 20000 },
    )
    .toMatchObject({ mode: "explicit" });
});

test("E2E-R20 另一页面先更新指派会造成版本冲突", async ({ page }) => {
  const seeded = await seedRetest(page);
  await openFixtureWorkflow(page);
  await openTaskModels(page);
  const card = await retestCard(page, String(seeded.first_description));
  await card.getByText("本次修复由谁处理").click();
  await card.getByLabel("使用执行配置").check();
  await fixturePost(page, "/__fixture/bump-repair-assignment", {
    batch_id: seeded.batch_id,
    expected_assignment_revision: seeded.assignment_revision,
  });
  await card.getByRole("button", { name: "仍有问题，继续修复" }).click();
  await expect(page.getByRole("alert")).toContainText(
    /版本已变化|REPAIR_BATCH_MISMATCH/,
    { timeout: 15000 },
  );
  await expect(card).toContainText("等待你复测");
});

test("E2E-U14 当前任务配置保存不污染历史Run绑定", async ({ page }) => {
  const seeded = await fixturePost(page, "/__fixture/seed-history-run");
  const id = await openFixtureWorkflow(page);
  const before = (await workflowDetail(page, id)).runs.find((run: { id: string }) => run.id === seeded.run_id);
  expect(before.profile.modelId).toBe("historical-bound-model");
  const dialog = await openTaskModels(page);
  await pickListedModel(dialog, "工具", "gpt-5.6-sol");
  await dialog.getByRole("button", { name: /^(保存|保存供后续使用)$/ }).click();
  await expect(dialog).not.toBeVisible({ timeout: 20000 });
  expect((await executionSpec(page, id)).spec.plannerProfile.modelId).toBe("gpt-5.6-sol");
  const after = (await workflowDetail(page, id)).runs.find((run: { id: string }) => run.id === seeded.run_id);
  expect(after).toEqual(before);
});

test("未修改处理者的失败复测保留已有人工指派", async ({ page }) => {
  const seeded = await seedRetest(page);
  await openFixtureWorkflow(page);
  await openTaskModels(page);
  const card = await retestCard(page, String(seeded.first_description));
  await card.getByText("本次修复由谁处理").click();
  await expect(card.getByLabel("自定义工具/模型")).toBeChecked();
  const posted = page.waitForResponse(
    (response) =>
      response.url().includes("/functional-issues/") &&
      response.url().endsWith("/confirm") &&
      response.request().method() === "POST",
  );
  await card.getByRole("button", { name: "仍有问题，继续修复" }).click();
  const response = await posted;
  expect(response.ok(), await response.text()).toBeTruthy();
  expect(response.request().postDataJSON()).not.toHaveProperty("repair_model");
  const views = await page.request.get(
    `/api/workflows/${seeded.workflow_id}/functional-issue-views`,
  );
  expect(views.ok(), await views.text()).toBeTruthy();
  const data = await views.json();
  const view = data.find(
    (item: any) => item.issue.issue_id === seeded.issue_ids[0],
  );
  expect(view.explicit_profile).toMatchObject({
    adapterId: "codex",
    modelId: "gpt-6-astra",
  });
  expect(view.assignment_revision).toBe(seeded.assignment_revision);
});
