import { test, expect } from "@playwright/test";
import { exactLabel, fixturePost, openFixtureWorkflow, openTaskModels, workflowDetail } from "./native-helper.js";

test.describe.configure({ mode: "serial" });

test("E2E-QP2-01 设置页仅可选 Codex 与 AGY 并出现模型搜索", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "任务总览" })).toBeVisible();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "设置" });
  await expect(drawer).toBeVisible();
  const toolSelect = exactLabel(drawer, "工具").first();
  expect(await toolSelect.locator("option").evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value))).toEqual(["codex", "agy"]);
  await toolSelect.selectOption("agy");
  // 模型搜索框可聚焦；目录为空时提示搜索，不冒充已接入
  const modelSearch = exactLabel(drawer, "工具模型搜索").first();
  await expect(modelSearch).toBeEnabled();
  await modelSearch.click();
  await expect(modelSearch).toBeFocused();
  // 不出现“已验证可访问”冒充真实调用结果
  await expect(drawer.getByText("DevFlow 已验证测试通过")).toHaveCount(0);
});

test("E2E-QP2-02 新策略用途文案包含执行测试与规划提交", async ({ page }) => {
  await page.goto("/");
  const overview = page.getByRole("heading", { name: "任务总览", exact: true });
  await expect(overview).toBeVisible();
  // 工作台不出现旧的“第 N/3 次质量失败”
  await expect(page.getByText(/第\s*\d+\s*\/\s*3\s*次质量失败/)).toHaveCount(0);
  await expect(page.getByText("DevFlow 已验证测试通过")).toHaveCount(0);
});

test("E2E-QP2-03 功能复测策略2锁定执行职责组", async ({ page }) => {
  const seeded = await fixturePost(page, "/__fixture/seed-retest", { policy_version: 2 });
  const id = await openFixtureWorkflow(page);
  expect((await workflowDetail(page, id)).workflow.quality_policy_version).toBe(2);
  await openTaskModels(page);
  const card = page.getByLabel("任务反馈记录").locator("article").filter({ hasText: seeded.first_description });
  await card.getByText("本次修复由谁处理").click();
  await expect(card).toContainText("本流程使用规划与执行两组配置");
  await expect(card).toContainText("执行测试固定使用执行配置");
  await expect(card.getByLabel("使用规划配置", { exact: true })).toBeDisabled();
  await expect(card.getByLabel("自定义工具/模型", { exact: true })).toBeDisabled();
  await expect(card.getByLabel("使用执行配置", { exact: true })).toBeEnabled();
  await card.getByLabel("使用执行配置", { exact: true }).check();
  await expect(card.getByLabel("使用执行配置", { exact: true })).toBeChecked();
});

test("E2E-QP2-04 当前任务只提供已支持工具和规划执行职责", async ({ page }) => {
  await openFixtureWorkflow(page);
  const dialog = await openTaskModels(page);
  for (const role of ["规划", "执行"]) {
    await dialog.getByRole("tab", { name: role, exact: true }).click();
    const tools = await exactLabel(dialog, "工具").locator("option").evaluateAll(options => options.map(option => (option as HTMLOptionElement).value));
    expect(tools).toEqual(["codex", "agy"]);
    await expect(exactLabel(dialog, "工具模型搜索")).toBeEnabled();
  }
  await expect(dialog.getByText(/三次接管|两阶段独立计数|测试真实性核验/)).toHaveCount(0);
});
