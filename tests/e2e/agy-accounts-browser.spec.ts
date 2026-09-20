import { test, expect } from "@playwright/test";
test("zero-workflow account settings, serial manual switch and reload use persisted service facts", async ({
  page,
}) => {
  const unexpected: string[] = [];
  page.on("request", (request) => {
    if (/\/api\/(workflows|projects)/.test(request.url()))
      unexpected.push(request.url());
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "AGY 账号与额度管理" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "配置", exact: true }).click();
  const form = page.getByRole("form", { name: "账号配置" });
  await form.getByLabel("目标模型", { exact: true }).fill("fixture-model");
  await form.getByRole("button", { name: "保存配置" }).click();
  await expect(form).not.toBeVisible();
  await page.getByRole("button", { name: "启动管理", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "停止管理", exact: true }),
  ).toBeVisible();
  const before = await page.request
    .get("/api/account-fixture/facts")
    .then((r) => r.json());
  await page.reload();
  await expect(page.getByText("目标模型：fixture-model")).toBeVisible();
  const afterRead = await page.request
    .get("/api/account-fixture/facts")
    .then((r) => r.json());
  expect(afterRead.probe_calls).toBe(before.probe_calls);
  await page
    .getByRole("button", { name: "自动选择并切换", exact: true })
    .click();
  await expect
    .poll(async () =>
      page.request
        .get("/api/account-fixture/facts")
        .then((r) => r.json())
        .then((r) => r.active),
    )
    .toBe("b");
  await page.reload();
  await expect(page.getByText(/管理状态：.*活动账号：Account B/)).toBeVisible();
  const row = page.getByRole("row").filter({ hasText: "Account C" });
  await row.getByRole("button", { name: "切换到此账号" }).click();
  await expect
    .poll(async () =>
      page.request
        .get("/api/account-fixture/facts")
        .then((r) => r.json())
        .then((r) => r.active),
    )
    .toBe("c");
  await page.getByRole("button", { name: "日间维护", exact: true }).click();
  await expect(
    page
      .getByRole("dialog", { name: "日间维护" })
      .getByRole("heading", { name: "刷新能力未验证", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("dialog", { name: "日间维护" })
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  await page.getByRole("button", { name: "停止管理", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "启动管理", exact: true }),
  ).toBeVisible();
  const facts = await page.request
    .get("/api/account-fixture/facts")
    .then((r) => r.json());
  expect(facts.counts).toEqual({ project: 0, workflow: 0, run: 0 });
  expect(unexpected).toEqual([]);
});
