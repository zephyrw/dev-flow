import { test, expect } from "@playwright/test";

test("首页、子页面及浏览器标签均加载新的 DevFlow Logo 与图标资源", async ({ page, request }) => {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/health") {
      return route.fulfill({ json: { ok: true, mode: "full" } });
    }
    if (path === "/api/projects" || path === "/api/workflows" || path === "/api/groups") {
      return route.fulfill({ json: [] });
    }
    if (path === "/api/agy-accounts/snapshot") {
      return route.fulfill({ json: { accounts: [], snapshots: [], service: { operations: [] } } });
    }
    return route.fulfill({ json: {} });
  });
  await page.routeWebSocket("**/api/notifications", () => {});
  await page.routeWebSocket("**/api/events?*", () => {});

  // 1. 验证静态图标资源可直接访问
  for (const [url, mimePart] of [
    ["/favicon.ico", "icon"],
    ["/devflow-logo.svg", "svg"],
    ["/devflow-icon-512.png", "png"],
  ] as const) {
    const res = await request.get(url);
    expect(res.status(), `${url} 应返回 200`).toBe(200);
    expect(res.headers()["content-type"] ?? "").toContain(mimePart);
    expect((await res.body()).byteLength).toBeGreaterThan(0);
  }

  // 2. 验证首页与浏览器标签 head 元信息、侧边栏 Logo、空状态 Logo
  await page.goto("/");
  await expect(page.locator('head meta[name="theme-color"]')).toHaveAttribute("content", "#0B1637");
  await expect(page.locator('head link[rel="icon"][href="/favicon.ico"]')).toHaveCount(1);
  await expect(page.locator('head link[rel="icon"][type="image/svg+xml"][href="/devflow-logo.svg"]')).toHaveCount(1);
  await expect(page.locator('head link[rel="icon"][type="image/png"][href="/devflow-icon-512.png"]')).toHaveCount(1);
  await expect(page.locator('head link[rel="apple-touch-icon"][href="/devflow-icon-512.png"]')).toHaveCount(1);

  const sidebarLogo = page.locator("aside .brand-main img.mark");
  await expect(sidebarLogo).toBeVisible();
  await expect(sidebarLogo).toHaveAttribute("src", "/devflow-logo.svg");
  expect(await sidebarLogo.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);

  const emptyLogo = page.locator(".empty img.empty-logo");
  await expect(emptyLogo).toBeVisible();
  await expect(emptyLogo).toHaveAttribute("src", "/devflow-logo.svg");
  expect(await emptyLogo.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);

  // 3. 验证模型群聊顶栏 Logo
  await page.goto("/group-chat");
  const gcLogo = page.locator(".gc-top img.gc-brand-logo");
  await expect(gcLogo).toBeVisible();
  await expect(gcLogo).toHaveAttribute("src", "/devflow-logo.svg");
  expect(await gcLogo.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);

  // 4. 验证账号管理独立页 Logo
  await page.goto("/accounts");
  const accountsLogo = page.locator('h2 img[src="/devflow-logo.svg"]');
  await expect(accountsLogo).toBeVisible();
  expect(await accountsLogo.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
});
