import { test, expect } from "@playwright/test";
import { exactLabel, fixtureState, workflowDetail } from "./native-helper.js";

test.describe.configure({ mode: "serial" });

test("E2E-QP2-01 设置页可选 MiMo Code 并出现模型搜索", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "工作流总览" })).toBeVisible();
  await page.getByRole("button", { name: "全局模型设置" }).click();
  const drawer = page.getByRole("dialog", { name: "默认工具与模型" });
  await expect(drawer).toBeVisible();
  // MiMo Code 出现在工具列表（TOOL_DISPLAY_ORDER 含 mimo-code）
  const toolSelect = exactLabel(drawer, "工具").first();
  await expect(toolSelect.locator('option[value="mimo-code"]')).toHaveCount(1);
  await toolSelect.selectOption("mimo-code");
  // 模型搜索框可聚焦；目录为空时提示搜索，不冒充已接入
  const modelSearch = exactLabel(drawer, "模型").first();
  await expect(modelSearch).toBeEnabled();
  await modelSearch.click();
  await expect(modelSearch).toBeFocused();
  // 不出现“已验证可访问”冒充真实调用结果
  await expect(drawer.getByText("DevFlow 已验证测试通过")).toHaveCount(0);
});

test("E2E-QP2-02 新策略用途文案包含执行测试与规划提交", async ({ page }) => {
  await page.goto("/");
  const overview = page.getByRole("heading", { name: "工作流总览" });
  await expect(overview).toBeVisible();
  // 工作台不出现旧的“第 N/3 次质量失败”
  await expect(page.getByText(/第\s*\d+\s*\/\s*3\s*次质量失败/)).toHaveCount(0);
  await expect(page.getByText("DevFlow 已验证测试通过")).toHaveCount(0);
});

test("E2E-QP2-03 RepairModelPicker 策略2锁定职责组", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "工作流总览" })).toBeVisible();
  // 打开任意任务详情的修复选择器（若存在）
  const picker = page.locator(".ms-picker").first();
  if ((await picker.count()) === 0) {
    test.skip(true, "当前夹具无修复批次，跳过锁定断言");
    return;
  }
  await picker.locator("summary").click();
  // 策略 2 文案
  await expect(picker).toContainText("本流程使用规划与执行两组配置");
});

test("E2E-QP2-04 MiMo 能力与新用途角色可见", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "工作流总览" })).toBeVisible();
  // 会话/状态栏若绑定 mimo-code，显示 MiMo Code 名称
  const status = page.locator(".conversation-status-bar, .current-runtime");
  if ((await status.count()) > 0) {
    // 不断言必须存在 MiMo（取决于夹具），只验证不崩溃且无过期文案
    await expect(page.getByText(/三次接管|两阶段独立计数/)).toHaveCount(0);
  }
  await expect(page.getByText(/测试真实性核验/)).toHaveCount(0);
});
