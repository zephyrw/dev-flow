import { test, expect, type Page } from "@playwright/test";

const snapshot = "**/api/agy-accounts/snapshot";
const row = (page: Page, id: string) => page.locator(".agy-account-row").filter({ hasText: `${id}@example.com` });
const weekly = (page: Page, id: string) => row(page, id).locator('[data-category="gemini"] .agy-compact-quota').filter({ hasText: "周额度" });
const changed = (page: Page) => page.request.get("/api/account-fixture/save-new-cycle");
async function fullPage(page: Page) {
  await page.route("**/api/health", async route => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), mode: "full" } });
  });
  await page.route("**/api/projects", route => route.fulfill({ json: [] }));
  await page.route("**/api/workflows?visibility=visible", route => route.fulfill({ json: [] }));
  await page.goto("/");
  await page.getByRole("button", { name: "AGY 账号管理", exact: true }).click();
}

test.beforeEach(async ({ page }) => {
  expect((await page.request.get("/api/account-fixture/setup-quota-scenarios")).ok()).toBe(true);
});

test("各账号保留实际额度、每池更新时间与未知重置时间，Argon 仅显示周额度", async ({ page }) => {
  await page.route(snapshot, async route => {
    const response = await route.fetch(), body = await response.json();
    const source = body.snapshots.find((s: any) => s.account_id === "a");
    body.snapshots.push({ ...source, pool_id: "Gemini 4 Argon", windows: [{ ...source.windows[0], kind: "weekly", duration_minutes: 10080, remaining_fraction: .99 }] });
    await route.fulfill({ response, json: body });
  });
  await page.goto("/");
  for (const [id, value] of [["a", "60%"], ["b", "69%"], ["c", "0%"], ["d", "83%"]]) {
    await expect(weekly(page, id!).locator(".agy-quota-num")).toHaveText(value!);
    await expect(weekly(page, id!)).toHaveAttribute("title", /查询于/);
  }
  await expect(row(page, "a").locator('[data-category="argon"] .agy-quota-num')).toHaveText("99%");
  await expect(row(page, "a").locator('[data-category="argon"] .agy-compact-quota')).toHaveCount(1);
  await expect(row(page, "b").locator('[data-category="argon"]')).toHaveCount(0);
  await expect(weekly(page, "d").locator(".agy-quota-reset")).toBeVisible();
});

test("重置时间经过后不推算满额，新观测通过通知更新且不污染其他额度池", async ({ page }) => {
  await page.request.get("/api/account-fixture/set-reset-soon?delayMs=-1");
  await page.goto("/");
  await expect(weekly(page, "d").locator(".agy-quota-num")).toHaveText("35%");
  await changed(page);
  await expect(weekly(page, "a").locator(".agy-quota-num")).toHaveText("45%");
  await expect(row(page, "a").locator('[data-category="gemini"] .agy-quota-num')).toHaveText(["45%", "88%"]);
  await expect(row(page, "a").locator('[data-category="other"] .agy-quota-num')).toHaveText(["75%", "60%"]);
  await page.reload();
  await expect(weekly(page, "d").locator(".agy-quota-num")).toHaveText("35%");
  await expect(row(page, "a").locator(".agy-badge.active")).toBeVisible();
});

test("混用任务显示首个归零额度及可操作的等待原因", async ({ page }) => {
  await page.route(snapshot, async route => {
    const response = await route.fetch(), body = await response.json();
    body.service.operations = [{ operation_id: "mixed-wait", phase: "waiting", kind: "switch", error: "no_eligible_account",
      quota_trigger: { account_id: "a", auth_epoch: 1, pool_id: "Claude and GPT models", window: "five_hour", observed_at: new Date().toISOString(), event_seq: 1, source: "official_cli_usage" } }];
    await route.fulfill({ response, json: body });
  });
  await page.goto("/");
  await expect(page.locator(".agy-active-op-card")).toContainText("Claude/GPT五小时额度为 0");
  await expect(page.locator(".agy-active-op-card")).toContainText("暂无满足全部模型和配额要求的账号");
  await expect(page.locator(".agy-active-op-card")).toContainText("任务进度已保留");
});

for (const phase of ["failed", "blocked", "cancelled"]) test(`切号 ${phase} 的 Keychain 错误可关闭，通知刷新不重复显示`, async ({ page }) => {
  await page.route(snapshot, async route => {
    const response = await route.fetch(), body = await response.json();
    body.service.operations = [{ operation_id: "keychain-switch", phase, kind: "switch", error: "keychain_action_failed" }];
    await route.fulfill({ response, json: body });
  });
  await page.goto("/");
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("macOS 钥匙串访问未完成");
  await alert.getByRole("button").click();
  const refreshed = page.waitForResponse(response => response.url().endsWith("/snapshot"));
  await changed(page); await refreshed;
  await expect(alert).toHaveCount(0);
});

