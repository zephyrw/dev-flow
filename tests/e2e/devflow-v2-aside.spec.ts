import { test, expect } from "@playwright/test";
import { createNative, showInteraction } from "./native-helper.js";
test("真实只读提问不改变主任务，转正式反馈后重新规划", async ({ page }) => {
  test.setTimeout(90000);
  const id = await createNative(page, "提问测试：按原始需求规划文本修改");
  await showInteraction(page);
  await page.getByRole("radio", { name: /临时提问/ }).check();
  await page
    .locator(".guidance-form textarea")
    .fill("当前计划会修改哪些文件？");
  const before = await (await page.request.get("/api/workflows/" + id)).json();
  await page.getByRole("button", { name: /^提交提问/ }).click();
  await expect(page.getByLabel("任务反馈记录")).toContainText(
    "这次只读提问没有更改",
    { timeout: 30000 },
  );
  const after = await (await page.request.get("/api/workflows/" + id)).json();
  expect(after.workflow.version).toBe(before.workflow.version);
  await page.getByRole("button", { name: "转为正式反馈" }).click();
  await expect
    .poll(
      async () =>
        (await (await page.request.get("/api/workflows/" + id)).json()).workflow
          .plan_revision,
      { timeout: 30000 },
    )
    .toBe(2);
  const messages = await (
    await page.request.get("/api/workflows/" + id + "/messages")
  ).json();
  expect(JSON.stringify(messages)).toContain("当前计划会修改哪些文件");
});
