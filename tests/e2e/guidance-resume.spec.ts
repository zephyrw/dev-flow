import { mockProject } from "./mock-workflow.js";
import { test, expect } from "@playwright/test";

test("persisted guidance remains visible after reload and continuation is not shown as initial development", async ({ page }) => {
  const workflow = { id: "wf-guidance", project_id: "p1", title: "指导续跑展示",
    state: "EXECUTING", stage: "execute", plan_revision: 1, run_id: "continued", version: 4 };
  const event = (seq: number, type: string, payload: unknown) => ({ workflow_id: workflow.id,
    event_seq: seq, created_at: `2026-09-28T08:00:0${seq}Z`, type, payload });
  const detail = {
    workflow, project: { ...mockProject(), data: { mode: "directory" }, id: "p1", name: "隔离展示测试" },
    plan: { plan: { task_model: "leaf-v1", modules: [], tasks: [], tests: [] } },
    tasks: [], test_progress: { total: 1, passed: 0, failed: 0, cases: [] },
    evidence: [], runs: [], attention: null,
    events: [event(2, "PreparationStarted", { message: "正在检查并复用已有工作区" }),
      event(3, "StateChanged", { from: "QUEUED", to: "EXECUTING", stage: "execute", resumed: true })],
    formal_guidance: [{ id: "message-1", workflow_id: workflow.id, feedback_id: "feedback-1",
      created_at: "2026-09-28T08:00:01Z", text: "这个 Token 已是最新，不要刷新，继续剩余测试。" }],
  };
  const errors: Error[] = [];
  page.on("pageerror", (error) => errors.push(error));
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/functional-issues") || path.endsWith("/asides")) return route.fulfill({ json: [] });
    if (path.endsWith("/projects")) return route.fulfill({ json: [detail.project] });
    if (path.endsWith("/workflows")) return route.fulfill({ json: [workflow] });
    return route.fulfill({ json: detail });
  });
  await page.routeWebSocket("**/api/notifications", () => {});
  await page.routeWebSocket("**/api/events?*", () => {});
  await page.goto(`/?workflow=${workflow.id}`);
  for (let visit = 0; visit < 2; visit++) {
    if (visit) await page.reload();
    const sidebar = page.locator(".execution-sidebar");
    if (!(await sidebar.isVisible())) await page.getByRole("button", { name: "执行过程", exact: true }).click();
    const logs = page.locator(".logs");
    await expect(logs.getByText("你的指导", { exact: true })).toHaveCount(1);
    await expect(logs.locator('[data-speaker="user"] .conversation-turn-text')).toHaveText(detail.formal_guidance[0]!.text);
    await expect(logs).toContainText(detail.formal_guidance[0]!.text);
    await expect(logs).toContainText("继续开发与自测");
    await expect(logs).toContainText("检查并复用已有工作区");
    await expect(logs).not.toContainText("开始开发与自测");
  }
  expect(errors).toEqual([]);
});

test("question and exact reply remain styled conversation turns after submission and reload", async ({ page }, testInfo) => {
  const workflow = { id: "wf-question-history", project_id: "p1", title: "问答原文展示", state: "WAITING_INPUT", stage: "execute", version: 1, plan_revision: 1 };
  const record = { id: "int-history", workflow_id: workflow.id, source_run_id: "r", source_plan_revision: 1,
    purpose: "implement", role: "executor", status: "pending", created_at: "2026-10-17T00:00:00Z",
    request: { kind: "question", title: "确认测试环境", message: "检测到测试环境和正式环境。", question: "本次在哪个环境验证？",
      choices: [{ id: "test", label: "测试环境" }] }, responded_at: undefined as string | undefined,
    response: undefined as { request_id: string; action: string; choice_id?: string; answer?: string } | undefined };
  const detail = { workflow, project: mockProject(), plan: { plan: { task_model: "leaf-v1", modules: [], tasks: [], tests: [] } },
    tasks: [], runs: [], evidence: [], attention: null, user_interactions: [record],
    events: [{ workflow_id: workflow.id, event_seq: 1, created_at: record.created_at,
      type: "StateChanged", payload: { from: "EXECUTING", to: "WAITING_INPUT", stage: "execute" } }] as any[] };
  const errors: Error[] = [];
  page.on("pageerror", error => errors.push(error));
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/user-interactions/current")) return route.fulfill({ json: { interaction: record.status === "pending" ? record : null } });
    if (path.endsWith("/respond")) {
      record.response = route.request().postDataJSON();
      record.responded_at = "2026-10-17T00:00:01Z";
      record.status = "answered";
      workflow.state = "EXECUTING";
      detail.events.push({ workflow_id: workflow.id, event_seq: 2, created_at: "2026-10-17T00:00:02Z",
        type: "StateChanged", payload: { from: "QUEUED", to: "EXECUTING", stage: "execute", user_guidance: true } });
      return route.fulfill({ json: { success: true, interaction: record } });
    }
    if (path.endsWith("/projects")) return route.fulfill({ json: [detail.project] });
    if (path.endsWith("/workflows")) return route.fulfill({ json: [workflow] });
    if (path.endsWith("/asides") || path.endsWith("/functional-issues")) return route.fulfill({ json: [] });
    return route.fulfill({ json: detail });
  });
  await page.routeWebSocket("**/api/notifications", () => {});
  await page.routeWebSocket("**/api/events?*", () => {});
  await page.goto(`/?workflow=${workflow.id}`);
  await page.getByRole("radio", { name: "测试环境" }).check();
  const answer = "只验证 **测试环境**。\n保留现有登录，<不要发布>。";
  await page.locator(".user-interaction-textarea").fill(answer);
  await page.getByRole("button", { name: "提交回答", exact: true }).click();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.reload();
    if (!(await page.locator(".execution-sidebar").isVisible())) await page.getByRole("button", { name: "执行过程", exact: true }).click();
    const logs = page.locator(".logs");
    await expect(logs.locator('[data-speaker="assistant"]')).toContainText(record.request.question);
    const reply = logs.locator('[data-speaker="user"]');
    await expect(reply).toHaveCount(1);
    await expect(reply.locator(".conversation-turn-text")).toHaveText(`测试环境\n\n${answer}`);
    await expect(reply.locator("strong")).toHaveCount(0);
    await expect(logs).not.toContainText("本轮将你的指导原文发送");
    await expect(logs).not.toContainText("阶段更新");
    await expect(logs).not.toContainText("执行已暂停，等待处理");
    await expect(logs.locator('[data-speaker="assistant"] + [data-speaker="user"]')).toHaveCount(1);
    const fits = await reply.evaluate(el => el.scrollWidth <= el.clientWidth);
    expect(fits).toBe(true);
    await page.locator(".execution-sidebar").screenshot({ path: testInfo.outputPath(`conversation-${width}.png`) });
  }
  expect(errors).toEqual([]);
});