test("主动取消不显示失败警报", async ({ page }) => {
  await page.route(snapshot, async route => {
    const response = await route.fetch(), body = await response.json();
    body.service.operations = [{ operation_id: "cancel", phase: "cancelled", kind: "switch", error: "operation_cancelled" }];
    body.refresh = { status: "cancelled" };
    await route.fulfill({ response, json: body });
  });
  await page.goto("/");
  await expect(row(page, "a")).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("切号立即提交、禁止重复点击并复用网络失败请求的意图", async ({ page }) => {
  let requests = 0, requestId = "", release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/agy-accounts/sync-active", () => { throw new Error("switch must not wait for sync-active"); });
  await page.route("**/api/agy-accounts/switch", async route => {
    requests++;
    const body = route.request().postDataJSON();
    expect(body.selection).toEqual({ mode: "explicit", account_id: "b" });
    if (requestId) expect(body.request_id).toBe(requestId);
    requestId = body.request_id;
    if (requests === 1) { await gate; await route.abort("connectionfailed"); }
    else await route.fulfill({ status: 202, json: { operation_id: "switch", revision: 1, phase: "queued" } });
  });
  await page.goto("/");
  const button = row(page, "b").getByRole("button", { name: "设为活动" });
  try {
    await expect(button).toBeEnabled(); await button.click();
    await expect(button).toBeDisabled(); expect(requests).toBe(1);
    release(); await expect(button).toBeEnabled(); await button.click();
    await expect.poll(() => requests).toBe(2);
  } finally { release(); await page.unrouteAll({ behavior: "wait" }); }
});

test("首次读取失败不显示零账号，有通知连接时仍重试失败的读取", async ({ page }) => {
  let offline = true;
  await page.route(snapshot, route => offline ? route.abort("connectionfailed") : route.continue());
  await page.goto("/");
  await expect(page.getByText("暂时无法读取账号，连接恢复后会自动重试")).toBeVisible();
  await expect(page.getByText("暂无管理的 AGY 账号")).toHaveCount(0);
  await expect(page.locator(".agy-switch-input")).toBeDisabled();
  offline = false;
  await expect(page.locator(".agy-account-row")).toHaveCount(4);
  await expect(page.locator(".agy-switch-input")).toBeEnabled();
});

test("断连保留快照，恢复后清除错误", async ({ page }) => {
  let offline = false;
  await page.route(snapshot, route => offline ? route.abort("connectionfailed") : route.continue());
  await page.goto("/"); await expect(page.locator(".agy-account-row")).toHaveCount(4);
  offline = true; await changed(page);
  await expect(page.getByText(/显示 .* 的账号快照/)).toBeVisible();
  await expect(page.locator(".agy-account-row")).toHaveCount(4);
  offline = false;
  await expect(page.getByText(/显示 .* 的账号快照/)).toHaveCount(0);
  await expect(page.locator(".agy-switch-input")).toBeEnabled();
});

test("关闭重开立即显示快照，卸载前晚到响应不覆盖新页面", async ({ page }) => {
  let hold = false, held = false, offline = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(snapshot, async route => {
    if (offline) return route.abort("connectionfailed");
    if (!hold || held) return route.continue();
    held = true;
    const response = await route.fetch(), body = await response.json();
    await gate;
    await route.fulfill({ response, json: { ...body, accounts: [] } }).catch(() => {});
  });
  try {
    await fullPage(page); await expect(page.locator(".agy-account-row")).toHaveCount(4);
    hold = true; await changed(page); await expect.poll(() => held).toBe(true);
    await page.getByRole("button", { name: "关闭对话框", exact: true }).click();
    offline = true;
    await page.getByRole("button", { name: "AGY 账号管理", exact: true }).click();
    await expect(page.locator(".agy-account-row")).toHaveCount(4);
    await expect(page.getByText(/显示 .* 的账号快照/)).toBeVisible();
    release(); offline = false;
    await expect(page.getByText(/显示 .* 的账号快照/)).toHaveCount(0);
    await expect(page.locator(".agy-account-row")).toHaveCount(4);
  } finally { release(); await page.unrouteAll({ behavior: "wait" }); }
});

test("稳定连接无轮询，隐藏与关闭面板停止读取，60 秒内重开不探测额度", async ({ page }) => {
  let reads = 0, oldReads = 0;
  page.on("request", request => {
    if (request.url().endsWith("/snapshot")) reads++;
    if (/\/api\/agy-accounts(?:\/service)?$/.test(request.url())) oldReads++;
  });
  await fullPage(page); await expect(page.locator(".agy-account-row")).toHaveCount(4);
  await page.waitForTimeout(300);
  const settled = reads;
  const facts = await (await page.request.get("/api/account-fixture/facts")).json();
  await page.waitForTimeout(3300); expect(reads).toBe(settled); expect(oldReads).toBe(0);
  await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" }); document.dispatchEvent(new Event("visibilitychange")); });
  await changed(page); await page.waitForTimeout(1200); expect(reads).toBe(settled);
  await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" }); document.dispatchEvent(new Event("visibilitychange")); });
  await expect(weekly(page, "a").locator(".agy-quota-num")).toHaveText("45%");
  await page.getByRole("button", { name: "关闭对话框", exact: true }).click();
  const closedReads = reads; await changed(page); await page.waitForTimeout(1200); expect(reads).toBe(closedReads);
  await page.getByRole("button", { name: "AGY 账号管理", exact: true }).click();
  await expect(row(page, "a")).toBeVisible();
  expect((await (await page.request.get("/api/account-fixture/facts")).json()).probe_calls).toBe(facts.probe_calls);
});
