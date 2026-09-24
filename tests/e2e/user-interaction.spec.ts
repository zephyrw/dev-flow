import { test, expect } from "@playwright/test";

test("E01 — 真实浏览器中的通用人机交互（操作请求、稍后处理、横幅恢复与问题回答）", async ({
  page,
}) => {
  const workflowId = "wf-int-e2e";
  const workflow = {
    id: workflowId,
    project_id: "p1",
    title: "交互核验流程",
    state: "WAITING_INPUT",
    plan_revision: 1,
  };

  const project = { id: "p1", name: "E2E 项目" };

  let currentInteraction: any = {
    id: "int-act-e2e-1",
    workflow_id: workflowId,
    source_run_id: "run-e2e-1",
    source_plan_revision: 1,
    purpose: "execute",
    role: "executor",
    status: "pending",
    created_at: new Date().toISOString(),
    request: {
      kind: "action_required",
      title: "请人工完成第三方鉴权登录",
      message: "在弹出的认证页中完成授权，完成后点击继续",
      action_label: "授权已完成，继续",
    },
  };

  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;

    if (path.endsWith(`/workflows/${workflowId}/user-interactions/current`)) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(
          currentInteraction ? { interaction: currentInteraction } : { interaction: null },
        ),
      });
    }

    if (path.includes("/user-interactions/") && path.endsWith("/respond")) {
      const body = JSON.parse(route.request().postData() || "{}");
      currentInteraction = null; // 用户已回答，清除当前待处理
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          interaction: {
            id: "int-act-e2e-1",
            status: "answered",
            response: body,
          },
        }),
      });
    }

    if (path.endsWith("/projects")) {
      return route.fulfill({ json: [project] });
    }

    if (path.endsWith("/workflows")) {
      return route.fulfill({ json: [workflow] });
    }

    if (path.endsWith(`/workflows/${workflowId}`)) {
      return route.fulfill({
        json: {
          workflow,
          project,
          plan: { plan: { task_model: "leaf-v1", modules: [], tasks: [], tests: [] } },
          tasks: [],
          events: [],
          runs: [],
          evidence: [],
          attention: null,
        },
      });
    }

    return route.fulfill({ json: [] });
  });

  await page.routeWebSocket("**/api/notifications", () => {});
  await page.routeWebSocket("**/api/events?*", () => {});

  // 1. 打开工作台页面
  await page.goto(`/?workflow=${workflowId}`);

  // 2. 验证弹窗自动显示并核对标题和按钮
  const dialog = page.locator(".app-dialog-container");
  await expect(dialog).toBeVisible();
  await expect(page.locator(".app-dialog-title")).toHaveText("请人工完成第三方鉴权登录");
  await expect(page.locator(".user-interaction-message")).toContainText("在弹出的认证页中完成授权");

  const confirmBtn = page.locator(".btn-interaction-confirm");
  await expect(confirmBtn).toHaveText("授权已完成，继续");

  // 3. 测试稍后处理：点击稍后处理，弹窗关闭，常驻横幅出现
  const laterBtn = page.getByRole("button", { name: "稍后处理" });
  await laterBtn.click();
  await expect(dialog).not.toBeVisible();

  const pendingBanner = page.locator(".user-interaction-pending-banner");
  await expect(pendingBanner).toBeVisible();
  await expect(pendingBanner).toContainText("请人工完成第三方鉴权登录");

  // 4. 从横幅中点击“处理请求”，弹窗重新展开
  const resumeBtn = pendingBanner.getByRole("button", { name: "处理请求" });
  await resumeBtn.click();
  await expect(dialog).toBeVisible();

  // 5. 点击“授权已完成，继续”，完成提交
  await confirmBtn.click();
  await expect(dialog).not.toBeVisible();
  await expect(pendingBanner).not.toBeVisible();
});
