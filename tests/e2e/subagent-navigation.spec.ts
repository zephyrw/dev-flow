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
test.use({ trace: "off" });

test("SA-E04 child then grandchild logs stay isolated and ancestors remain readable", async ({
  page,
}) => {
  test.setTimeout(120000);
  await setNativeFixture(page, {
    nested: true,
    grandchild: true,
    hold_ms: 20000,
  });
  const id = await createNative(
    page,
    "E04 子会话下钻隔离",
    "new_worktree",
    false,
  );
  await openExecutionSidebar(page);
  const tree = await waitForSubagents(page, id, 2);
  const child = tree.nodes.find(
    (node: { kind?: string; parent_id?: string; root_id?: string }) =>
      node.kind === "subagent" && node.parent_id === node.root_id,
  );
  const grandchild = tree.nodes.find(
    (node: { kind?: string; parent_id?: string }) =>
      node.kind === "subagent" && node.parent_id && node.parent_id !== child?.root_id,
  );
  expect(child?.id).toBeTruthy();
  expect(grandchild?.id).toBeTruthy();
  await expect(page.locator(".logs")).toContainText("root-fixture-cmd");
  await workCardName(page, child.title || "explore").click();
  await expect(page.locator(".execution-sidebar")).toHaveAttribute(
    "data-child-view",
    "true",
  );
  await expect(page.locator(".logs")).toContainText("child-fixture-cmd");
  await expect(page.locator(".logs")).not.toContainText("root-fixture-cmd");
  await expect(page.locator(".logs")).not.toContainText("grand-fixture-cmd");
  await workCardName(page, grandchild.title || "review").click();
  await expect(page.locator(".logs")).toContainText("grand-fixture-cmd");
  await expect(page.locator(".logs")).not.toContainText(
    /(^|[^a-z])child-fixture-cmd/,
  );
  await expect(page.locator(".logs")).not.toContainText("root-fixture-cmd");
  await page.locator(".conversation-breadcrumb-link").last().click();
  await expect(page.locator(".logs")).toContainText("child-fixture-cmd");
  await page.locator(".conversation-breadcrumb-link").last().click();
  await expect(page.locator(".execution-sidebar")).not.toHaveAttribute(
    "data-child-view",
    "true",
  );
  await expect(page.locator(".logs")).toContainText("root-fixture-cmd");
});

test("SA-E05 child view hides composer and restoring the root keeps draft state", async ({
  page,
}) => {
  test.setTimeout(90000);
  await setNativeFixture(page, {
    nested: true,
    grandchild: true,
    hold_ms: 20000,
  });
  const id = await createNative(
    page,
    "E05 子视图隐藏输入",
    "new_worktree",
    false,
  );
  await openExecutionSidebar(page);
  await waitForSubagents(page, id, 1);
  await composerInput(page).fill("返回后仍应看到这句");
  const logs = page.locator(".logs");
  await logs.evaluate((el) => {
    el.scrollTop = 12;
  });
  const child = (await (
    await page.request.get(`/api/workflows/${id}/conversations`)
  ).json()).nodes.find((node: { kind?: string }) => node.kind === "subagent");
  await workCardName(page, child.title).click();
  await expect(page.locator(".conversation-composer")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "发送", exact: true })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: "添加附件或引用", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator("[data-aside-popover]")).toHaveCount(0);
  await page.locator(".conversation-breadcrumb-link").first().click();
  await expect(composerInput(page)).toHaveValue("返回后仍应看到这句");
  await expect(page.locator(".conversation-composer")).toBeVisible();
});
