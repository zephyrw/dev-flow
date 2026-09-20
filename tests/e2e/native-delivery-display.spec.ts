import { test, expect } from "@playwright/test";
import { fixtureState } from "./native-helper.js";

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
      { delivery_id: "del-bad", repo_id: "main", path: { invalid: true }, state: "pending" },
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

test("真实附件归档完成后通过事件自动刷新，并在刷新页面后保留结果", async ({ page }) => {
  test.setTimeout(180_000);
  const token = fixtureState().shutdownToken;
  const seeded = await page.request.post("/__fixture/attachments", {
    headers: { Origin: "http://localhost:14811" }, data: { token },
  });
  expect(seeded.ok()).toBe(true);
  const fixture = await seeded.json();
  const socket = page.waitForEvent("websocket", (connection) => connection.url().includes("/api/events?") && connection.url().includes(fixture.workflow_id));
  await page.goto(`/?workflow=${fixture.workflow_id}`);
  await socket;
  await page.getByRole("button", { name: "测试结果", exact: true }).click();
  const attachments = page.getByLabel("附件归档状态");
  await expect(attachments.locator(".badge")).toHaveText(["待归档", "待归档"]);
  const triggered = await page.request.post("/__fixture/attachments/drain", {
    headers: { Origin: "http://localhost:14811" }, data: { token, ...fixture },
  });
  expect(triggered.ok()).toBe(true);
  await expect(attachments).toContainText("已归档");
  await expect(attachments).toContainText("文件缺失");
  await expect(attachments).toContainText("文件不存在");
  await expect(attachments.locator("article")).toHaveCount(2);
  const persisted = await page.request.get(`/api/workflows/${fixture.workflow_id}`);
  expect(persisted.ok()).toBe(true);
  const detail = await persisted.json();
  expect(detail.workflow.state).toBe("HUMAN_PENDING");
  expect(detail.attachment_status.map((record: any) => record.state).sort()).toEqual(["archived", "missing"]);
  expect(detail.events.some((event: any) => event.type === "AttachmentArchiveUpdated")).toBe(true);
  await page.reload();
  await page.getByRole("button", { name: "测试结果", exact: true }).click();
  await expect(page.getByLabel("附件归档状态")).toContainText("已归档");
  await expect(page.getByLabel("附件归档状态")).toContainText("文件缺失");
});
