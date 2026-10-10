import { installMockWorkflowConfiguration, mockProject } from "./mock-workflow.js";
import { test, expect } from "@playwright/test";

test("acceptance composer sends questions as original formal guidance and keeps its bottom clear", async ({ page }) => {
  const workflow = { id: "wf-acceptance-guidance", project_id: "p1", title: "验收指导", state: "HUMAN_PENDING", stage: "accept", version: 2, plan_revision: 1 };
  const detail = { workflow, project: { ...mockProject(), data: { mode: "directory" }, id: "p1", name: "隔离验收" },
    plan: { plan: { task_model: "native-v2", modules: [], tasks: [], tests: [] } },
    tasks: [], runs: [], events: [], evidence: [], operations: [], attention: null,
    test_progress: { total: 0, cases: [] }, queue: { owners: ["other-task"] } };
  const writes: { path: string; body: any }[] = [], errors: Error[] = [];
  page.on("pageerror", error => errors.push(error));
  await page.route("**/api/**", route => {
    const req = route.request(), path = new URL(req.url()).pathname;
    if (req.method() === "POST") {
      // Opening the model dialog also verifies access. Count task mutations
      // separately so that lookup does not masquerade as duplicate feedback.
      if (path.startsWith("/api/workflows/")) writes.push({ path, body: req.postDataJSON() });
      return route.fulfill({ json: { message_id: "sent", status: "accepted" } });
    }
    if (path.endsWith("/functional-issues")) return route.fulfill({ json: [{ issue_id: "legacy", description: "旧功能问题", status: "ready_for_retest", fix_delivery_id: "delivery" }] });
    if (path.endsWith("/functional-issue-views")) return route.fulfill({ json: [] });
    if (path.endsWith("/execution-spec")) return route.fulfill({ json: { spec: {}, spec_revision: 1, workflow_version: workflow.version, can_edit: true } });
    if (path.endsWith("/asides")) return route.fulfill({ json: [] });
    if (path.endsWith("/conversations")) return route.fulfill({ json: { nodes: [], attempts: [], roots: [], active_root_id: "root" } });
    if (path.endsWith("/projects")) return route.fulfill({ json: [detail.project] });
    if (path.endsWith("/workflows")) return route.fulfill({ json: [workflow] });
    return route.fulfill({ json: detail });
  });
  await page.routeWebSocket("**/api/notifications", () => {});
  await page.routeWebSocket("**/api/events?*", () => {});
  await installMockWorkflowConfiguration(page, workflow.version);
  await page.goto(`/?workflow=${workflow.id}`);
  if (!(await page.locator(".execution-sidebar").isVisible())) await page.getByRole("button", { name: "执行过程", exact: true }).click();
  const input = page.locator(".task-interaction textarea");
  const message = "启动前后端，并回答：做过 OpenTabs 真实浏览器测试吗？没做就补做。";
  await input.fill(message);
  await input.press("Control+Enter");
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toMatchObject({ path: `/api/workflows/${workflow.id}/conversation-messages`, body: { text: message, client_mode: "formal" } });
  expect(writes[0]!.body).not.toHaveProperty("repair_model");
  await expect(page.locator(".task-interaction")).not.toContainText("功能问题与复测");
  await expect(page.locator(".task-interaction")).not.toContainText("本次修复由谁处理");
  await expect(page.locator(".task-interaction")).not.toContainText("占用任务");
  await expect(page.locator(".conversation-composer-hint")).toHaveCount(0);
  await expect(page.locator(".task-interaction > :last-child")).toHaveClass("composer-anchor");
  await expect(page.locator(".conversation-composer > :last-child")).toHaveClass("conversation-composer-footer");
  await page.getByRole("button", { name: /^规划模型：/ }).click();
  const history = page.getByLabel("任务反馈记录");
  await expect(history).toContainText("旧功能问题");
  await history.getByRole("button", { name: "复测通过", exact: true }).click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1]).toMatchObject({ path: `/api/workflows/${workflow.id}/functional-issues/legacy/confirm`, body: { passed: true, delivery_revision_id: "delivery" } });
  expect(errors).toEqual([]);
});
