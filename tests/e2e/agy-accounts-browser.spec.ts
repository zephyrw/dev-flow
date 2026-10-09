import { test, expect } from "@playwright/test";

test.describe("AGY 账号与周额度展示 E2E 测试", () => {
  test.beforeEach(async ({ page }) => {
    // 注入标准测试场景数据：3 个已重置账号 (a, b, c) 和 1 个对照未来账号 (d)
    const res = await page.request.get("/api/account-fixture/setup-quota-scenarios");
    expect(res.ok()).toBeTruthy();
  });

  test("五小时额度到期恢复100%和正常状态，查询失败有提示且reload不回退", async ({ page }) => {
    expect((await page.request.get("/api/account-fixture/set-five-hour-reset?delayMs=8000")).ok()).toBeTruthy();
    await page.goto("/");
    const row = page.locator(".agy-account-row").filter({ hasText: "b@example.com" });
    const short = row.locator('.agy-quota-group[data-category="gemini"] .agy-compact-quota').filter({ hasText: "五小时额度" });
    await expect(short.locator(".agy-quota-num")).toHaveText("0%");
    await expect(row.locator(".agy-badge.ready")).toHaveText("额度等待中");
    await expect(short.locator(".agy-quota-reset")).toBeVisible();
    await expect(page.getByText(/额度查询失败，已保留上次结果/)).toBeVisible();
    await expect(short.locator(".agy-quota-num")).toHaveText("100%", { timeout: 16000 });
    await expect(row.locator(".agy-badge.ready")).toHaveText("正常");
    await expect(short.locator(".agy-quota-reset")).toHaveCount(0);
    await page.reload();
    await expect(short.locator(".agy-quota-num")).toHaveText("100%");
    await expect(row.locator(".agy-badge.ready")).toHaveText("正常");
    expect(await short.locator(".agy-quota-fill").getAttribute("style")).toContain("width: 100%");
    await expect(row.locator('.agy-quota-group[data-category="other"] .agy-quota-num')).toHaveText(["75%", "60%"]);
    await expect(page.locator(".agy-account-row").filter({ hasText: "a@example.com" }).locator(".agy-badge.active")).toBeVisible();
  });

  for (const phase of ["failed", "blocked", "cancelled"]) {
    test(`切号 ${phase} 时显示 Keychain 错误，关闭提示后轮询不重复弹出`, async ({ page }) => {
      await page.route("**/api/agy-accounts/service", async route => {
        const response = await route.fetch();
        const body = await response.json();
        body.operations = [{ operation_id: "keychain-switch", phase, kind: "switch", error: "keychain_action_failed" }];
        await route.fulfill({ response, json: body });
      });
      await page.goto("/");
      const alert = page.getByRole("alert");
      await expect(alert).toContainText("macOS 钥匙串访问未完成");
      await alert.getByRole("button").click();
      await expect(alert).toHaveCount(0);
      const nextPoll = page.waitForResponse(response => response.url().endsWith("/api/agy-accounts/service"));
      await nextPoll;
      await expect(alert).toHaveCount(0);
    });
  }

  test("主动取消切号不显示失败提示", async ({ page }) => {
    await page.route("**/api/agy-accounts/service", async route => {
      const response = await route.fetch();
      const body = await response.json();
      body.operations = [{ operation_id: "user-cancel", phase: "cancelled", kind: "switch", error: "operation_cancelled" }];
      await route.fulfill({ response, json: body });
    });
    const serviceLoaded = page.waitForResponse(response => response.url().endsWith("/api/agy-accounts/service"));
    await page.goto("/");
    await serviceLoaded;
    await expect(page.getByRole("heading", { name: "AGY 账号与额度管理" })).toBeVisible();
    await expect(page.locator(".agy-account-row").first()).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await page.unrouteAll({ behavior: "wait" });
  });

  test("手动切号先同步本机身份，再使用最新代次提交", async ({ page }) => {
    let syncs = 0;
    await page.route("**/api/agy-accounts/sync-active", async route => {
      syncs++;
      await route.continue();
    });
    await page.route("**/api/agy-accounts/service", async route => {
      const response = await route.fetch();
      const body = await response.json();
      body.auth_epoch = syncs >= 2 ? 42 : 1;
      await route.fulfill({ response, json: body });
    });
    await page.route("**/api/agy-accounts/switch", async route => {
      expect(syncs).toBeGreaterThanOrEqual(2);
      expect(route.request().postDataJSON().expected_epoch).toBe(42);
      await route.fulfill({ status: 202, json: { operation_id: "fresh-identity-switch", revision: 1, phase: "completed" } });
    });
    await page.goto("/");
    const button = page.locator(".agy-account-row").filter({ hasText: "b@example.com" }).getByRole("button", { name: "设为活动" });
    await expect(button).toBeVisible();
    const submitted = page.waitForResponse(response => response.url().endsWith("/api/agy-accounts/switch"));
    await button.click();
    await submitted;
    await page.unrouteAll({ behavior: "wait" });
  });

  test("A12: 真实浏览器展示 3 条已重置账号 100% 无倒计时，对照账号展示实际值与倒计时", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "AGY 账号与额度管理" }),
    ).toBeVisible();

    // 定位四个账号的行元素
    const rowA = page.locator(".agy-account-row").filter({ hasText: "a@example.com" });
    const rowB = page.locator(".agy-account-row").filter({ hasText: "b@example.com" });
    const rowC = page.locator(".agy-account-row").filter({ hasText: "c@example.com" });
    const rowD = page.locator(".agy-account-row").filter({ hasText: "d@example.com" });

    await expect(rowA).toBeVisible();
    await expect(rowB).toBeVisible();
    await expect(rowC).toBeVisible();
    await expect(rowD).toBeVisible();

    // 辅助函数：获取指定账号行的周额度条
    const getWeeklyQuota = (row: typeof rowA) =>
      row.locator('.agy-quota-group[data-category="gemini"]').locator(".agy-compact-quota").filter({ hasText: "周额度" });

    // 验证账号 a (旧 60%, reset_at=null -> 有效 100%)
    const weeklyA = getWeeklyQuota(rowA);
    await expect(weeklyA.locator(".agy-quota-num")).toHaveText("100%");
    await expect(weeklyA.locator(".agy-quota-fill")).toHaveCSS("width", /.+/);
    const styleA = await weeklyA.locator(".agy-quota-fill").getAttribute("style");
    expect(styleA).toContain("width: 100%");
    await expect(weeklyA.locator(".agy-quota-reset")).toHaveCount(0);
    expect(await weeklyA.getAttribute("title")).toBe("周额度：100%");

    // 验证账号 b (旧 69%, reset_at=null -> 有效 100%)
    const weeklyB = getWeeklyQuota(rowB);
    await expect(weeklyB.locator(".agy-quota-num")).toHaveText("100%");
    const styleB = await weeklyB.locator(".agy-quota-fill").getAttribute("style");
    expect(styleB).toContain("width: 100%");
    await expect(weeklyB.locator(".agy-quota-reset")).toHaveCount(0);
    expect(await weeklyB.getAttribute("title")).toBe("周额度：100%");

    // 验证账号 c (旧 0%, reset_at 已过期 -> 有效 100%)
    const weeklyC = getWeeklyQuota(rowC);
    await expect(weeklyC.locator(".agy-quota-num")).toHaveText("100%");
    const styleC = await weeklyC.locator(".agy-quota-fill").getAttribute("style");
    expect(styleC).toContain("width: 100%");
    await expect(weeklyC.locator(".agy-quota-reset")).toHaveCount(0);
    expect(await weeklyC.getAttribute("title")).toBe("周额度：100%");

    // 验证对照账号 d (83%, 未来重置时间 -> 保持 83% 并展示倒计时)
    const weeklyD = getWeeklyQuota(rowD);
    await expect(weeklyD.locator(".agy-quota-num")).toHaveText("83%");
    const styleD = await weeklyD.locator(".agy-quota-fill").getAttribute("style");
    expect(styleD).toContain("width: 83%");
    await expect(weeklyD.locator(".agy-quota-reset")).toBeVisible();
    const titleD = await weeklyD.getAttribute("title");
    expect(titleD).toContain("周额度：83%");
    expect(titleD).toContain("重置");
  });

  test("A13: 跨越重置时间后刷新恢复 100%、reload 不退回旧值、运行状态保持不变", async ({
    page,
  }) => {
    // 设置账号 d 的重置时间为 4 秒后到期
    const res = await page.request.get("/api/account-fixture/set-reset-soon?delayMs=4000");
    expect(res.ok()).toBeTruthy();

    await page.goto("/");
    const rowD = page.locator(".agy-account-row").filter({ hasText: "d@example.com" });
    await expect(rowD).toBeVisible();

    const weeklyD = rowD.locator('.agy-quota-group[data-category="gemini"]').locator(".agy-compact-quota").filter({ hasText: "周额度" });
    // 初始状态为 35%
    await expect(weeklyD.locator(".agy-quota-num")).toHaveText("35%");

    // 等待跨越重置时间 (4.2 秒后)
    await page.waitForTimeout(4200);

    // 页面轮询或手动刷新后，额度应自动推导恢复为 100%
    await page.reload();
    await expect(weeklyD.locator(".agy-quota-num")).toHaveText("100%");
    const styleD = await weeklyD.locator(".agy-quota-fill").getAttribute("style");
    expect(styleD).toContain("width: 100%");
    await expect(weeklyD.locator(".agy-quota-reset")).toHaveCount(0);

    // 再次 reload 验证持久展示不退回
    await page.reload();
    await expect(weeklyD.locator(".agy-quota-num")).toHaveText("100%");
    await expect(weeklyD.locator(".agy-quota-reset")).toHaveCount(0);

    // 运行状态与活动账号验证未受额度推导干扰
    const rowA = page.locator(".agy-account-row").filter({ hasText: "a@example.com" });
    await expect(rowA.locator(".agy-badge.active")).toBeVisible();
  });

  test("A14: 新周期较低额度保存刷新显示实际值及未来倒计时，五小时与其他池不污染", async ({
    page,
  }) => {
    await page.goto("/");
    const rowA = page.locator(".agy-account-row").filter({ hasText: "a@example.com" });
    await expect(rowA).toBeVisible();

    // 账号 a 在初始状态为 100%
    const weeklyA = rowA.locator('.agy-quota-group[data-category="gemini"]').locator(".agy-compact-quota").filter({ hasText: "周额度" });
    await expect(weeklyA.locator(".agy-quota-num")).toHaveText("100%");

    // 模拟新周期到来并消耗了额度：保存账号 a 的新快照（周额度 45%，未来 6 天）
    const res = await page.request.get("/api/account-fixture/save-new-cycle");
    expect(res.ok()).toBeTruthy();

    // 刷新页面后读取最新数据
    await page.reload();

    // 周额度应显示为实际新周期值 45%，且具备倒计时
    await expect(weeklyA.locator(".agy-quota-num")).toHaveText("45%");
    const styleWeekly = await weeklyA.locator(".agy-quota-fill").getAttribute("style");
    expect(styleWeekly).toContain("width: 45%");
    await expect(weeklyA.locator(".agy-quota-reset")).toBeVisible();
    const titleWeekly = await weeklyA.getAttribute("title");
    expect(titleWeekly).toContain("周额度：45%");
    expect(titleWeekly).toContain("重置");

    // 验证五小时额度维持 88% 及相应状态，未被推导为 100%
    const shortA = rowA.locator('.agy-quota-group[data-category="gemini"]').locator(".agy-compact-quota").filter({ hasText: "五小时额度" });
    await expect(shortA.locator(".agy-quota-num")).toHaveText("88%");
    const styleShort = await shortA.locator(".agy-quota-fill").getAttribute("style");
    expect(styleShort).toContain("width: 88%");
    await expect(shortA.locator(".agy-quota-reset")).toBeVisible();
    const other = rowA.locator('.agy-quota-group[data-category="other"]').locator(".agy-compact-quota").filter({ hasText: "周额度" });
    await expect(other.locator(".agy-quota-num")).toHaveText("75%");
  });
});
