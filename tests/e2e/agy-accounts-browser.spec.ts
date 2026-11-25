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

test("各账号保留实际额度、隐藏查询时间与正常状态标签，隐藏历史 Argon 独立额度", async ({ page }) => {
  await page.route(snapshot, async route => {
    const response = await route.fetch(), body = await response.json();
    const source = body.snapshots.find((s: any) => s.account_id === "a");
    body.snapshots.push({ ...source, pool_id: "Gemini 4 Argon", windows: [{ ...source.windows[0], kind: "weekly", duration_minutes: 10080, remaining_fraction: .99 }] });
    await route.fulfill({ response, json: body });
  });
  await page.goto("/");
  for (const [id, value] of [["a", "60%"], ["b", "69%"], ["c", "0%"], ["d", "83%"]]) {
    await expect(weekly(page, id!).locator(".agy-quota-num")).toHaveText(value!);
    await expect(weekly(page, id!)).not.toHaveAttribute("title", /查询于/);
  }
  await expect(page.getByText(/额度查询时间：/)).toHaveCount(0);
  await expect(row(page, "b").locator(".agy-badge", { hasText: "正常" })).toHaveCount(0);
  await expect(page.getByText("当前自动选择依据：")).toHaveCount(0);
  await expect(page.getByText("Gemini 4 Argon", { exact: true })).toHaveCount(0);
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

test("非当前账号的五小时额度到点显示满额，周额度继续显示实测值", async ({ page }) => {
  const response = await page.request.get("/api/account-fixture/set-reset-soon?delayMs=20000");
  const { soonReset } = await response.json();
  await page.clock.install({ time: new Date(Date.parse(soonReset) - 20_000) });
  await page.goto("/");
  const quota = row(page, "d").locator('[data-category="gemini"] .agy-compact-quota').filter({ hasText: "五小时额度" });
  await expect(quota.locator(".agy-quota-num")).toHaveText("90%");
  await page.clock.fastForward(21_000);
  await expect(quota.locator(".agy-quota-num")).toHaveText("100%");
  await expect(quota).toHaveAttribute("title", /按上次查询的重置时间计算/);
  await expect(quota.locator(".agy-quota-reset")).toHaveCount(0);
  await expect(weekly(page, "d").locator(".agy-quota-num")).toHaveText("35%");
});

test("非当前账号用图标刷新额度，移除图标继续弹出确认", async ({ page }) => {
  const { active } = await (await page.request.get("/api/account-fixture/facts")).json();
  const target = active === "b" ? "c" : "b";
  await page.goto("/");
  const refresh = row(page, target).getByRole("button", { name: "刷新", exact: true });
  const remove = row(page, target).getByRole("button", { name: "移除账号" });
  await refresh.hover();
  await expect(refresh).toHaveAttribute("title", "刷新");
  await expect(refresh.locator("svg")).toBeVisible();
  await remove.hover();
  await expect(remove).toHaveAttribute("title", "移除");
  await expect(remove.locator("svg")).toBeVisible();
  page.once("dialog", dialog => dialog.dismiss());
  await remove.click();
  await expect(row(page, target)).toBeVisible();
  const submitted = page.waitForResponse(response => response.url().endsWith(`/${target}/probe`));
  await refresh.click();
  const { operation_id } = await (await submitted).json();
  await expect.poll(async () => {
    const result = await page.request.get(`/api/agy-accounts/operations/${operation_id}`);
    return (await result.json()).phase;
  }).toBe("completed");
  expect((await (await page.request.get("/api/account-fixture/facts")).json()).active).toBe(active);
});

test("混用任务显示首个归零额度及可操作的等待原因", async ({ page }) => {
  await page.route(snapshot, async route => {
    const response = await route.fetch(), body = await response.json();
    body.service.pending_operation_id = "mixed-wait";
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

test("重复导入显示保存的账号，并且只请求刷新当前账号额度", async ({ page }) => {
  const facts = await (await page.request.get("/api/account-fixture/facts")).json();
  const refreshScopes: string[] = [];
  page.on("request", request => {
    if (request.method() === "POST" && request.url().endsWith("/api/agy-accounts/refresh"))
      refreshScopes.push(request.postDataJSON().scope);
  });
  await page.goto("/");
  await expect(row(page, facts.active)).toBeVisible();
  await expect.poll(() => refreshScopes).toContain("active_only");
  refreshScopes.length = 0;
  await page.getByRole("button", { name: "+ 导入当前账号" }).click();
  const dialog = page.getByRole("dialog", { name: "导入本机当前活动账号" });
  await dialog.getByRole("button", { name: "开始导入" }).click();
  await expect(dialog.getByRole("heading", { name: "已更新列表中的账号" })).toBeVisible();
  await expect(dialog.getByText(`${facts.active}@example.com 已保存为当前账号。`, { exact: false })).toBeVisible();
  await dialog.getByRole("button", { name: "完成" }).click();
  await expect(dialog).toBeHidden();
  await expect(row(page, facts.active)).toHaveCount(1);
  await expect.poll(() => refreshScopes).toEqual(["active_only"]);
});

test("卡住的取消操作显示核验入口，收尾后可再次手动切换", async ({ page }) => {
  let blocked = true;
  const operationId = "blocked-cancel";
  await page.route(snapshot, async route => {
    const response = await route.fetch();
    const body = await response.json();
    body.service.active_account_id = blocked ? "a" : "c";
    body.service.pending_operation_id = blocked ? operationId : null;
    body.service.last_error = blocked ? "external_change" : undefined;
    body.service.operations = blocked ? [{ operation_id: operationId, revision: 10, phase: "blocked",
      kind: "switch", cancel_requested: true, error: "operation_cancelled" }] : [];
    await route.fulfill({ response, json: body });
  });
  await page.route("**/api/agy-accounts/verify-active", route => route.fulfill({
    json: blocked ? { status: "unconfirmed" } : { status: "verified", account_id: "c" },
  }));
  await page.route(`**/api/agy-accounts/operations/${operationId}/reconcile`, async route => {
    blocked = false;
    await route.fulfill({ json: { operation_id: operationId, revision: 11, phase: "cancelled" } });
  });
  await page.goto("/");
  await expect(row(page, "a").getByText("上次确认")).toBeVisible();
  const manual = row(page, "b").getByRole("button", { name: "设为当前使用" });
  await expect(manual).toBeDisabled();
  await page.getByRole("button", { name: "重新核验" }).click();
  await expect(row(page, "c").getByText("当前使用中")).toBeVisible();
  await expect(manual).toBeEnabled();
  await page.unrouteAll({ behavior: "wait" });
});

test("保留当前登录结束阻塞探测，并明确选择重新登录的最终账号", async ({ page }) => {
  let blocked = true;
  const operationId = "blocked-quota-probe";
  const baseline = await (await page.request.get("/api/agy-accounts/snapshot")).json();
  await page.route(snapshot, async route => {
    const body = structuredClone(baseline);
    const account = body.accounts.find((item: { id: string }) => item.id === "b");
    account.state = "reauth_required";
    account.saved_credential_status = "unverified";
    const liveAccount = body.accounts.find((item: { id: string }) => item.id === "c");
    liveAccount.state = "reauth_required";
    liveAccount.saved_credential_status = "needs_update";
    body.service.active_account_id = blocked ? "a" : "c";
    body.service.pending_operation_id = blocked ? operationId : null;
    body.service.last_error = blocked ? "account_identity_in_use" : undefined;
    body.service.can_preserve_current_login = blocked;
    body.service.operations = blocked ? [{ operation_id: operationId, revision: 8,
      phase: "blocked", kind: "probe", error: "account_identity_in_use" }] : [];
    await route.fulfill({ json: body });
  });
  await page.route("**/api/agy-accounts/verify-active", route => route.fulfill({
    json: blocked ? { status: "unconfirmed" } : { status: "verified", account_id: "c" },
  }));
  await page.route(`**/api/agy-accounts/operations/${operationId}/reconcile`, async route => {
    blocked = false;
    await route.fulfill({ json: { operation_id: operationId, revision: 9, phase: "cancelled" } });
  });
  await page.route("**/api/agy-accounts/b/reauth", route => {
    expect(route.request().postDataJSON().reauth_disposition).toBe("save_only");
    return route.fulfill({ status: 202, json: { operation_id: "reauth", revision: 1, phase: "queued" } });
  });
  await page.goto("/");
  await expect(page.getByText("额度探测已停止，需确认保留当前登录")).toBeVisible();
  await expect(page.locator(".agy-active-op-card .agy-op-spinner")).toHaveCount(0);
  await page.getByRole("button", { name: "保留当前登录并结束操作" }).click();
  await expect(row(page, "c").getByText("当前使用中")).toBeVisible();
  await expect(row(page, "c").getByRole("button", { name: "更新查询凭据" })).toBeVisible();
  await expect(row(page, "b").getByText("保存凭据待核验")).toBeVisible();
  await row(page, "b").getByRole("button", { name: "重新登录" }).click();
  const dialog = page.getByRole("dialog", { name: "重新登录 AGY 账号" });
  await expect(dialog.getByRole("button", { name: "更新并设为当前使用" })).toBeVisible();
  const sent = page.waitForRequest(request => request.url().endsWith("/b/reauth"));
  await dialog.getByRole("button", { name: "仅更新保存凭据" }).click();
  await sent;
  await expect(dialog).toBeHidden();
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
  const button = row(page, "b").getByRole("button", { name: "设为当前使用" });
  await button.hover();
  await expect(button).toHaveAttribute("title", "设为当前使用");
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
  await page.waitForTimeout(3300); expect(reads).toBe(settled); expect(oldReads).toBe(0);
  await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" }); document.dispatchEvent(new Event("visibilitychange")); });
  await changed(page); await page.waitForTimeout(1200); expect(reads).toBe(settled);
  await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" }); document.dispatchEvent(new Event("visibilitychange")); });
  await expect(weekly(page, "a").locator(".agy-quota-num")).toHaveText("45%");
  await page.getByRole("button", { name: "关闭对话框", exact: true }).click();
  const closedReads = reads; await changed(page); await page.waitForTimeout(1200); expect(reads).toBe(closedReads);
  const facts = await (await page.request.get("/api/account-fixture/facts")).json();
  await page.getByRole("button", { name: "AGY 账号管理", exact: true }).click();
  await expect(row(page, "a")).toBeVisible();
  await page.waitForTimeout(300);
  expect((await (await page.request.get("/api/account-fixture/facts")).json()).probe_calls).toBe(facts.probe_calls);
});

test("账号操作按钮顺序紧凑，支持手动排序和额度刷新动画", async ({ page }) => {
  await page.route(snapshot, async route => {
    const response = await route.fetch();
    const body = await response.json();
    body.accounts = body.accounts.map((acc: any) => ({
      ...acc,
      last_used_at:
        acc.id === "a" ? "2026-11-25T10:00:00Z"
        : acc.id === "b" ? "2026-11-25T09:00:00Z"
        : acc.id === "c" ? "2026-11-25T08:00:00Z"
        : "2026-11-25T07:00:00Z",
    }));
    await route.fulfill({ response, json: body });
  });
  let sortBody: any = null;
  await page.route("**/api/agy-accounts/sort", async route => {
    sortBody = route.request().postDataJSON();
    await route.fulfill({
      json: {
        realm_id: "default-agy-realm",
        mode: sortBody.mode ?? "custom",
        direction: sortBody.direction ?? "asc",
        custom_order: sortBody.custom_order ?? [],
        updated_at: new Date().toISOString(),
      },
    });
  });

  await page.goto("/");
  // 默认按最近使用升序（a -> b -> c -> d）
  const emails = page.locator(".agy-account-row .agy-account-email");
  await expect(emails).toHaveText(["a@example.com", "b@example.com", "c@example.com", "d@example.com"]);
  await expect(page.getByText("管理 Antigravity 账号及自动切换设置")).toHaveCount(0);

  const rowBButtons = row(page, "b").locator(".agy-account-actions button");
  await expect(rowBButtons).toHaveCount(5);
  expect(await rowBButtons.evaluateAll(buttons => buttons.map(button => button.getAttribute("aria-label"))))
    .toEqual(["设为当前使用", "上移账号", "下移账号", "刷新", "移除账号"]);
  const actionIcons = rowBButtons.locator("svg");
  await expect(actionIcons).toHaveCount(5);
  for (const icon of await actionIcons.all()) {
    await expect(icon).toHaveCSS("width", "15px");
    await expect(icon).toHaveCSS("height", "15px");
  }
  const activate = row(page, "b").getByRole("button", { name: "设为当前使用" });
  await expect(activate.locator("svg polygon")).toHaveCSS("fill", "rgb(100, 116, 139)");
  const bounds = await rowBButtons.evaluateAll(buttons => buttons.map(button => {
    const { left, right } = button.getBoundingClientRect();
    return { left, right };
  }));
  for (let index = 1; index < bounds.length; index++) {
    const gap = bounds[index]!.left - bounds[index - 1]!.right;
    expect(gap).toBeGreaterThanOrEqual(0);
    expect(gap).toBeLessThanOrEqual(4);
  }

  // 点击第2个账号 b 的上移按钮：切换到自定义排序且顺序变为 b -> a -> c -> d
  await row(page, "b").getByRole("button", { name: "上移账号" }).click();
  await expect.poll(() => sortBody?.mode).toBe("custom");
  expect(sortBody.custom_order).toEqual(["b", "a", "c", "d"]);
  await expect(emails).toHaveText(["b@example.com", "a@example.com", "c@example.com", "d@example.com"]);

  // 切换到按额度排序（默认降序，最高额度在前；c=0% 靠后）
  await page.getByLabel("排序方式").selectOption("quota");
  await expect.poll(() => sortBody?.mode).toBe("quota");
  expect(sortBody.direction).toBe("desc");

  // 触发单账号刷新时的动态骨架动画与隐藏旧额度，然后恢复展示
  let releaseProbe!: () => void;
  const probeGate = new Promise<void>(resolve => { releaseProbe = resolve; });
  await page.route("**/api/agy-accounts/b/probe", async route => {
    await probeGate;
    await route.fulfill({ status: 202, json: { operation_id: "probe-b", revision: 1, phase: "queued" } });
  });
  await row(page, "b").getByRole("button", { name: "刷新", exact: true }).click();
  await expect(row(page, "b").locator(".agy-quota-loading-line")).toHaveCount(2);
  await expect(row(page, "b").locator(".agy-compact-quota")).toHaveCount(0);
  releaseProbe();
});
