import { test, expect, type Page } from "@playwright/test";

async function screen(page: Page, blocked = true) {
  const workflow = {
    id: "wf-runtime-ui",
    title: "环境故障提示验证",
    project_id: "p1",
    state: blocked ? "BLOCKED" : "EXECUTING",
    stage: blocked ? "blocked" : "execute",
    version: 7,
    plan_revision: 1,
    environment_revision: 0,
    feedback: [],
    run_id: "run-fixture",
    updated_at: new Date().toISOString(),
    blocker: blocked
      ? {
          code: "CLI_VERSION_UNSUPPORTED",
          message: "The 'gpt-6-astra' model requires a newer version of Codex.",
        }
      : undefined,
  };
  const detail = {
    workflow,
    plan: null,
    tasks: [],
    evidence: [],
    operations: [],
    events: [],
    runs: [
      {
        id: "run-fixture",
        profile: {
          adapterId: "codex",
          executableRef: "C:/tools/codex.exe",
          modelId: "gpt-6-astra",
        },
      },
    ],
  };
  const submissions: any[] = [];
  let reject = false;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === "POST") {
      submissions.push({ path, body: route.request().postDataJSON() });
      if (reject)
        return route.fulfill({
          status: 409,
          json: { error: { message: "任务状态已变化，请刷新后重试" } },
        });
      workflow.state = "EXECUTING";
      workflow.stage = "planner_takeover";
      workflow.blocker = undefined;
      workflow.version++;
      return route.fulfill({ json: { ok: true } });
    }
    await route.fulfill({
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
  return {
    submissions,
    reject: () => {
      reject = true;
    },
  };
}

test("runtime recovery instructions are beside task status and resume the same task without a sticky success message", async ({
  page,
}) => {
  const fixture = await screen(page);
  const card = page.getByRole("region", { name: "运行问题处理方法" });
  await expect(
    card.getByRole("heading", { name: "工具版本不兼容" }),
  ).toBeVisible();
  await expect(card).toContainText("C:/tools/codex.exe");
  await expect(card).toContainText("gpt-6-astra");
  await expect(card).toContainText("--version");
  await expect(card).toContainText("不计入模型整改失败次数");
  await expect(
    page.getByRole("button", { name: "继续这个任务", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".attention-message")).toContainText(
    "工具版本不兼容",
  );
  await expect(
    page.locator(".execution-sidebar .runtime-failure-notice"),
  ).toHaveCount(0);
  expect(
    await card.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
  ).toBe(true);
  await page.screenshot({
    path: ".cache/runtime-failure/recovery-card.png",
    fullPage: true,
  });
  await card.getByRole("button", { name: "已处理，继续原任务" }).click();
  await expect(card).toHaveCount(0);
  expect(fixture.submissions).toHaveLength(1);
  expect(fixture.submissions[0]).toMatchObject({
    path: "/api/workflows/wf-runtime-ui/feedback",
    body: { expected_version: 7, scope: "within_plan" },
  });
  await expect(page.getByText("已保存，正在继续这个任务。")).toHaveCount(0);
});

test("failed recovery stays with the recovery action and does not imply the task resumed", async ({
  page,
}) => {
  const fixture = await screen(page);
  fixture.reject();
  const card = page.getByRole("region", { name: "运行问题处理方法" });
  await card.getByRole("button", { name: "已处理，继续原任务" }).click();
  await expect(card.getByRole("alert")).toContainText("任务状态已变化");
  await expect(
    card.getByRole("button", { name: "已处理，继续原任务" }),
  ).toBeEnabled();
  await expect(page.getByText("已保存，正在继续这个任务。")).toHaveCount(0);
});

test("submitting guidance clears the form without leaving an unexplained footer", async ({
  page,
}) => {
  const fixture = await screen(page, false);
  if (!(await page.locator(".execution-sidebar").isVisible()))
    await page.getByRole("button", { name: "执行过程", exact: true }).click();
  await page.getByRole("button", { name: "给执行模型补充指导" }).click();
  await page
    .getByPlaceholder("输入指导或调整内容... 输入 @ 引用文件或目录")
    .fill("继续核对原计划中的未完成项");
  await page.getByRole("button", { name: "发送指导并继续" }).click();
  await expect(
    page.getByRole("button", { name: "给执行模型补充指导" }),
  ).toBeVisible();
  expect(fixture.submissions).toHaveLength(1);
  await expect(page.locator(".task-interaction [role=status]")).toHaveCount(0);
  await expect(page.getByText("已保存，正在继续这个任务。")).toHaveCount(0);
});
