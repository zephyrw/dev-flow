import { test, expect } from "@playwright/test";
import { fixtureState } from "./native-helper.js";

const longPlan = Array.from({ length: 60 }, (_, index) =>
  `## 章节 ${index + 1}\n\n` +
  Array.from({ length: 4 }, () =>
    "阅读位置回归正文。窄窗口中正文与目录应分别滚动，全屏切换后保持当前章节的位置。",
  ).join("\n\n"),
).join("\n\n");

for (const width of [400, 900]) {
  test(`${width}px 展开执行侧栏时，计划独立滚动并恢复全屏阅读位置`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    const workflowId = fixtureState().workflow_id;
    await page.addInitScript((id) => {
      localStorage.setItem("devflow.first_run_completed", "1");
      localStorage.setItem("devflow.sidebar", JSON.stringify({ [id]: true }));
      sessionStorage.setItem("devflow.tab." + id, "plan");
    }, workflowId);
    // Keep the existing fixture response; only vary document length for layout.
    await page.route((url) => url.pathname === `/api/workflows/${workflowId}`, async (route) => {
      const response = await route.fetch();
      const detail = await response.json();
      if (detail.plan?.plan) detail.plan.plan.markdown = longPlan;
      await route.fulfill({ response, json: detail });
    });
    await page.goto(`/?workflow=${workflowId}`);

    const mainColumn = page.locator(".workflow-main-column");
    const sidebar = page.locator(".execution-sidebar");
    await expect(sidebar).toBeAttached();
    const content = page.locator(".plan-panel .plan-content-area");
    const toc = page.locator(".plan-panel .toc-items-container");
    const heading = content.getByRole("heading", { name: "章节 4", exact: true });
    await expect(heading).toBeAttached();
    for (const scroller of [content, toc]) {
      await expect.poll(() => scroller.evaluate((element) =>
        element.clientHeight > 0 && element.scrollHeight > element.clientHeight,
      )).toBe(true);
    }
    const columnBox = await mainColumn.boundingBox();
    const sidebarBox = await sidebar.boundingBox();
    expect(columnBox).not.toBeNull();
    expect(sidebarBox).not.toBeNull();
    expect(columnBox!.width).toBeGreaterThan(0);
    expect(sidebarBox!.y).toBeGreaterThanOrEqual(columnBox!.y + columnBox!.height);

    await heading.evaluate((element) => {
      const scroller = element.closest(".plan-content-area") as HTMLElement;
      scroller.scrollTop += element.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top + 60;
    });
    await toc.evaluate((element) => { element.scrollTop = 150; });
    const headingOffset = () => heading.evaluate((element) =>
      element.getBoundingClientRect().top -
      element.closest(".plan-content-area")!.getBoundingClientRect().top,
    );
    await expect.poll(headingOffset).toBeCloseTo(-60, 0);
    await expect.poll(() => toc.evaluate((element) => element.scrollTop)).toBe(150);

    const trigger = page.getByRole("button", { name: "全屏查看", exact: true });
    await trigger.click();
    const reading = page.getByRole("dialog", { name: "开发计划全屏阅读", exact: true });
    await expect(reading).toBeVisible();
    await expect.poll(() => reading.getByRole("heading", { name: "章节 4", exact: true })
      .evaluate((element) => element.getBoundingClientRect().top -
        element.closest(".plan-content-area")!.getBoundingClientRect().top,
      )).toBeCloseTo(-60, 0);
    await expect.poll(() => reading.locator(".toc-items-container")
      .evaluate((element) => element.scrollTop)).toBe(150);
    if (width === 400) {
      await reading.getByRole("button", { name: "退出全屏", exact: true }).click();
    } else {
      await page.keyboard.press("Escape");
    }
    await expect(reading).not.toBeVisible();
    await expect.poll(headingOffset).toBeCloseTo(-60, 0);
    await expect.poll(() => toc.evaluate((element) => element.scrollTop)).toBe(150);
    await expect(trigger).toBeFocused();
  });
}
