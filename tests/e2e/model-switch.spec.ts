import { test, expect } from "@playwright/test";
import {
  executionSpec,
  exactLabel,
  fixturePost,
  openFixtureWorkflow,
  pickListedModel,
  repairBatches,
  waitAccessStatus,
  workflowDetail,
} from "./native-helper.js";

test.describe.configure({ mode: "serial" });

test("E2E-U05 保存后续配置显示下次派发生效文案，且不默认勾选暂停", async ({
  page,
}) => {
  const id = await openFixtureWorkflow(page);
  const before = await executionSpec(page, id);
  const initialWorkflow = (await workflowDetail(page, id)).workflow;
  expect(initialWorkflow.state).toBe("PLAN_PENDING");
  await page.getByRole("button", { name: "工具与模型", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "工具与模型配置" });
  await expect(drawer).toBeVisible();
  await expect(
    drawer.getByText("完成可审计安全暂停后再应用新规格"),
  ).toHaveCount(0);
  await exactLabel(drawer, "规划工具").selectOption("codex");
  await pickListedModel(drawer, "规划工具", "gpt-5.6-luna");
  await exactLabel(drawer, "执行工具").selectOption("agy");
  await pickListedModel(drawer, "执行工具", "gemini-3.7-flash-high");
  await waitAccessStatus(drawer.locator(".ms-editor").first(), "已验证可访问");
  await waitAccessStatus(drawer.locator(".ms-editor").nth(1), "已验证可访问");
  await drawer.getByRole("button", { name: "保存，下次派发生效" }).click();
  const success = drawer.locator(".ms-success");
  await expect(success).toContainText(/已保存；/, { timeout: 15000 });
  await expect(success).not.toContainText("立即换掉当前进程");
  await expect(drawer.locator(".ms-error")).toHaveCount(0);
  const saved = await executionSpec(page, id);
  expect(saved.spec_revision).toBe(before.spec_revision + 1);
  expect(saved.spec.plannerProfile.modelId).toBe("gpt-5.6-luna");
  expect(saved.spec.executorProfile.modelId).toBe("gemini-3.7-flash-high");
  const afterWorkflow = (await workflowDetail(page, id)).workflow;
  expect(afterWorkflow.state).toBe(initialWorkflow.state);
  expect(afterWorkflow.version).toBe(initialWorkflow.version);
});

test("E2E-U06 任务抽屉不把继续开发当成统一文案", async ({ page }) => {
  await page.goto("/");
  await page
    .getByRole("button")
    .filter({ has: page.getByRole("heading", { name: "验证审批与交付闭环" }) })
    .click();
  await page.getByRole("button", { name: "工具与模型", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "工具与模型配置" });
  await expect(drawer).toBeVisible();
  await expect(
    drawer.getByRole("button", { name: "继续开发", exact: true }),
  ).toHaveCount(0);
});

async function closeTaskDrawer(page: import("@playwright/test").Page) {
  const drawer = page.getByRole("dialog", { name: "工具与模型配置" });
  if (await drawer.isVisible()) {
    await drawer.locator("button.ms-link").first().click();
  }
}

async function pauseSwitchReviewer(
  page: import("@playwright/test").Page,
  modelId: string,
) {
  await page.getByRole("button", { name: "工具与模型", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "工具与模型配置" });
  await expect(drawer).toBeVisible();
  await drawer.locator("summary", { hasText: "更多角色配置" }).click();
  await drawer.getByLabel("代码审查单独指定").check();
  const reviewRow = drawer
    .locator(".ms-role-row")
    .filter({ hasText: "代码审查" });
  await pickListedModel(reviewRow, "代码审查", modelId);
  await waitAccessStatus(reviewRow, "已验证可访问");
  await drawer.getByRole("button", { name: "暂停后应用" }).click();
  await expect(drawer.locator(".ms-success")).toContainText("已暂停并保存", {
    timeout: 25000,
  });
  await closeTaskDrawer(page);
}

test("E2E-U11 两窗口并发改任务配置冲突提示", async ({ page, context }) => {
  const id = await openFixtureWorkflow(page);
  await page.getByRole("button", { name: "工具与模型", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "工具与模型配置" });
  await expect(drawer).toBeVisible();
  await pickListedModel(drawer, "执行工具", "gemini-3.7-flash-medium");
  await waitAccessStatus(drawer.locator(".ms-editor").nth(1), "已验证可访问");
  const page2 = await context.newPage();
  await openFixtureWorkflow(page2);
  await page2.getByRole("button", { name: "工具与模型", exact: true }).click();
  const drawer2 = page2.getByRole("dialog", { name: "工具与模型配置" });
  await expect(drawer2).toBeVisible();
  await pickListedModel(drawer2, "规划工具", "gpt-5.6-sol");
  await waitAccessStatus(drawer2.locator(".ms-editor").first(), "已验证可访问");
  await drawer.getByRole("button", { name: "保存，下次派发生效" }).click();
  await expect(drawer.locator(".ms-success")).toBeVisible({ timeout: 15000 });
  await drawer2.getByRole("button", { name: "保存，下次派发生效" }).click();
  await expect(drawer2.locator(".ms-error")).toContainText("配置版本已变化", {
    timeout: 15000,
  });
  await expect(drawer2.locator(".ms-error")).toContainText("草稿已保留");
  await expect(exactLabel(drawer2, "规划工具模型搜索")).toHaveValue(
    /gpt-5\.6-sol/,
  );
  await drawer2.getByRole("button", { name: "重新载入" }).click();
  await expect(drawer2.locator(".ms-success")).toContainText("当前草稿已保留", {
    timeout: 15000,
  });
  await expect(exactLabel(drawer2, "规划工具模型搜索")).toHaveValue(
    /gpt-5\.6-sol/,
  );
  await page2.close();
  expect(id).toBeTruthy();
});

