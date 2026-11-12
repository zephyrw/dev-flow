import { test, expect } from "@playwright/test";
import {
  composerInput,
  createNative,
  openExecutionSidebar,
  sendComposerText,
  setNativeFixture,
  workCard,
} from "./native-helper.js";

test.describe.configure({ mode: "serial" });

test("SA-E14 /btw and /side create asides while plain text stays formal", async ({
  page,
}) => {
  test.setTimeout(120000);
  await setNativeFixture(page, {});
  const id = await createNative(page, "E14 临时提问命令", "new_worktree");
  await openExecutionSidebar(page);
  await expect(page.getByRole("radio", { name: /临时提问/ })).toHaveCount(0);
  await sendComposerText(page, "这是正式规划反馈，请补充验证步骤。");
  await expect(page.locator("[data-aside-popover]")).toHaveCount(0);
  await sendComposerText(page, "/btw 当前计划会改哪些文件？");
  await expect(page.locator("[data-aside-popover]")).toBeVisible({ timeout: 20000 });
  await expect(page.locator("[data-aside-popover]")).toContainText("当前计划会改哪些文件");
  await page.getByLabel("关闭提问浮窗").click();
  await sendComposerText(page, "/side 验证步骤写在哪？");
  await expect(page.locator("[data-aside-popover]")).toBeVisible({ timeout: 20000 });
  await expect(page.locator("[data-aside-popover]")).toContainText("验证步骤写在哪");
  const detail = await (await page.request.get(`/api/workflows/${id}`)).json();
  expect(JSON.stringify(detail.workflow.feedback ?? [])).toContain("正式规划反馈");
});

test("SA-E15 popover sits above composer without backdrop and Esc only hides it", async ({
  page,
}) => {
  test.setTimeout(90000);
  await setNativeFixture(page, {});
  await createNative(page, "E15 提问浮窗位置", "new_worktree");
  await openExecutionSidebar(page);
  await sendComposerText(page, "/btw 浮窗会挡住日志吗？");
  const popover = page.locator("[data-aside-popover]");
  await expect(popover).toBeVisible({ timeout: 20000 });
  await expect(page.locator(".modal-backdrop, .aside-history-backdrop")).toHaveCount(0);
  const popBox = await popover.boundingBox();
  const inputBox = await composerInput(page).boundingBox();
  expect(popBox).toBeTruthy();
  expect(inputBox).toBeTruthy();
  expect(popBox!.y + popBox!.height).toBeLessThanOrEqual(inputBox!.y + 8);
  await page.locator(".logs").click({ position: { x: 12, y: 12 } });
  await expect(composerInput(page)).toBeVisible();
  await composerInput(page).click();
  await page.keyboard.press("Escape");
  await expect(popover).toHaveCount(0);
  await page.locator(".aside-popover-entry").click();
  await expect(page.locator("[data-aside-popover]")).toBeVisible();
});

test("SA-E16 workflow asides are isolated per task and default to latest", async ({
  page,
}) => {
  test.setTimeout(180000);
  await setNativeFixture(page, {});
  const first = await createNative(page, "E16 任务提问甲", "new_worktree");
  await openExecutionSidebar(page);
  for (const text of ["甲1", "甲2", "甲3", "甲4"]) {
    await sendComposerText(page, `/btw ${text}`);
    await expect(page.locator("[data-aside-popover]")).toContainText(text, {
      timeout: 20000,
    });
    await page.getByLabel("关闭提问浮窗").click();
  }
  const second = await createNative(page, "E16 任务提问乙", "new_worktree");
  await openExecutionSidebar(page);
  await expect(page.locator(".aside-popover-entry")).toHaveCount(0);
  await setNativeFixture(page, { hold_ms: 8000 });
  await sendComposerText(page, "/btw 乙取消");
  await expect(page.getByRole("button", { name: "取消本次提问" })).toBeVisible({
    timeout: 15000,
  });
  await page.getByRole("button", { name: "取消本次提问" }).click();
  await setNativeFixture(page, { service_exit: true });
  await sendComposerText(page, "/btw 乙失败");
  await expect(page.locator("[data-aside-popover]")).toContainText(/未完成|失败|乙失败/, {
    timeout: 20000,
  });
  await setNativeFixture(page, {});
  await sendComposerText(page, "/btw 乙完成");
  await expect(page.locator("[data-aside-popover]")).toContainText("乙完成");
  const count = page.locator(".aside-popover-count");
  await expect(count).toHaveText("1/3");
  await expect(page.getByLabel("较旧一条")).toBeEnabled();
  await page.getByLabel("较旧一条").click();
  await expect(count).toHaveText("2/3");
  await page.getByLabel("较旧一条").click();
  await expect(count).toHaveText("3/3");
  await expect(page.getByLabel("较旧一条")).toBeDisabled();
  await expect(page.locator("[data-aside-popover]")).not.toContainText("甲4");

  await page.goto(`/?workflow=${first}`);
  await openExecutionSidebar(page);
  await expect(page.locator(".aside-popover-entry")).toHaveText("临时提问 4");
  await page.locator(".aside-popover-entry").click();
  await expect(page.locator(".aside-popover-count")).toHaveText("1/4");
  await expect(page.locator("[data-aside-popover]")).toContainText("甲4");
  await expect(page.locator("[data-aside-popover]")).not.toContainText("乙完成");

  const third = await createNative(page, "E16 空白任务丙", "new_worktree");
  await openExecutionSidebar(page);
  await expect(page.locator(".aside-popover-entry")).toHaveCount(0);
  await expect(page.locator("[data-aside-popover]")).toHaveCount(0);
  expect(second).toBeTruthy();
  expect(third).toBeTruthy();
});

