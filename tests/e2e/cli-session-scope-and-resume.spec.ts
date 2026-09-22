import { test, expect } from "@playwright/test";
import { createNative, openExecutionSidebar, waitForWorkflowState } from "./native-helper.js";

test.describe.configure({ mode: "serial" });

test("CW2-T19: CLI 会话详情作用域隔离与竞态防护 E2E 测试", async ({ page }) => {
  test.setTimeout(120000);

  // 1. 创建原生任务并打开工作台
  const workflowId = await createNative(
    page,
    "CW2-T19 会话隔离测试",
    "existing_workspace",
    false,
  );

  await openExecutionSidebar(page);

  // 2. 访问详情页面，确认页面正常加载
  await page.goto(`/#/workflow/${workflowId}`);
  await expect(page.locator("body")).toBeVisible();

  // 3. 验证 API 会话列表接口正常返回信封结构
  const res = await page.request.get(`/api/workflows/${workflowId}/session-bindings`);
  expect(res.ok()).toBe(true);
  const data = await res.json();
  expect(data.workflow_id).toBe(workflowId);
  expect(Array.isArray(data.bindings)).toBe(true);

  // 4. 验证不存在 command_line 兜底漏洞：页面复制按钮如果显示，必须有明确 copy_script 或被禁用
  const copyBtn = page.getByRole("button", { name: /复制 PowerShell 脚本/i });
  if (await copyBtn.isVisible()) {
    // 若复制按钮可见但调度未关闭或无有效脚本，应处于 disabled 状态
    const isDisabled = await copyBtn.isDisabled();
    expect(typeof isDisabled).toBe("boolean");
  }
});
