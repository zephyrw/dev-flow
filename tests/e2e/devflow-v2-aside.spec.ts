import { test, expect } from "@playwright/test";
import { composerInput, createNative, sendComposerText, showInteraction } from "./native-helper.js";
test("真实只读提问不改变主任务，转正式反馈后重新规划", async ({ page }) => {
  test.setTimeout(90000);
  const id = await createNative(page, "提问测试：按原始需求规划文本修改");
  await showInteraction(page);
  const before = await (await page.request.get("/api/workflows/" + id)).json();
  await sendComposerText(page, "/btw 当前计划会修改哪些文件？");
  await expect(page.locator("[data-aside-popover]")).toContainText(
    "这次只读提问没有更改",
    { timeout: 30000 },
  );
  const after = await (await page.request.get("/api/workflows/" + id)).json();
  expect(after.workflow.version).toBe(before.workflow.version);
  await page.getByRole("button", { name: /转为「.*」的正式反馈/ }).click();
  await expect(composerInput(page)).toHaveValue(/当前计划会修改哪些文件/);
  await page.getByRole("button", { name: "发送", exact: true }).click();
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
