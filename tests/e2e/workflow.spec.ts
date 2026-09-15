import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
test.describe.configure({ mode: "serial" });
test("empty console explains the natural-language entry without manual registration", async ({
  page,
}) => {
  await page.route("**/api/projects", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/workflows", (route) => route.fulfill({ json: [] }));
  await page.goto("/");
  await page.getByRole("button", { name: "使用指南", exact: true }).click();
  await expect(page.locator(".guide-page")).toContainText(
    "用 DevFlow 帮我修复客户列表筛选的问题",
  );
  await page.reload();
  await expect(page.locator(".guide-page")).toBeVisible();
  await expect(page.locator(".guide-page textarea")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "如何开始新任务" }),
  ).toHaveCount(0);
});
test.afterAll(async ({ request }) => {
  const state = JSON.parse(
    readFileSync(resolve(".cache/e2e-state.json"), "utf8"),
  );
  await request.post("/__fixture/shutdown", {
    headers: { Origin: "http://localhost:14811" },
    data: { token: state.shutdownToken },
  });
});
test("E2E-01/05/06/08 local button approval, diagrams, evidence and accepted commit", async ({
  page,
  context,
}) => {
  // This scenario performs two actual test runs, local confirmations and a Git
  // commit. Keep per-assertion waits bounded without capping the whole flow at 45s.
  test.setTimeout(180000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const state = JSON.parse(
    readFileSync(resolve(".cache/e2e-state.json"), "utf8"),
  );
  await page.goto("/");
  await expect(page.getByLabel("配对码")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /登录|通行密钥/ })).toHaveCount(
    0,
  );
  await expect(page.getByRole("heading", { name: "工作流总览" })).toBeVisible();
  await page
    .getByRole("button")
    .filter({ has: page.getByRole("heading", { name: "验证审批与交付闭环" }) })
    .click();
  await page.getByRole("button", { name: "开发计划", exact: true }).click();
  await expect(page.locator(".diagram svg")).toBeVisible();
  await page.screenshot({ path: ".cache/e2e-plan.png", fullPage: true });
  await page.getByRole("button", { name: "批准当前计划" }).click();
  await expect(page.locator(".workflow-bar")).toContainText("等待你的验收", {
    timeout: 60000,
  });
  await page.getByRole("button", { name: "测试结果", exact: true }).click();
  await page.locator(".task-module > summary").first().click();
  await expect(page.locator(".test-case")).toContainText("已通过");
  await page.getByRole("button", { name: "任务进度", exact: true }).click();
  await expect(page.locator(".task .badge")).toHaveText("开发完成");
  await page.screenshot({ path: ".cache/e2e-evidence.png", fullPage: true });
  const before = await (
    await page.request.get("/api/workflows/" + state.workflow_id)
  ).json();
  await page.getByRole("button", { name: "反馈问题", exact: true }).click();
  await page
    .getByLabel("问题反馈")
    .fill("请在原批准范围内再次核对内容与末尾换行，并重新运行测试。");
  await page.getByRole("button", { name: "保存并继续" }).click();
  await expect
    .poll(async () => {
      const d = await (
        await page.request.get("/api/workflows/" + state.workflow_id)
      ).json();
      return d.runs.length;
    })
    .toBeGreaterThan(before.runs.length);
  await expect(page.locator(".workflow-bar")).toContainText("等待你的验收", {
    timeout: 60000,
  });
  const after = await (
    await page.request.get("/api/workflows/" + state.workflow_id)
  ).json();
  expect(after.evidence.some((e: any) => e.status === "stale")).toBe(true);
  expect(after.evidence.some((e: any) => e.status === "passed")).toBe(true);
  await page.reload();
  await page.locator(".execution-toggle").waitFor();
  if (
    (await page.locator(".execution-toggle").getAttribute("aria-expanded")) ===
    "false"
  )
    await page.getByRole("button", { name: "执行过程", exact: true }).click();
  await expect(page.locator(".logs")).toContainText("进入开发实施");
  await page.getByRole("button", { name: "验收通过，启动复核" }).click();
  await expect(page.locator(".workflow-bar")).toContainText("已提交", {
    timeout: 60000,
  });
  await page.getByRole("button", { name: "代码复核", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "独立复核结果" }),
  ).toBeVisible();
  await expect(page.getByText("本轮复核", { exact: false })).toContainText(
    "通过",
  );
  await expect(page.getByText("main:app.txt", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "代码变更", exact: true }).click();
  await expect(page.locator(".changed-files")).toContainText("app.txt");
  await page.locator(".changed-files button").first().click();
  await expect(page.locator(".file-diff")).toContainText("+after");
  const lines = page.locator(".file-diff span");
  const firstLine = await lines.nth(0).boundingBox(),
    secondLine = await lines.nth(1).boundingBox();
  expect(secondLine!.y).toBeGreaterThan(firstLine!.y);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "文件差异" })).toHaveCount(0);
  await page.screenshot({ path: ".cache/e2e-complete.png", fullPage: true });
  expect(errors).toEqual([]);
});
test("E2E-05 a fresh browser opens the console and restores a deep link without login", async ({
  page,
}) => {
  const state = JSON.parse(
    readFileSync(resolve(".cache/e2e-state.json"), "utf8"),
  );
  await page.goto("/?workflow=" + state.workflow_id);
  await expect(page.locator(".workflow-bar")).toContainText("已提交");
  await page.reload();
  await expect(page.locator(".workflow-bar")).toContainText("已提交");
  expect((await page.request.get("/api/workflows")).status()).toBe(200);
  await expect(page.getByRole("button", { name: /登录|通行密钥/ })).toHaveCount(
    0,
  );
});
