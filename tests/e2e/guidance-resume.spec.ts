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
    await expect(logs.getByText("收到你的指导", { exact: true })).toHaveCount(1);
    await expect(logs).toContainText(detail.formal_guidance[0]!.text);
    await expect(logs).toContainText("继续开发与自测");
    await expect(logs).toContainText("检查并复用已有工作区");
    await expect(logs).not.toContainText("开始开发与自测");
  }
  expect(errors).toEqual([]);
});