test("SA-E17 new answers do not steal selection; other projects stay isolated", async ({
  page,
}) => {
  test.setTimeout(120000);
  await setNativeFixture(page, {});
  await createNative(page, "E17 看旧问题", "new_worktree");
  await openExecutionSidebar(page);
  await sendComposerText(page, "/btw 旧问题A");
  await expect(page.locator("[data-aside-popover]")).toContainText("旧问题A", {
    timeout: 20000,
  });
  await sendComposerText(page, "/btw 新问题B");
  await expect(page.locator("[data-aside-popover]")).toContainText("新问题B", {
    timeout: 20000,
  });
  await page.getByLabel("较旧一条").click();
  await expect(page.locator("[data-aside-popover]")).toContainText("旧问题A");
  await sendComposerText(page, "/btw 更新的C");
  await expect(page.getByRole("button", { name: "有新问题" })).toBeVisible({
    timeout: 20000,
  });
  await expect(page.locator("[data-aside-popover]")).toContainText("旧问题A");
  await page.reload();
  await openExecutionSidebar(page);
  await page.locator(".aside-popover-entry").click();
  await expect(page.locator("[data-aside-popover]")).toBeVisible();
});

test("SA-E18 cancelling an aside does not stop the main tree", async ({
  page,
}) => {
  test.setTimeout(120000);
  await setNativeFixture(page, { nested: true, hold_ms: 20000 });
  const id = await createNative(
    page,
    "E18 取消提问不影响主执行",
    "new_worktree",
    false,
  );
  await openExecutionSidebar(page);
  const before = await (await page.request.get(`/api/workflows/${id}`)).json();
  await sendComposerText(page, "/btw 只问一句马上取消");
  await expect(page.getByRole("button", { name: "取消本次提问" })).toBeVisible({
    timeout: 15000,
  });
  await page.getByRole("button", { name: "取消本次提问" }).click();
  const after = await (await page.request.get(`/api/workflows/${id}`)).json();
  expect(after.workflow.state).toBe(before.workflow.state);
  expect(after.workflow.version).toBe(before.workflow.version);
  await expect(workCard(page)).toContainText(
    /子 Agent \d+/,
  );
});

test("SA-E19 promote retry after response loss and reload remains one formal feedback", async ({
  page,
}) => {
  test.setTimeout(120000);
  await setNativeFixture(page, {});
  const id = await createNative(page, "E19 转正式反馈", "new_worktree");
  await openExecutionSidebar(page);
  await sendComposerText(page, "/btw 为什么只改 app.txt？");
  await expect(page.locator("[data-aside-popover]")).toContainText("已回答", {
    timeout: 20000,
  });
  const promote = page.getByRole("button", { name: /转为「.*」的正式反馈/ });
  await expect(promote).toBeVisible();
  await promote.click();
  await expect(composerInput(page)).toHaveValue(/为什么只改 app\.txt/);
  const posts: Array<{ url: string; body: string }> = [];
  await page.route("**/asides/*/promote", async route => {
    posts.push({ url: route.request().url(), body: route.request().postData() || "" });
    const response = await route.fetch();
    expect(response.ok(), await response.text()).toBe(true);
    if (posts.length === 1) await route.abort("failed");
    else await route.fulfill({ response });
  });
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.locator(".conversation-failed-submission-banner")).toContainText("发送结果待确认");
  await expect(composerInput(page)).toHaveValue("");
  await page.reload();
  await openExecutionSidebar(page);
  await page.getByRole("button", { name: "重试原提交", exact: true }).click();
  await expect(page.locator(".conversation-failed-submission-banner")).toHaveCount(0);
  expect(posts).toHaveLength(2);
  expect(posts[1]).toEqual(posts[0]);
  const detail = await (await page.request.get(`/api/workflows/${id}`)).json();
  expect(detail.workflow.id).toBe(id);
  expect(JSON.stringify(detail)).toMatch(/为什么只改 app\.txt|正式反馈/);
  const feedback = await (await page.request.get(`/api/workflows/${id}/messages`)).json();
  expect(feedback.messages.filter((message: { client_request_id?: string }) =>
    message.client_request_id?.startsWith("promoted_"))).toHaveLength(1);
});
