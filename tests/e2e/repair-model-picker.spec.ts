import { test, expect } from "@playwright/test";
import {
  executionSpec,
  fixturePost,
  openFixtureWorkflow,
  pickListedModel,
  showExecutionSidebar,
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
  const trigger = page.getByRole("button", {
    name: "指导或提问",
    exact: true,
  });
  await expect(trigger).toBeVisible();
  await trigger.click();
  const form = page.locator(".guidance-form");
  await expect(form).toBeVisible();
  await form.getByLabel("临时提问", { exact: true }).check();
  await expect(form.getByText("本次修复由谁处理")).toHaveCount(0);
  await form.getByLabel("反馈并调整").check();
  const picker = form.getByText("本次修复由谁处理");
  await expect(picker).toBeVisible();
  await picker.click();
  await expect(form.getByLabel("按任务配置")).toBeChecked();
  await expect(
    form.getByLabel("同时设为该任务后续人工问题修复默认值"),
  ).not.toBeChecked();
});

test("E2E-U08 人工问题自定义处理者显示在复测卡且复测仍人工", async ({
  page,
}) => {
  const seeded = await seedRetest(page);
  const first = String(seeded.first_description);
  const second = String(seeded.second_description);
  await openFixtureWorkflow(page);
  await showExecutionSidebar(page);
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
  await showExecutionSidebar(page);
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
  await showExecutionSidebar(page);
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
  await showExecutionSidebar(page);
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
  await showExecutionSidebar(page);
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

test("E2E-U14 历史记录看当时绑定不被当前默认污染", async ({ page }) => {
  await fixturePost(page, "/__fixture/seed-history-run");
  await openFixtureWorkflow(page);
  if (!(await page.locator(".execution-sidebar").isVisible())) {
    await page.getByRole("button", { name: "执行过程", exact: true }).click();
  }
  const activity = page.getByLabel("任务反馈记录");
  const history = activity
    .locator("article")
    .filter({ hasText: "historical-bound-model" })
    .first();
  await expect(history).toContainText("historical-bound-model");
  await expect(history).toContainText("本轮审查");
  await page.getByRole("button", { name: "全局模型设置" }).click();
  const drawer = page.getByRole("dialog", { name: "工具与模型" });
  await pickListedModel(drawer, "规划工具", "gpt-5.6-sol");
  await waitAccessStatus(drawer.locator(".ms-editor").first(), "已验证可访问");
  await drawer.getByRole("button", { name: /保存默认配置/ }).click();
  await expect(drawer.locator(".ms-success")).toBeVisible({ timeout: 15000 });
  await drawer.getByRole("button", { name: "关闭设置" }).click();
  if (!(await page.locator(".execution-sidebar").isVisible())) {
    await page.getByRole("button", { name: "执行过程", exact: true }).click();
  }
  await expect(
    page
      .getByLabel("任务反馈记录")
      .locator("article")
      .filter({ hasText: "historical-bound-model" })
      .first(),
  ).toContainText("historical-bound-model");
  await expect(
    page
      .getByLabel("任务反馈记录")
      .locator("article")
      .filter({ hasText: "historical-bound-model" })
      .first(),
  ).not.toContainText("gpt-5.6-sol");
});

test("未修改处理者的失败复测保留已有人工指派", async ({ page }) => {
  const seeded = await seedRetest(page);
  await openFixtureWorkflow(page);
  await showExecutionSidebar(page);
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
