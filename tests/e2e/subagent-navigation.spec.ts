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

test("SA-E04 child and grandchild open isolated execution dialogs", async ({
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
  const mainLogs = page.locator("main .logs");
  await expect(mainLogs).toContainText("root-fixture-cmd");
  const dialog = page.getByRole("dialog");
  await workCardName(page, child.title || "explore").click();
  await expect(dialog).toHaveAccessibleName(`${child.title}的执行记录`);
  await expect(dialog.locator(".logs")).toContainText("child-fixture-cmd");
  await expect(dialog).not.toContainText("root-fixture-cmd");
  await expect(dialog).not.toContainText("grand-fixture-cmd");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(mainLogs).toContainText("root-fixture-cmd");
  await workCardName(page, grandchild.title || "review").click();
  await expect(dialog).toHaveAccessibleName(`${grandchild.title}的执行记录`);
  await expect(dialog.locator(".logs")).toContainText("grand-fixture-cmd");
  await expect(dialog).not.toContainText(/(^|[^a-z])child-fixture-cmd/);
  await expect(dialog).not.toContainText("root-fixture-cmd");
  await dialog.getByRole("button", { name: "关闭执行记录" }).click();
  await expect(mainLogs).toContainText("root-fixture-cmd");
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
  await page.goto(`/?workflow=${id}&conversation=${child.id}`);
  await openExecutionSidebar(page);
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
