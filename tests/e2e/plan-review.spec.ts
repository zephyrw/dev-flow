import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createNative } from "./native-helper.js";

test("计划问答保持审批状态，驳回在原规划会话修正后重新等待批准", async ({
  page,
}) => {
  test.setTimeout(120000);
  const id = await createNative(page, "计划审阅入口：将文本改为 after");
  const get = async () =>
    (await page.request.get(`/api/workflows/${id}`)).json();
  const before = await get();
  const actions = page.locator(".compact-summary-actions .actions");
  await expect(
    actions.getByRole("button", { name: "批准当前计划", exact: true }),
  ).toBeVisible();
  await expect(
    actions.getByRole("button", { name: "驳回并修正", exact: true }),
  ).toBeVisible();
  await actions.getByRole("button", { name: "计划问答", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: /计划问答/ });
  await expect(
    dialog.getByRole("button", { name: "发送问题", exact: true }),
  ).toBeDisabled();
  await dialog.getByLabel("向规划模型提问").fill("计划用什么方式验证换行？");
  await dialog.getByRole("button", { name: "发送问题", exact: true }).click();
  await expect(dialog.getByLabel("计划问答记录")).toContainText("完整正文", {
    timeout: 45000,
  });
  await expect(dialog.getByLabel("计划问答记录")).toContainText(
    "使用真实 Node 子进程验证输出",
  );
  const afterQuestion = await get();
  expect(afterQuestion.workflow).toEqual(before.workflow);
  expect(afterQuestion.runs.map((r: any) => r.stage)).toEqual([
    "planning",
    "aside",
  ]);
  expect(afterQuestion.runs[1].profile).toEqual(before.runs[0].profile);
  expect(
    (await (await page.request.get(`/api/workflows/${id}/messages`)).json())
      .messages,
  ).toHaveLength(0);
  expect(readFileSync(join(before.workspaces[0].root, "app.txt"), "utf8")).toBe(
    "before\n",
  );
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await actions.getByRole("button", { name: "计划问答", exact: true }).click();
  dialog = page.getByRole("dialog", { name: /计划问答/ });
  await expect(dialog.getByLabel("计划问答记录")).toContainText(
    "计划用什么方式验证换行",
  );
  await dialog
    .getByLabel("向规划模型提问")
    .fill("刚才的验证会改动其他文件吗？");
  await dialog.getByRole("button", { name: "发送问题", exact: true }).click();
  await expect(dialog.getByLabel("计划问答记录")).toContainText("已有问答：1", {
    timeout: 45000,
  });
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();

  await actions
    .getByRole("button", { name: "驳回并修正", exact: true })
    .click();
  dialog = page.getByRole("dialog", { name: /驳回并修正/ });
  await expect(
    dialog.getByRole("button", { name: "提交修改意见", exact: true }),
  ).toBeDisabled();
  await dialog
    .getByLabel("修改意见（必填）")
    .fill("请补充回滚步骤，并验证其他文件保持不变。");
  await dialog
    .getByRole("button", { name: "提交修改意见", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect
    .poll(async () => (await get()).workflow.state, { timeout: 45000 })
    .toBe("REPAIR_PLAN_PENDING");
  const revised = await get();
  expect(revised.workflow.plan_revision).toBe(2);
  expect(revised.runs.map((r: any) => r.stage)).toEqual([
    "planning",
    "aside",
    "aside",
    "planning",
  ]);
  expect(revised.runs[3].conversation_id).toBe(before.runs[0].conversation_id);
  expect(revised.runs[3].profile).toEqual(before.runs[0].profile);
  const messages = (
    await (await page.request.get(`/api/workflows/${id}/messages`)).json()
  ).messages;
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({
    kind: "planning",
    target_document_revision: 1,
    status: "acknowledged",
  });
  expect(readFileSync(join(before.workspaces[0].root, "app.txt"), "utf8")).toBe(
    "before\n",
  );
  await expect(
    actions.getByRole("button", { name: "批准当前计划", exact: true }),
  ).toBeVisible();
  await actions.getByRole("button", { name: "计划问答", exact: true }).click();
  dialog = page.getByRole("dialog", { name: /计划问答 · 第 2 版/ });
  await dialog.getByLabel("向规划模型提问").fill("第二版修改了什么？");
  await dialog.getByRole("button", { name: "发送问题", exact: true }).click();
  await expect(dialog.getByLabel("计划问答记录")).toContainText(
    "请补充回滚步骤",
    { timeout: 45000 },
  );
  await expect(dialog.getByLabel("计划问答记录")).not.toContainText(
    "计划用什么方式验证换行",
  );
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await page.screenshot({
    path: ".cache/plan-review-actions.png",
    fullPage: true,
  });
});

test("驳回遇到计划更新时保留意见并显示错误，取消不更改任务", async ({
  page,
}) => {
  test.setTimeout(90000);
  const id = await createNative(page, "计划审阅并发检查");
  const get = async () =>
    (await page.request.get(`/api/workflows/${id}`)).json();
  await page.getByRole("button", { name: "驳回并修正", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: /驳回并修正/ });
  await dialog.getByLabel("修改意见（必填）").fill("不要丢失我的修改意见");
  const before = await get();
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  expect((await get()).workflow).toEqual(before.workflow);
  await page.getByRole("button", { name: "驳回并修正", exact: true }).click();
  dialog = page.getByRole("dialog", { name: /驳回并修正/ });
  await dialog.getByLabel("修改意见（必填）").fill("不要丢失我的修改意见");
  const w = before.workflow;
  const result = await page.request.post(`/api/workflows/${id}/plan/reject`, {
    headers: { Origin: "http://localhost:14811" },
    data: {
      request_id: "other-client",
      expected_version: w.version,
      plan_revision: w.plan_revision,
      plan_hash: w.plan_hash,
      text: "另一窗口先提交的修改意见",
    },
  });
  expect(result.status()).toBe(200);
  await expect
    .poll(async () => (await get()).workflow.plan_revision, { timeout: 45000 })
    .toBe(2);
  await dialog
    .getByRole("button", { name: "提交修改意见", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText("计划已更新");
  await expect(dialog.getByLabel("修改意见（必填）")).toHaveValue(
    "不要丢失我的修改意见",
  );
  expect((await get()).workflow.state).toBe("REPAIR_PLAN_PENDING");
});
