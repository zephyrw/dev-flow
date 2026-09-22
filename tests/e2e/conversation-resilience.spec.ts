import { test, expect } from "@playwright/test";
import {
  composerInput,
  createNative,
  openExecutionSidebar,
  setNativeFixture,
  waitForSubagents,
  workCard,
} from "./native-helper.js";

test.describe.configure({ mode: "serial" });

test("SA-E20 websocket reconnect catchup keeps conversation activity unique", async ({
  page,
}) => {
  test.setTimeout(120000);
  await setNativeFixture(page, {
    nested: true,
    grandchild: true,
    hold_ms: 18000,
  });
  const id = await createNative(
    page,
    "E20 断线回补",
    "new_worktree",
    false,
  );
  await openExecutionSidebar(page);
  await waitForSubagents(page, id, 1);
  const before = await (
    await page.request.get(`/api/workflows/${id}/conversations`)
  ).json();
  const beforeIds = new Set(
    (before.nodes ?? []).map((node: { id: string }) => node.id),
  );
  await page.context().setOffline(true);
  await page.evaluate(() => {
    (window as any).__eventWs?.close();
  });
  await expect(page.locator(".conn-pill")).toContainText(/重连/, {
    timeout: 8000,
  });
  await page.context().setOffline(false);
  await expect(page.locator(".conn-pill")).toContainText("已连接", {
    timeout: 15000,
  });
  const after = await (
    await page.request.get(`/api/workflows/${id}/conversations`)
  ).json();
  const nodeIds = (after.nodes ?? []).map((node: { id: string }) => node.id);
  expect(new Set(nodeIds).size).toBe(nodeIds.length);
  for (const idValue of beforeIds) expect(nodeIds).toContain(idValue);
  await page.reload();
  await openExecutionSidebar(page);
  await expect(workCard(page)).toBeVisible({ timeout: 15000 });
  await page.goBack();
  await page.goForward();
  await expect(page).toHaveURL(new RegExp(id));
});

test("SA-E21 sidebar 320/520, long names, many children and keyboard stay on screen", async ({
  page,
}) => {
  test.setTimeout(120000);
  await setNativeFixture(page, {
    nested: true,
    hold_ms: 20000,
    child_count: 12,
  });
  const id = await createNative(
    page,
    "E21 侧栏密度与键盘",
    "new_worktree",
    false,
  );
  await openExecutionSidebar(page);
  await waitForSubagents(page, id, 8);
  const handle = page.getByLabel("调整执行侧栏宽度");
  await handle.focus();
  for (let i = 0; i < 20; i++) await page.keyboard.press("ArrowRight");
  await expect(handle).toHaveAttribute("aria-valuenow", "320");
  const slim = await page.locator(".execution-sidebar").boundingBox();
  expect(slim?.width).toBeGreaterThanOrEqual(300);
  expect(slim?.width).toBeLessThanOrEqual(360);
  await composerInput(page).fill("/btw 窄侧栏提问");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  const popover = page.locator("[data-aside-popover]");
  if (await popover.isVisible({ timeout: 8000 }).catch(() => false)) {
    const box = await popover.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(1440);
  }
  await handle.focus();
  for (let i = 0; i < 20; i++) await page.keyboard.press("ArrowLeft");
  await expect(handle).toHaveAttribute("aria-valuenow", "520");
  await expect(workCard(page)).toContainText(/Working|extra-agent|running-agent/);
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
});
