import { test, expect } from "@playwright/test";
import {
  composerInput,
  createNative,
  openExecutionSidebar,
  setNativeFixture,
  waitForSubagents,
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
    // Some IMEs report the confirmation Enter after compositionend as keyCode 229.
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 229, bubbles: true }));
  });
  const posts: string[] = [];
  await page.route("**/conversation-messages", async (route) => {
    if (route.request().method() === "POST") {
      posts.push(route.request().postData() || "");
      await route.fulfill({
        status: 422,
        json: { error: { message: "发送失败夹具" } },
      });
      return;
    }
    await route.continue();
  });
  // The next deliberate Enter must send immediately, without a second Enter.
  await input.press("Enter");
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

test("submission recovery preserves the new draft and restores the editable attachment queue", async ({ page }) => {
  test.setTimeout(120000);
  await setNativeFixture(page, {});
  await createNative(page, "指导失败后的草稿与附件恢复", "existing_workspace");
  await openExecutionSidebar(page);
  const input = composerInput(page);
  const uploads = page.locator(".conversation-attachment-bar input[type=file]");
  await uploads.setInputFiles({ name: "recover-a.txt", mimeType: "text/plain", buffer: Buffer.from("attachment A") });
  await expect(page.locator(".conversation-attachment-chip").filter({ hasText: "recover-a.txt" })).toContainText("已就绪");
  const bodies: Array<{ attachment_ids: string[] }> = [];
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/conversation-messages", async route => {
    bodies.push(route.request().postDataJSON());
    if (bodies.length === 1) await held;
    await route.fulfill({ status: 422, json: { error: { message: "拒绝发送夹具" } } });
  });
  await input.fill("原提交 A");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  try {
    await expect(input).toHaveValue("");
    await expect(page.locator(".conversation-attachment-chip")).toHaveCount(0);
    await input.fill("发送期间的新草稿 B");
  } finally {
    release();
  }
  const recoveryA = page.locator(".conversation-failed-submission-banner").filter({ hasText: "原提交 A" });
  await expect(recoveryA).toContainText("发送失败");
  await expect(input).toHaveValue("发送期间的新草稿 B");
  await uploads.setInputFiles({ name: "draft-b.txt", mimeType: "text/plain", buffer: Buffer.from("new draft B") });
  await expect(page.locator(".conversation-attachment-chip").filter({ hasText: "draft-b.txt" })).toContainText("已就绪");
  let releaseMetadata!: () => void;
  const metadataHeld = new Promise<void>(resolve => { releaseMetadata = resolve; });
  let metadataStarted!: () => void;
  const metadataRequested = new Promise<void>(resolve => { metadataStarted = resolve; });
  await page.route("**/conversation-files/*", async route => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    metadataStarted();
    await metadataHeld;
    await route.fulfill({ response });
  });
  try {
    await page.reload();
    await openExecutionSidebar(page);
    await metadataRequested;
    await recoveryA.getByRole("button", { name: "恢复原内容", exact: true }).click();
    await expect(page.locator(".conversation-failed-submission-banner").filter({ hasText: "发送期间的新草稿 B" }))
      .toContainText("draft-b.txt");
  } finally {
    releaseMetadata();
    await page.unroute("**/conversation-files/*");
  }
  await expect(input).toHaveValue("原提交 A");
  await expect(page.locator(".conversation-failed-submission-banner").filter({ hasText: "发送期间的新草稿 B" })).toContainText("已暂存草稿");
  await expect(page.locator(".conversation-attachment-chip").filter({ hasText: "recover-a.txt" })).toContainText("已就绪");
  await uploads.setInputFiles({ name: "recover-b.txt", mimeType: "text/plain", buffer: Buffer.from("attachment B") });
  await expect(page.locator(".conversation-attachment-chip").filter({ hasText: "recover-b.txt" })).toContainText("已就绪");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect.poll(() => bodies.length).toBe(2);
  expect(bodies[1]!.attachment_ids).toHaveLength(2);
  expect(bodies[1]!.attachment_ids).toContain(bodies[0]!.attachment_ids[0]);
  await expect(page.locator(".conversation-attachment-chip")).toHaveCount(2);
  await page.reload();
  await openExecutionSidebar(page);
  await expect(page.locator(".conversation-failed-submission-banner").filter({ hasText: "发送期间的新草稿 B" })).toContainText("已暂存草稿");
  await expect(page.locator(".conversation-attachment-chip")).toHaveCount(2);
});

test("a lost response survives reload and retries the original request without duplicating the aside", async ({ page }) => {
  test.setTimeout(120000);
  await setNativeFixture(page, {});
  const workflowId = await createNative(page, "指导回执丢失恢复", "existing_workspace");
  await openExecutionSidebar(page);
  const bodies: unknown[] = [];
  let accepted!: () => void;
  const serverAccepted = new Promise<void>(resolve => { accepted = resolve; });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/conversation-messages", async route => {
    bodies.push(route.request().postDataJSON());
    const response = await route.fetch();
    expect(response.ok(), await response.text()).toBe(true);
    if (bodies.length === 1) {
      accepted();
      await held;
      await route.abort("failed");
    } else {
      await route.fulfill({ response });
    }
  });
  const question = "回执丢失时只能有一条临时提问";
  await composerInput(page).fill(`/btw ${question}`);
  await page.getByRole("button", { name: "发送", exact: true }).click();
  try {
    await serverAccepted;
    await expect(composerInput(page)).toHaveValue("");
    await composerInput(page).fill("保留刷新前新草稿");
  } finally {
    release();
  }
  await expect(page.locator(".conversation-failed-submission-banner")).toContainText("发送结果待确认");
  await page.reload();
  await openExecutionSidebar(page);
  await expect(composerInput(page)).toHaveValue("保留刷新前新草稿");
  await page.getByRole("button", { name: "重试原提交", exact: true }).click();
  await expect(page.locator(".conversation-failed-submission-banner")).toHaveCount(0);
  await expect(composerInput(page)).toHaveValue("保留刷新前新草稿");
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toEqual(bodies[0]);
  const response = await page.request.get(`/api/workflows/${workflowId}/asides`);
  expect(response.ok()).toBe(true);
  const asides = await response.json() as Array<{ question: string }>;
  expect(asides.filter(aside => aside.question === question)).toHaveLength(1);
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
  await page.goto(`/?workflow=${id}&conversation=${child.id}`);
  await openExecutionSidebar(page);
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
