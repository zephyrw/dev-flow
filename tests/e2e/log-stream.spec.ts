import { test, expect } from "@playwright/test";

test("continuous WebSocket output becomes visible before the stream ends and survives an older HTTP response", async ({
  page,
}) => {
  const workflow = {
    id: "wf-stream",
    title: "连续日志验收",
    project_id: "p1",
    state: "EXECUTING",
    version: 1,
    plan_revision: 1,
    environment_revision: 0,
    feedback: [],
  };
  const detail = {
    workflow,
    plan: null,
    tasks: [],
    evidence: [],
    runs: [],
    events: [],
    review: null,
    environment: null,
  };
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const data =
      path === "/api/projects"
        ? [{ id: "p1", name: "日志测试" }]
        : path === "/api/workflows"
          ? [workflow]
          : detail;
    await route.fulfill({ json: data });
  });
  let timer: ReturnType<typeof setInterval> | undefined;
  let sent = 0;
  await page.routeWebSocket("**/api/notifications", () => {});
  await page.routeWebSocket("**/api/events?*", (socket) => {
    timer = setInterval(() => {
      sent++;
      socket.send(
        JSON.stringify({
          workflow_id: workflow.id,
          project_id: "p1",
          event_seq: sent,
          created_at: new Date().toISOString(),
          type: sent % 10 === 0 ? "StateChanged" : "AgentEvent",
          payload: { event: "step_update", step_update: {step_index:1, step_type:"agent_response",state:"ACTIVE",text_delta:`流式日志-${sent}\n`} },
        }),
      );
    }, 30);
    socket.onClose(() => clearInterval(timer));
  });
  try {
    await page.goto("/");
    await page
      .getByRole("button")
      .filter({ has: page.getByRole("heading", { name: workflow.title }) })
      .click();
    await page.getByRole("button", { name: "执行过程", exact: true }).click();
    await expect(page.locator(".logs")).toContainText("流式日志-1", {
      timeout: 2000,
    });
    expect(timer).toBeDefined();
    await expect.poll(() => sent).toBeGreaterThan(20);
    // State events trigger HTTP snapshots with no events. Previously streamed
    // text must remain visible while the socket keeps sending every 30ms.
    await expect(page.locator(".logs")).toContainText("流式日志-1");
    await page.screenshot({ path: ".cache/e2e-log-stream.png" });
  } finally {
    clearInterval(timer);
  }
});

test("execution narrative keeps payloads collapsed and shows the interrupted stage on every tab", async ({
  page,
}) => {
  const workflow = {
    id: "wf-narrative",
    title: "执行过程验收",
    project_id: "p1",
    state: "BLOCKED",
    version: 1,
    plan_revision: 1,
    environment_revision: 0,
    feedback: [],
    blocker: {
      code: "INTERNAL_FAILURE",
      message: "Expected ',' or '}' in JSON",
    },
  };
  const events = [
    {
      workflow_id: workflow.id,
      event_seq: 1,
      run_id: "run1",
      created_at: new Date().toISOString(),
      type: "AgentEvent",
      payload: {
        event: "step_update",
        step_update: {
          step_index: 1,
          step_type: "tool",
          state: "ACTIVE",
          tool_name: "call_mcp_tool",
          tool_info: {
            parameters: {
              ToolName: "devflow_read_file",
              Arguments: {
                path: "src/customer.ts",
                internal: "payload-only-marker",
              },
            },
            output: "very-long-response-only-marker",
          },
        },
      },
    },
    {
      workflow_id: workflow.id,
      event_seq: 2,
      created_at: new Date().toISOString(),
      type: "StateChanged",
      payload: { from: "EXECUTING", to: "BLOCKED" },
    },
  ];
  const detail = {
    workflow,
    plan: null,
    tasks: [{ id: "t1", title: "筛选修复", status: "pending" }],
    evidence: [],
    runs: [],
    events,
    review: null,
    environment: null,
  };
  await page.route("**/api/**", (route) =>
    route.fulfill({
      json:
        new URL(route.request().url()).pathname === "/api/projects"
          ? [{ id: "p1", name: "过程测试" }]
          : new URL(route.request().url()).pathname === "/api/workflows"
            ? [workflow]
            : detail,
    }),
  );
  await page.routeWebSocket("**/api/notifications", () => {});
  await page.routeWebSocket("**/api/events?*", () => {});
  await page.goto("/");
  await page
    .getByRole("button")
    .filter({ has: page.getByRole("heading", { name: workflow.title }) })
    .click();
  await expect(
    page.getByRole("region", { name: "当前执行进度" }),
  ).toContainText("已暂停 · 开发实施");
  await page.getByRole("button", { name: "执行过程", exact: true }).click();
  await expect(page.locator(".activity").first()).toContainText("读取文件");
  await expect(page.locator(".activity").first()).toContainText("已中断");
  await expect(
    page.locator(".activity").first().locator("pre"),
  ).not.toBeVisible();
  await expect(page.locator(".activity-summary").first()).toHaveText(
    "src/customer.ts",
  );
  await page.screenshot({
    path: ".cache/e2e-execution-narrative.png",
    fullPage: true,
  });
  await page
    .locator(".activity")
    .first()
    .getByText("查看操作详情", { exact: true })
    .click();
  await expect(page.locator(".activity").first().locator("pre")).toBeVisible();
  await page.getByRole("button", { name: "任务进度", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "当前执行进度" }),
  ).toContainText("1 个工作包");
});
