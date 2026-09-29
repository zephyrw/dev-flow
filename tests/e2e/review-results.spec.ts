import { test, expect } from "@playwright/test";

test("review tab renders current findings and repair instructions without legacy coverage", async ({ page }) => {
  const workflow = { id: "wf-review-results", project_id: "p1", title: "代码复核结果展示",
    state: "EXECUTING", stage: "execute", plan_revision: 1, run_id: "repair-run", version: 4 };
  const detail = {
    workflow, project: { id: "p1", name: "隔离展示测试" },
    plan: { plan: { task_model: "leaf-v1", modules: [], tasks: [], tests: [] } },
    tasks: [], test_progress: { total: 1, passed: 0, failed: 0, cases: [] }, evidence: [], runs: [], events: [], attention: null,
    review: { verdict: "changes_required", plan_revision: 1, summary: "只读复核确认十项需修复的代码问题。",
      findings: Array.from({ length: 10 }, (_, index) => ({ id: `R${String(index + 1).padStart(2, "0")}`,
        severity: "P1", path: `src/fixture-${index}.ts`, trigger: "执行原计划场景", evidence: `证据 ${index + 1}`,
        consequence: "结果不完整", reason: `整改要求 ${index + 1}` })), unresolved_questions: [],
      repair_document: "## R01—R10 整改意见\n\n沿用原批准计划。全部整改完成后，再交由执行角色测试。" },
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
  await page.getByRole("button", { name: "代码复核", exact: true }).click();
  const results = page.locator(".review-results");
  await expect(results).toContainText("需要整改");
  await expect(results).toContainText(detail.review.summary);
  await expect(results.locator("article")).toHaveCount(10);
  await expect(results).toContainText("R01");
  await expect(results).toContainText("R10");
  await expect(results).toContainText("整改要求 10");
  await expect(results).toContainText("全部整改完成后，再交由执行角色测试");
  await expect(results).not.toContainText("需要重新批准");
  await page.getByRole("button", { name: "概览", exact: true }).click();
  await page.getByRole("button", { name: "代码复核", exact: true }).click();
  await expect(results).toBeVisible();
  expect(errors).toEqual([]);
});