async function enterReviewPhase(
  page: import("@playwright/test").Page,
  id: string,
  phase: "before_human" | "after_human",
) {
  await fixturePost(page, "/__fixture/enter-review", { phase });
  await openFixtureWorkflow(page);
  const stage = phase === "before_human" ? "quality_before_human" : "review";
  await expect
    .poll(async () => (await workflowDetail(page, id)).workflow, {
      timeout: 20000,
    })
    .toMatchObject({ state: "REVIEWING", stage });
}

async function continueReview(page: import("@playwright/test").Page) {
  const button = page.getByRole("button", { name: /继续审查/ });
  await expect(button).toBeVisible({ timeout: 15000 });
  await button.click();
}

test("E2E-U07 两个审查阶段分别暂停换模型均回原审查阶段", async ({ page }) => {
  test.setTimeout(180000);
  const id = await openFixtureWorkflow(page);
  await enterReviewPhase(page, id, "before_human");
  await pauseSwitchReviewer(page, "gpt-5.6-sol");
  await expect
    .poll(async () => (await workflowDetail(page, id)).workflow.state, {
      timeout: 20000,
    })
    .toBe("STOPPED");
  const firstPause = await executionSpec(page, id);
  expect(firstPause.resume_target).toMatchObject({
    purpose: "quality_review",
    stage: "quality_before_human",
    review_phase: "before_human",
  });
  await continueReview(page);
  await expect
    .poll(async () => (await workflowDetail(page, id)).workflow, {
      timeout: 30000,
    })
    .toMatchObject({ state: "REVIEWING", stage: "quality_before_human" });
  await enterReviewPhase(page, id, "after_human");
  await pauseSwitchReviewer(page, "gpt-5.6-luna");
  await expect
    .poll(async () => (await workflowDetail(page, id)).workflow.state, {
      timeout: 20000,
    })
    .toBe("STOPPED");
  const secondPause = await executionSpec(page, id);
  expect(secondPause.resume_target).toMatchObject({
    purpose: "quality_review",
    stage: "review",
    review_phase: "after_human",
  });
  await continueReview(page);
  await expect
    .poll(async () => (await workflowDetail(page, id)).workflow, {
      timeout: 30000,
    })
    .toMatchObject({ state: "REVIEWING", stage: "review" });
});

test("E2E-R21 首次指定质量修复者、修改已有覆盖、活跃修复中保存未来选择", async ({
  page,
}) => {
  test.setTimeout(90000);
  const seeded = await fixturePost(page, "/__fixture/seed-repair-batches");
  const id = await openFixtureWorkflow(page);
  await page.getByRole("button", { name: "工具与模型", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "工具与模型配置" });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText("质量修复")).toHaveCount(2);
  await expect(drawer.getByText("功能修复")).toBeVisible();
  await expect(drawer.getByText("尚未指定覆盖")).toBeVisible();
  const openCard = drawer
    .locator(".ms-role-row")
    .filter({ hasText: "尚未指定覆盖" });
  await openCard.getByText("本次修复由谁处理").click();
  await openCard.getByLabel("自定义工具/模型").check();
  await pickListedModel(openCard, "修复工具", "gpt-5.6-luna");
  await waitAccessStatus(openCard, "已验证可访问");
  await openCard.getByRole("button", { name: "保存处理者" }).click();
  await expect(drawer.locator(".ms-success")).toContainText(
    "只影响后续修复轮次",
    {
      timeout: 20000,
    },
  );
  const firstQuality = drawer
    .locator(".ms-role-row")
    .filter({ hasText: "before_human" });
  await firstQuality.getByRole("button", { name: "清除覆盖" }).click();
  await expect(drawer.locator(".ms-success").last()).toContainText(
    "只影响后续修复轮次",
    { timeout: 20000 },
  );
  await expect(drawer.getByText("尚未指定覆盖")).toBeVisible();
  const covered = drawer
    .locator(".ms-role-row")
    .filter({ hasText: "after_human" });
  await covered.getByText("本次修复由谁处理").click();
  await covered.getByLabel("使用规划配置").check();
  await covered.getByRole("button", { name: "保存处理者" }).click();
  await expect(drawer.locator(".ms-success").last()).toContainText(
    "只影响后续修复轮次",
    { timeout: 20000 },
  );
  const functional = drawer
    .locator(".ms-role-row")
    .filter({ hasText: "功能修复" });
  await functional.getByText("本次修复由谁处理").click();
  await functional.getByLabel("使用执行配置").check();
  const beforeRun = await workflowDetail(page, id);
  await functional.getByRole("button", { name: "保存处理者" }).click();
  await expect(drawer.locator(".ms-success").last()).toContainText(
    "不会改当前运行",
    { timeout: 20000 },
  );
  const afterRun = await workflowDetail(page, id);
  const run = (afterRun.runs ?? []).find(
    (item: { id?: string }) => item.id === seeded.run_id,
  );
  expect(run?.profile?.modelId ?? beforeRun.runs?.[0]?.profile?.modelId).toBe(
    seeded.run_model,
  );
  const batches = await repairBatches(page, id);
  const items = Array.isArray(batches) ? batches : [];
  expect(items.length).toBeGreaterThan(0);
});
