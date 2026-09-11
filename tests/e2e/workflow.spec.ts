import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
test.describe.configure({ mode: "serial" });
test.afterAll(async ({ request }) => {
  const state = JSON.parse(
    readFileSync(resolve(".cache/e2e-state.json"), "utf8"),
  );
  await request.post("/__fixture/shutdown", {
    headers: { Origin: "http://localhost:14811" },
    data: { token: state.pairing },
  });
});
test("E2E-01/05/06/08 real passkey approval, diagrams, evidence and accepted commit", async ({
  page,
  context,
}) => {
  // This scenario performs two actual test runs, passkey ceremonies and a Git
  // commit. Keep per-assertion waits bounded without capping the whole flow at 45s.
  test.setTimeout(120000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  const state = JSON.parse(
    readFileSync(resolve(".cache/e2e-state.json"), "utf8"),
  );
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "连接你的工作台" }),
  ).toBeVisible();
  await page.getByLabel("配对码").fill(state.pairing);
  await page.getByRole("button", { name: "配对并创建通行密钥" }).click();
  await expect(page.getByRole("heading", { name: "工作流总览" })).toBeVisible();
  await page
    .getByRole("button")
    .filter({ has: page.getByRole("heading", { name: "验证审批与交付闭环" }) })
    .click();
  await page.getByRole("button", { name: "计划与图解", exact: true }).click();
  await expect(page.locator(".diagram svg")).toBeVisible();
  await page.screenshot({ path: ".cache/e2e-plan.png", fullPage: true });
  await page.getByRole("button", { name: "批准当前计划" }).click();
  await expect(page.locator(".workflow-bar")).toContainText("等待你的验收", {
    timeout: 30000,
  });
  await page.getByRole("button", { name: "测试证据", exact: true }).click();
  await expect(page.locator("tbody")).toContainText("passed");
  await page.getByRole("button", { name: "开发进度", exact: true }).click();
  await expect(page.locator(".task .badge")).toHaveText("已验证");
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
    timeout: 30000,
  });
  const after = await (
    await page.request.get("/api/workflows/" + state.workflow_id)
  ).json();
  expect(after.evidence.some((e: any) => e.status === "stale")).toBe(true);
  expect(after.evidence.some((e: any) => e.status === "passed")).toBe(true);
  await page.reload();
  await page
    .getByRole("button")
    .filter({ has: page.getByRole("heading", { name: "验证审批与交付闭环" }) })
    .click();
  await page.getByRole("button", { name: "实时输出", exact: true }).click();
  await expect(page.locator(".logs")).toContainText("用户反馈");
  await page.getByRole("button", { name: "验收通过，启动复核" }).click();
  await expect(page.locator(".workflow-bar")).toContainText("已提交", {
    timeout: 30000,
  });
  await page.getByRole("button", { name: "复核结果", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "独立复核结果" }),
  ).toBeVisible();
  await expect(page.getByText("本轮复核", { exact: false })).toContainText(
    "通过",
  );
  await expect(page.getByText("main:app.txt", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "代码差异", exact: true }).click();
  await expect(page.locator(".diff")).toContainText("+after");
  await page.screenshot({ path: ".cache/e2e-complete.png", fullPage: true });
  expect(errors).toEqual([]);
});
test("E2E-05 unauthenticated browser cannot access workflow data", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "使用通行密钥登录" }),
  ).toBeVisible();
  const response = await page.request.get("/api/workflows");
  expect(response.status()).toBe(401);
});
