import { test, expect } from "@playwright/test";
import { fixtureState } from "./native-helper.js";

const shortContentLongLineDiff = {
  path: "src/short-long.ts",
  repo_id: "main",
  branch: "main",
  baseline: "12345678",
  diff: `--- a/src/short-long.ts
+++ b/src/short-long.ts
@@ -1,3 +1,3 @@
 const greeting = "hello";
-const oldMsg = "short";
+const newMsg = "${"X".repeat(300)}";
 const done = true;
`,
};

const longContentLongLineDiff = {
  path: "src/long-long.ts",
  repo_id: "main",
  branch: "main",
  baseline: "12345678",
  diff: `--- a/src/long-long.ts
+++ b/src/long-long.ts
@@ -1,80 +1,80 @@
` + Array.from({ length: 80 }, (_, i) => `+const line_${i} = "row_${i}_${"Y".repeat(250)}";`).join("\n") + "\n",
};

const shortLinesDiff = {
  path: "src/short-normal.ts",
  repo_id: "main",
  branch: "main",
  baseline: "12345678",
  diff: `--- a/src/short-normal.ts
+++ b/src/short-normal.ts
@@ -1,3 +1,3 @@
-const val = 1;
+const val = 2;
`,
};

const truncatedDiff = {
  path: "src/huge-file.ts",
  repo_id: "main",
  branch: "main",
  baseline: "12345678",
  truncated: true,
  diff: `--- a/src/huge-file.ts
+++ b/src/huge-file.ts
@@ -1,5 +1,5 @@
+const large = 1;
`,
};

const emptyDiff = {
  path: "src/empty.ts",
  repo_id: "main",
  branch: "main",
  baseline: "12345678",
  diff: "",
};

const mockDiffResponse = [
  {
    repo_id: "main",
    branch: "main",
    baseline: "12345678",
    files: [
      { path: "src/short-long.ts", status: "M" },
      { path: "src/long-long.ts", status: "A" },
      { path: "src/short-normal.ts", status: "M" },
      { path: "src/huge-file.ts", status: "M" },
      { path: "src/empty.ts", status: "M" },
    ],
  },
];

function setupDiffRoutes(page: any, workflowId: string) {
  return page.route(`**/api/workflows/${workflowId}/diff*`, async (route: any) => {
    const url = new URL(route.request().url());
    const path = url.searchParams.get("path");
    if (!path) {
      return route.fulfill({ json: mockDiffResponse });
    }
    if (path === "src/short-long.ts") {
      return route.fulfill({ json: shortContentLongLineDiff });
    }
    if (path === "src/long-long.ts") {
      return route.fulfill({ json: longContentLongLineDiff });
    }
    if (path === "src/short-normal.ts") {
      return route.fulfill({ json: shortLinesDiff });
    }
    if (path === "src/huge-file.ts") {
      return route.fulfill({ json: truncatedDiff });
    }
    if (path === "src/empty.ts") {
      return route.fulfill({ json: emptyDiff });
    }
    return route.fulfill({ json: shortContentLongLineDiff });
  });
}

