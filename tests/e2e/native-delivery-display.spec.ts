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

test("附件状态展示：归档状态显示状态和原因", async ({ page }) => {
  const workflow = {
    id: "wf-attachment-status",
    title: "附件状态展示",
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
    test_progress: { total: 0, passed: 0, failed: 0, cases: [] },
    attachment_status: [
      {
        delivery_id: "del-1",
        repo_id: "main",
        path: ".reports/unit.json",
        state: "archived",
      },
      {
        delivery_id: "del-1",
        repo_id: "main",
        path: ".reports/missing.json",
        state: "missing",
        detail: "文件不存在",
      },
    ],
  };
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/attachments")) {
      return route.fulfill({ json: { attachment_status: detail.attachment_status } });
    }
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
  await page.getByRole("button", { name: "测试结果", exact: true }).click();
  const attachments = page.getByLabel("附件归档状态");
  await expect(attachments).toContainText("已归档");
  await expect(attachments).toContainText("文件缺失");
  await expect(attachments).toContainText("文件不存在");
  await expect(attachments).toContainText(".reports/missing.json");
});

test("SA-E24 native delivery still completes without requiring subagent observation", async ({
  page,
}) => {
  test.setTimeout(180000);
  const { createNative, approvePlan, setNativeFixture, testInstance } =
    await import("./native-helper.js");
  await setNativeFixture(page, {});
  const id = await createNative(
    page,
    "E24 无子观察也可交付",
    "existing_workspace",
  );
  await approvePlan(page);
  await expect(page.locator(".header-title-wrapper .badge")).toContainText(
    "等待你的验收",
    { timeout: 90000 },
  );
  const detail = await (await page.request.get(`/api/workflows/${id}`)).json();
  expect(detail.workflow.state).toBe("HUMAN_PENDING");
  const tree = await (
    await page.request.get(`/api/workflows/${id}/conversations`)
  ).json();
  expect(Array.isArray(tree.nodes)).toBe(true);
  const instance = testInstance();
  expect(instance.port).not.toBe(4810);
  expect(page.url()).toContain(String(instance.port));
});
