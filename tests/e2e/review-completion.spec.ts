import { test, expect } from "@playwright/test";

test("不完整审查的继续按钮交给规划复核，不重启开发或清空证据", async ({
  page,
}) => {
  const workflow = {
    id: "wf-review-completion",
    title: "整改计划补全验证",
    project_id: "p1",
    state: "BLOCKED",
    stage: "blocked",
    version: 1,
    plan_revision: 1,
    environment_revision: 0,
    feedback: [],
    run_id: "run-review",
    updated_at: new Date().toISOString(),
    blocker: {
      code: "REPAIR_PLAN_INCOMPLETE",
      message: "质量不合格必须返回完整正式整改计划",
    },
  };
  const detail = {
    workflow,
    plan: null,
    tasks: [],
    evidence: [],
    operations: [],
    events: [],
    runs: [],
  };
  const posts: string[] = [];
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === "POST") {
      posts.push(path);
      workflow.state = "REVIEW_QUEUED";
      workflow.stage = "quality_before_human";
      return route.fulfill({ json: workflow });
    }
    return route.fulfill({
      json:
        path === "/api/projects"
          ? [{ id: "p1", name: "隔离页面" }]
          : path === "/api/workflows"
            ? [workflow]
            : /\/(asides|functional-issues|messages)$/.test(path)
              ? []
              : detail,
    });
  });
  await page.routeWebSocket("**/api/notifications", () => {});
  await page.routeWebSocket("**/api/events?*", () => {});
  await page.goto("/");
  await page
    .getByRole("button")
    .filter({ has: page.getByRole("heading", { name: workflow.title }) })
    .click();
  await page
    .getByRole("button", { name: "继续生成整改计划", exact: true })
    .click();
  await expect
    .poll(() => posts)
    .toEqual(["/api/workflows/wf-review-completion/review/retry"]);
  await expect(
    page.getByRole("button", { name: "继续生成整改计划", exact: true }),
  ).toHaveCount(0);
});
