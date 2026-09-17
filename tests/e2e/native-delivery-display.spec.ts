import { test, expect } from "@playwright/test";

test("native report results and before/after-human reviews display independently", async ({
  page,
}) => {
  const workflow = {
    id: "wf-native-display",
    title: "交付结果展示验证",
    project_id: "p1",
    state: "REVIEWING",
    stage: "quality_before_human",
    version: 1,
    plan_revision: 1,
    environment_revision: 0,
    feedback: [],
  };
  const task = {
    id: "T01",
    title: "登录实现",
    module_id: "m",
    paths: ["src"],
    status: "verified",
    development_status: "completed",
    implementation_status: "completed",
    validation_status: "passed",
  };
  const detail = {
    workflow,
    human_accepted: false,
    plan: {
      plan: {
        task_model: "native-v2",
        tasks: [task],
        tests: [],
        modules: [{ id: "m", title: "登录" }],
        markdown: "计划",
      },
    },
    tasks: [task],
    runs: [],
    events: [],
    workspaces: [],
    evidence: [],
    operations: [],
    test_progress: {
      total: 2,
      passed: 2,
      failed: 0,
      cases: [1, 2].map((n) => ({
        id: `AT-E0${n}`,
        test_id: `AT-E0${n}`,
        layer: "e2e",
        task_ids: ["T01"],
        status: "passed",
      })),
    },
  };
  const writes: string[] = [];
  await page.route("**/api/**", (route) => {
    if (route.request().method() !== "GET") writes.push(route.request().url());
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({
      json:
        path === "/api/projects"
          ? [{ id: "p1", name: "展示测试" }]
          : path === "/api/workflows"
            ? [workflow]
            : /\/(diff|asides|functional-issues)$/.test(path)
              ? []
              : detail,
    });
  });
  await page.routeWebSocket("**/api/notifications", () => {});
  await page.routeWebSocket("**/api/events?*", () => {});
  await page.goto(`/?workflow=${workflow.id}`);
  const human = page.locator(".stage-track li").filter({ hasText: "人工验收" });
  await expect(page.locator(".stage-track [aria-current=step]")).toHaveText(
    /验收前质量审查/,
  );
  await expect(human).not.toHaveClass(/past/);
  await expect(human).not.toContainText("✓");
  await expect(page.getByLabel("交付进度")).toContainText(
    "计划用例报告通过2/2",
  );
  await expect(page.getByLabel("交付进度")).toContainText("工作包已交付1/1");
  await page.getByRole("button", { name: "测试结果", exact: true }).click();
  await expect(page.locator(".test-case .badge")).toHaveText([
    "报告通过",
    "报告通过",
  ]);
  await expect(
    page.getByText(
      "报告通过表示关联测试的报告结果；是否满足原计划由现有质量审核判断，人工验收单独确认。",
    ),
  ).toBeVisible();
  await page.screenshot({
    path: ".cache/progress-display-20260917/before-human.png",
    fullPage: true,
  });
  workflow.stage = "review";
  detail.human_accepted = true;
  await page.reload();
  await expect(page.locator(".stage-track [aria-current=step]")).toHaveText(
    /验收后代码复核/,
  );
  await expect(human).toContainText("✓");
  expect(writes).toEqual([]);
});