test.describe("代码变更面板布局与交互验证", () => {
  test.beforeEach(async ({ page }) => {
    const workflowId = fixtureState().workflow_id;
    await page.addInitScript((id: string) => {
      localStorage.setItem("devflow.first_run_completed", "1");
      sessionStorage.setItem("devflow.tab." + id, "diff");
    }, workflowId);
    await setupDiffRoutes(page, workflowId);
  });

  test("I1: 真实检视组件与 CSS 的浏览器布局集成", async ({ page }) => {
    const workflowId = fixtureState().workflow_id;
    await page.goto(`/?workflow=${workflowId}`);

    const diffScroll = page.locator(".diff-code-scroll");
    const tableContainer = page.locator(".diff-table-container");
    const statusBar = page.locator(".diff-inspector-foot");
    const headerBar = page.locator(".diff-inspector-head");

    await expect(diffScroll).toBeVisible();
    await expect(tableContainer).toBeVisible();
    await expect(page.locator(".diff-loading-state")).not.toBeVisible();
    await expect(page.locator(".diff-content-col", { hasText: "newMsg" })).toBeVisible();

    // 1. 内层不能成为独立水平滚动区
    const innerMetrics = await tableContainer.evaluate((el) => {
      const style = window.getComputedStyle(el);
      return {
        overflowX: style.overflowX,
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
      };
    });
    expect(innerMetrics.overflowX).not.toBe("auto");
    expect(innerMetrics.scrollWidth).toBe(innerMetrics.clientWidth);

    // 2. 外层承担水平溢出与滚动
    const outerMetrics = await diffScroll.evaluate((el) => {
      return {
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
      };
    });
    expect(outerMetrics.scrollWidth).toBeGreaterThan(outerMetrics.clientWidth);

    // 3. 滚动区底边紧邻状态栏上边，无多余空白
    const diffScrollBox = await diffScroll.boundingBox();
    const statusBarBox = await statusBar.boundingBox();
    expect(diffScrollBox).not.toBeNull();
    expect(statusBarBox).not.toBeNull();
    expect(Math.abs(diffScrollBox!.y + diffScrollBox!.height - statusBarBox!.y)).toBeLessThanOrEqual(2);

    // 4. 滚动后代码位置实际变化，标题和状态栏不移动
    const initialHeadBox = await headerBar.boundingBox();
    const initialFootBox = await statusBar.boundingBox();
    const firstLine = page.locator(".diff-line-row").first();
    const initialLineBox = await firstLine.boundingBox();

    await diffScroll.evaluate((el) => {
      el.scrollLeft = 120;
    });
    await expect.poll(async () => diffScroll.evaluate((el) => el.scrollLeft)).toBe(120);

    const scrolledHeadBox = await headerBar.boundingBox();
    const scrolledFootBox = await statusBar.boundingBox();
    const scrolledLineBox = await firstLine.boundingBox();

    expect(scrolledHeadBox!.y).toBeCloseTo(initialHeadBox!.y, 0);
    expect(scrolledFootBox!.y).toBeCloseTo(initialFootBox!.y, 0);
    expect(scrolledLineBox!.x).toBeLessThan(initialLineBox!.x);
  });

  test("E1: 真实短差异长行文件查看与刷新后保持正确", async ({ page }) => {
    const workflowId = fixtureState().workflow_id;
    await page.goto(`/?workflow=${workflowId}`);

    const diffScroll = page.locator(".diff-code-scroll");
    await expect(diffScroll).toBeVisible();

    // 确认选中的是 short-long.ts 并等待目标内容渲染完成，避免读取加载状态
    await expect(page.locator(".diff-full-path")).toContainText("src/short-long.ts");
    await expect(page.locator(".diff-loading-state")).not.toBeVisible();
    await expect(page.locator(".diff-content-col", { hasText: "newMsg" })).toBeVisible();

    // 验证横向滚动条在代码可视区底部（外层承担横向滚动），配合重试断言
    await expect.poll(async () => {
      return diffScroll.evaluate((el) => el.scrollWidth > el.clientWidth);
    }).toBe(true);

    const scrollMetrics = await diffScroll.evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      scrollLeft: el.scrollLeft,
    }));
    expect(scrollMetrics.scrollWidth).toBeGreaterThan(scrollMetrics.clientWidth);

    // 左右滚动可达内容两端
    await diffScroll.evaluate((el) => {
      el.scrollLeft = el.scrollWidth;
    });
    await expect.poll(async () => diffScroll.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);

    await diffScroll.evaluate((el) => {
      el.scrollLeft = 0;
    });
    await expect.poll(async () => diffScroll.evaluate((el) => el.scrollLeft)).toBe(0);

    // 刷新后仍保持正确：等待重新渲染目标内容后再测量尺寸
    await page.reload();
    await expect(diffScroll).toBeVisible();
    await expect(page.locator(".diff-full-path")).toContainText("src/short-long.ts");
    await expect(page.locator(".diff-loading-state")).not.toBeVisible();
    await expect(page.locator(".diff-content-col", { hasText: "newMsg" })).toBeVisible();

    await expect.poll(async () => {
      return diffScroll.evaluate((el) => el.scrollWidth > el.clientWidth);
    }).toBe(true);

    const reloadedMetrics = await diffScroll.evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }));
    expect(reloadedMetrics.scrollWidth).toBeGreaterThan(reloadedMetrics.clientWidth);
  });

  test("E2: 长差异双向滚动、切换文件和窗口缩放", async ({ page }) => {
    const workflowId = fixtureState().workflow_id;
    await page.goto(`/?workflow=${workflowId}`);

    // 点击切换到长差异文件 long-long.ts
    await page.locator(".diff-file-card", { hasText: "long-long.ts" }).click();
    await expect(page.locator(".diff-full-path")).toContainText("src/long-long.ts");

    // 等待 long-long.ts 内容渲染完成，避免读取加载状态或旧文件内容
    await expect(page.locator(".diff-loading-state")).not.toBeVisible();
    await expect(page.locator(".diff-content-col", { hasText: "row_0_" })).toBeVisible();
    await expect(page.locator(".diff-content-col", { hasText: "row_79_" })).toBeAttached();

    const diffScroll = page.locator(".diff-code-scroll");
    const statusBar = page.locator(".diff-inspector-foot");
    const sidebar = page.locator(".diff-sidebar");

    // 验证纵向和横向均溢出（双向滚动），使用重试断言
    await expect.poll(async () => {
      return diffScroll.evaluate((el) => ({
        hasVerticalOverflow: el.scrollHeight > el.clientHeight,
        hasHorizontalOverflow: el.scrollWidth > el.clientWidth,
      }));
    }).toEqual({
      hasVerticalOverflow: true,
      hasHorizontalOverflow: true,
    });

    const metrics = await diffScroll.evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }));
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
    expect(metrics.scrollWidth).toBeGreaterThan(metrics.clientWidth);

    // 1. 顶部可横向滚动
    await diffScroll.evaluate((el) => { el.scrollLeft = 80; });
    await expect.poll(async () => diffScroll.evaluate((el) => el.scrollLeft)).toBe(80);

    // 2. 纵向滚至中部（scrollTop = 300）
    await diffScroll.evaluate((el) => { el.scrollTop = 300; });
    await expect.poll(async () => diffScroll.evaluate((el) => el.scrollTop)).toBe(300);
    // 在中部仍能横向滚动
    await diffScroll.evaluate((el) => { el.scrollLeft = 160; });
    await expect.poll(async () => diffScroll.evaluate((el) => el.scrollLeft)).toBe(160);

    // 3. 纵向滚至底部
    await diffScroll.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await expect.poll(async () => diffScroll.evaluate((el) => el.scrollTop)).toBeGreaterThan(300);
    await diffScroll.evaluate((el) => { el.scrollLeft = 40; });
    await expect.poll(async () => diffScroll.evaluate((el) => el.scrollLeft)).toBe(40);

    // 状态栏和侧边栏文件导航依然固定且可见
    await expect(statusBar).toBeVisible();
    await expect(sidebar).toBeVisible();

    // 4. 切换为短行文件 short-normal.ts
    await page.locator(".diff-file-card", { hasText: "short-normal.ts" }).click();
    await expect(page.locator(".diff-full-path")).toContainText("src/short-normal.ts");

    // 等待 short-normal.ts 内容渲染完成，且长行旧内容已卸载
    await expect(page.locator(".diff-loading-state")).not.toBeVisible();
    await expect(page.locator(".diff-content-col", { hasText: "const val = 2;" })).toBeVisible();
    await expect(page.locator(".diff-content-col", { hasText: "row_0_" })).not.toBeAttached();

    // 无多余横向滚动，使用重试断言确保尺寸稳定
    await expect.poll(async () => {
      return diffScroll.evaluate((el) => el.scrollWidth <= el.clientWidth);
    }).toBe(true);

    const normalMetrics = await diffScroll.evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }));
    // 无多余横向滚动
    expect(normalMetrics.scrollWidth).toBeLessThanOrEqual(normalMetrics.clientWidth);

    // 5. 调整视口至窄窗口 (800x700) 与 桌面窗口 (1440x900)
    for (const [w, h] of [[800, 700], [1440, 900]] as const) {
      await page.setViewportSize({ width: w, height: h });
      const docOverflow = await page.evaluate(() => {
        return document.documentElement.scrollWidth <= window.innerWidth;
      });
      // 页面主体不被撑宽
      expect(docOverflow).toBe(true);
    }
  });

  test("E3: 导航、差异状态、复制路径与全屏回归", async ({ page }) => {
    const workflowId = fixtureState().workflow_id;
    await page.goto(`/?workflow=${workflowId}`);

    // 1. 文件搜索筛选与清空
    const searchInput = page.locator(".diff-search-input");
    await searchInput.fill("huge");
    await expect(page.locator(".diff-file-card")).toHaveCount(1);
    await expect(page.locator(".diff-file-card")).toContainText("huge-file.ts");

    await page.locator(".diff-search-clear").click();
    await expect(page.locator(".diff-file-card")).toHaveCount(5);

    // 2. 树状与列表视图切换
    await page.getByRole("button", { name: "列表", exact: true }).click();
    await expect(page.locator(".diff-file-card-flat").first()).toBeVisible();
    await page.getByRole("button", { name: "树状", exact: true }).click();

    // 3. 截断提示 banner 回归
    await page.locator(".diff-file-card", { hasText: "huge-file.ts" }).click();
    await expect(page.locator(".diff-truncated-banner")).toBeVisible();
    await expect(page.locator(".diff-truncated-banner")).toContainText("文件过大");

    // 4. 空差异提示回归
    await page.locator(".diff-file-card", { hasText: "empty.ts" }).click();
    await expect(page.locator(".diff-empty-state")).toBeVisible();
    await expect(page.locator(".diff-empty-state")).toContainText("该文件无差异内容");

    // 5. 复制完整路径
    await page.locator(".diff-file-card", { hasText: "short-long.ts" }).click();
    await expect(page.locator(".diff-full-path")).toContainText("src/short-long.ts");
    await expect(page.locator(".diff-loading-state")).not.toBeVisible();
    const copyBtn = page.getByRole("button", { name: "复制路径", exact: true });
    await copyBtn.click();
    await expect(page.getByRole("button", { name: "已复制", exact: true })).toBeVisible();

    // 6. 全屏审查弹窗与 Escape 快捷键
    const fullscreenBtn = page.getByRole("button", { name: "全屏审查 ↗", exact: true });
    await fullscreenBtn.click();
    const modal = page.locator(".file-diff-modal");
    await expect(modal).toBeVisible();
    await expect(modal.locator("pre.file-diff")).toBeVisible();

    // 按 Escape 关闭弹窗
    await page.keyboard.press("Escape");
    await expect(modal).not.toBeVisible();
  });
});
