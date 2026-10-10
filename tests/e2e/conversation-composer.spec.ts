import { test, expect } from "@playwright/test";
import {
  composerInput,
  createNative,
  openExecutionSidebar,
  setNativeFixture,
  waitForSubagents,
  workCardName,
} from "./native-helper.js";

test.describe.configure({ mode: "serial" });

test("SA-E06 composer submits once, keeps draft on failure, and ignores Enter during IME", async ({
  page,
}) => {
  test.setTimeout(90000);
  await setNativeFixture(page, {});
  const id = await createNative(page, "E06 常驻输入发送", "existing_workspace");
  await openExecutionSidebar(page);
  await expect(page.getByRole("button", { name: "指导或提问", exact: true })).toHaveCount(
    0,
  );
  const input = composerInput(page);
  await input.fill("第一行");
  await input.press("Shift+Enter");
  await input.type("第二行");
  await expect(input).toHaveValue("第一行\n第二行");
  await input.evaluate((el) => {
    el.dispatchEvent(new CompositionEvent("compositionstart", { data: "测" }));
  });
  await input.press("Enter");
  await expect(input).toHaveValue("第一行\n第二行");
  await input.evaluate((el) => {
    el.dispatchEvent(new CompositionEvent("compositionend", { data: "测" }));
  });
  const posts: string[] = [];
  await page.route("**/conversation-messages", async (route) => {
    if (route.request().method() === "POST") {
      posts.push(route.request().postData() || "");
      await route.fulfill({
        status: 500,
        json: { error: { message: "发送失败夹具" } },
      });
      return;
    }
    await route.continue();
  });
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("发送失败");
  await expect(input).toHaveValue("第一行\n第二行");
  expect(posts).toHaveLength(1);
  await page.unroute("**/conversation-messages");
  const created = page.waitForResponse(
    (response) =>
      response.url().includes("/conversation-messages") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "发送", exact: true }).click();
  const response = await created;
  expect(response.ok()).toBe(true);
  await expect
    .poll(async () => {
      const detail = await (
        await page.request.get(`/api/workflows/${id}`)
      ).json();
      return JSON.stringify(detail.workflow.feedback ?? detail.messages ?? []);
    })
    .toContain("第一行");
});

test("SA-E07 child identity and activity stay scoped while the task model header remains unchanged", async ({
  page,
}) => {
  test.setTimeout(180000);
  await setNativeFixture(page, { nested: true, hold_ms: 15000 });
  const id = await createNative(
    page,
    "E07 模型与当前工作",
    "new_worktree",
    false,
  );
  await openExecutionSidebar(page);
  await expect(page.locator(".current-runtime")).toContainText(
    /fixture-only|未报告|Codex/,
    { timeout: 30000 },
  );
  const tree = await waitForSubagents(page, id, 1);
  const child = (tree.nodes ?? []).find(
    (node: { kind?: string }) => node.kind === "subagent",
  );
  expect(child).toBeTruthy();
  const parentModels = await page.locator(".current-runtime .runtime-row-text").allTextContents();
  await workCardName(page, child.title).click();
  await expect(page.locator(".execution-session-badge")).toHaveText(child.title);
  await expect(page.locator(".execution-sidebar")).toHaveAttribute("data-child-view", "true");
  await expect(page.locator(".current-runtime .runtime-row-text")).toHaveText(parentModels);
  await expect(page).toHaveURL(new RegExp(`conversation=${child.id}`));
  await expect(page.locator(".conversation-composer-status-bar")).toHaveCount(0);
  await page.locator(".conversation-breadcrumb-link").first().click();
  await expect(page.locator(".execution-session-badge")).toHaveText("worktree 会话");
  await expect(page.locator(".execution-sidebar")).not.toHaveAttribute("data-child-view", "true");
  await expect(composerInput(page)).toBeVisible();
  await expect(page.locator(".current-runtime .runtime-row-text")).toHaveText(parentModels);
});
