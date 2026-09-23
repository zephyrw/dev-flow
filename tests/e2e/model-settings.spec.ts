import { test, expect } from "@playwright/test";
import {
  exactLabel,
  executionSpec,
  fixturePost,
  fixtureProbeCount,
  fixtureState,
  pickListedModel,
  waitAccessStatus,
  workflowDetail,
} from "./native-helper.js";

test.describe.configure({ mode: "serial" });

test("E2E-U01 无任务也可打开全局设置并编辑两套默认", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "工作流总览" })).toBeVisible();
  await page.getByRole("button", { name: "全局模型设置" }).click();
  const drawer = page.getByRole("dialog", { name: "工具与模型" });
  await expect(drawer).toBeVisible();
  await expect(drawer).toContainText("此处修改只影响以后新建的任务");
  await expect(
    drawer.getByRole("heading", { name: "默认规划配置" }),
  ).toBeVisible();
  await expect(
    drawer.getByRole("heading", { name: "默认执行配置" }),
  ).toBeVisible();
  await expect(exactLabel(drawer, "规划工具")).toBeEnabled();
  await expect(exactLabel(drawer, "执行工具")).toBeEnabled();
});

test("E2E-U02 修改全局默认后新建任务预填新值", async ({ page }) => {
  const initial = await page.request.get("/api/settings/model-defaults");
  expect(initial.ok(), await initial.text()).toBeTruthy();
  const before = (await initial.json()).defaults;
  await page.goto("/");
  await page.getByRole("button", { name: "全局模型设置" }).click();
  const drawer = page.getByRole("dialog", { name: "工具与模型" });
  await exactLabel(drawer, "规划工具").selectOption("codex");
  await pickListedModel(drawer, "规划工具", "gpt-5.6-sol");
  await exactLabel(drawer, "执行工具").selectOption("agy");
  await pickListedModel(drawer, "执行工具", "gemini-3.7-flash-high");
  await waitAccessStatus(drawer.locator(".ms-editor").first(), "已验证可访问");
  await waitAccessStatus(drawer.locator(".ms-editor").nth(1), "已验证可访问");
  expect(before.plannerProfile.modelId).not.toBe("gpt-5.6-sol");
  await drawer.getByRole("button", { name: /保存默认配置/ }).click();
  await expect(drawer.locator(".ms-success")).toContainText("默认配置已保存", {
    timeout: 15000,
  });
  await expect(drawer.locator(".ms-error")).toHaveCount(0);
  const response = await page.request.get("/api/settings/model-defaults");
  expect(response.ok(), await response.text()).toBeTruthy();
  const saved = (await response.json()).defaults;
  expect(saved.revision).toBe(before.revision + 1);
  expect(saved.plannerProfile.modelId).toBe("gpt-5.6-sol");
  expect(saved.executorProfile.modelId).toBe("gemini-3.7-flash-high");
  await drawer.getByRole("button", { name: "关闭设置" }).click();
  await page.getByRole("button", { name: "+ 新建", exact: true }).click();
  const modal = page.locator(".modal-backdrop").last();
  await expect(modal).toContainText("来自系统默认");
  await expect(exactLabel(modal, "规划工具")).toHaveValue("codex");
  await expect(exactLabel(modal, "规划工具模型搜索")).toHaveValue(
    /gpt-5\.6-sol/,
  );
  await expect(exactLabel(modal, "执行工具")).toHaveValue("agy");
  await expect(exactLabel(modal, "执行工具模型搜索")).toHaveValue(
    /gemini-3\.7-flash-high/,
  );
});

test("E2E-U04 高级项只改 reviewer 时其余保持继承", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "+ 新建", exact: true }).click();
  const modal = page.locator(".modal-backdrop").last();
  await modal.locator("summary", { hasText: "更多角色配置" }).click();
  await modal.getByLabel("代码审查单独指定").check();
  await expect(exactLabel(modal, "代码审查")).toBeVisible();
  await expect(modal.getByLabel("审查修复跟随默认")).toBeChecked();
  await expect(modal.getByLabel("人工问题修复跟随默认")).toBeChecked();
});

test("E2E-U12 快速切换工具会清掉旧模型", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "全局模型设置" }).click();
  const drawer = page.getByRole("dialog", { name: "工具与模型" });
  const planner = exactLabel(drawer, "规划工具");
  await planner.selectOption("codex");
  await planner.selectOption("agy");
  await planner.selectOption("cursor-agent");
  await expect(drawer.getByLabel("规划工具模型搜索")).toHaveValue("请选择模型");
});

test("E2E-U13 历史模型不在目录时保留并标注", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "全局模型设置" }).click();
  const drawer = page.getByRole("dialog", { name: "工具与模型" });
  await drawer.getByText("高级选项").first().click();
  await drawer
    .getByLabel("规划工具原始模型 ID")
    .fill("historical-model-not-listed");
  await drawer.getByLabel("规划工具原始模型 ID").press("Enter");
  await expect(drawer.getByText("当前配置，目录未列出").first()).toBeVisible();
});

test("E2E-U15 设置抽屉可键盘操作并显示错误重试", async ({ page }) => {
  let catalogueAvailable = false;
  let catalogRequests = 0;
  await page.route(
    (url) => url.pathname === "/api/model-tools/codex/models",
    async (route) => {
      catalogRequests += 1;
      if (!catalogueAvailable) {
        await route.fulfill({
          status: 503,
          json: {
            code: "FIXTURE_CATALOG_UNAVAILABLE",
            message: "夹具目录暂不可用",
          },
        });
        return;
      }
      await route.continue();
    },
  );
  await page.goto("/");
  await page.getByRole("button", { name: "全局模型设置" }).focus();
  await page.keyboard.press("Enter");
  const drawer = page.getByRole("dialog", { name: "工具与模型" });
  await expect(drawer).toBeVisible();
  await exactLabel(drawer, "规划工具").focus();
  await expect(exactLabel(drawer, "规划工具")).toBeFocused();
  await page.keyboard.press("Tab");
  const planner = drawer.locator(".ms-editor").first();
  await expect(planner.locator(".ms-error")).toContainText("夹具目录暂不可用");
  const failures = catalogRequests;
  catalogueAvailable = true;
  await planner.getByRole("button", { name: "重试", exact: true }).click();
  await expect(planner.locator(".ms-error")).toHaveCount(0);
  await pickListedModel(planner, "规划工具", "gpt-6-astra");
  expect(catalogRequests).toBeGreaterThan(failures);
  await expect(exactLabel(planner, "规划工具模型搜索")).toHaveValue(
    /gpt-6-astra/,
  );
});

test("E2E-U03 新建当场改工具/模型/强度且后台 Run 参数一致", async ({
  page,
}) => {
  test.setTimeout(90000);
  const state = fixtureState();
  await page.goto("/");
  await page.getByRole("button", { name: "+ 新建", exact: true }).click();
  const modal = page.locator(".modal-backdrop").last();
  await modal.getByLabel("工作区真实路径").fill(state.nativeRepo);
  await modal
    .getByRole("radio", { name: /现有工作区/ })
    .check();
  const plannerCard = modal.locator(".ms-card").filter({ hasText: "规划配置" });
  await pickListedModel(plannerCard, "规划工具", "gpt-5.6-sol");
  await exactLabel(plannerCard, "规划工具思考强度").selectOption("xhigh");
  await waitAccessStatus(plannerCard, "已验证可访问");
  const executorCard = modal
    .locator(".ms-card")
    .filter({ hasText: "执行配置" });
  await exactLabel(executorCard, "执行工具").selectOption("cursor-agent");
  await pickListedModel(executorCard, "执行工具", "cursor-grok-4.6-high");
  await waitAccessStatus(executorCard, "已验证可访问");
  await modal.locator("textarea").fill("U03 当场改工具模型强度并核验 Run 参数");
  const created = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/workflows") && r.request().method() === "POST",
  );
  await modal.getByRole("button", { name: "创建并开始规划" }).click();
  const response = await created;
  expect(response.status(), await response.text()).toBe(200);
  const id = (await response.json()).workflow.id;
  const spec = await executionSpec(page, id);
  expect(spec.spec.plannerProfile).toMatchObject({
    adapterId: "codex",
    modelId: "gpt-5.6-sol",
    reasoning: { mode: "explicit", value: "xhigh" },
  });
  expect(spec.spec.executorProfile).toMatchObject({
    adapterId: "cursor-agent",
    modelId: "cursor-grok-4.6-high",
    reasoning: { mode: "explicit", value: "high" },
  });
  await expect
    .poll(
      async () => {
        const detail = await workflowDetail(page, id);
        const run = detail.runs?.[0];
        return run?.profile ?? run;
      },
      { timeout: 25000 },
    )
    .toMatchObject({
      adapterId: "codex",
      modelId: "gpt-5.6-sol",
      reasoning: { mode: "explicit", value: "xhigh" },
    });
});

test("E2E-U09 再次使用已验证模型无登录弹窗且探测不增加", async ({ page }) => {
  await page.goto("/");
  const before = await fixtureProbeCount(page);
  await page.getByRole("button", { name: "全局模型设置" }).click();
  const drawer = page.getByRole("dialog", { name: "工具与模型" });
  await expect(drawer).toBeVisible();
  await pickListedModel(drawer, "规划工具", "gpt-6-astra");
  await waitAccessStatus(drawer.locator(".ms-editor").first(), "已验证可访问");
  await expect(page.getByRole("dialog", { name: /登录|验证访问/ })).toHaveCount(
    0,
  );
  await expect(drawer.getByText("需要登录该工具")).toHaveCount(0);
  expect(await fixtureProbeCount(page)).toBe(before);
});

test("E2E-U10 首次验证失败准确错误与草稿不丢", async ({ page }) => {
  const state = fixtureState();
  await fixturePost(page, "/__fixture/probe-control", {
    behavior: "login",
    adapterId: "codex",
  });
  await page.goto("/");
  await page.getByRole("button", { name: "全局模型设置" }).click();
  const drawer = page.getByRole("dialog", { name: "工具与模型" });
  const planner = drawer.locator(".ms-editor").first();
  await planner.getByText("高级选项").click();
  await exactLabel(planner, "规划工具实际 CLI").fill(state.probeCli);
  await exactLabel(planner, "规划工具原始模型 ID").fill(
    "codex-login-required-model",
  );
  await exactLabel(planner, "规划工具原始模型 ID").press("Enter");
  await expect(planner.locator(".ms-access")).toContainText(/登录|验证未通过/, {
    timeout: 20000,
  });
  await expect(planner.getByRole("button", { name: "重新验证" })).toBeVisible();
  await expect(exactLabel(planner, "规划工具原始模型 ID")).toHaveValue(
    "codex-login-required-model",
  );
  await expect(exactLabel(planner, "规划工具实际 CLI")).toHaveValue(
    state.probeCli,
  );
  await fixturePost(page, "/__fixture/probe-control", {
    behavior: "ok",
    adapterId: "codex",
  });
  await fixturePost(page, "/__fixture/restore-access");
});

test("E2E-R23 编辑后刷新目录草稿保持", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "全局模型设置" }).click();
  const drawer = page.getByRole("dialog", { name: "工具与模型" });
  await expect(drawer).toBeVisible();
  await pickListedModel(drawer, "规划工具", "gpt-5.6-sol");
  await fixturePost(page, "/__fixture/probe-control", {
    adapterId: "agy",
    behavior: "ok",
    catalog: true,
  });
  await drawer.locator("summary", { hasText: "已检测工具与授权状态" }).click();
  // The drawer rereads defaults only after the catalog operation commits.
  const reloaded = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/settings/model-defaults") &&
      response.request().method() === "GET",
  );
  await drawer
    .locator(".ms-tool-row")
    .filter({ hasText: "Antigravity CLI" })
    .getByRole("button", { name: "刷新" })
    .click();
  const reloadedResponse = await reloaded;
  expect(reloadedResponse.ok(), await reloadedResponse.text()).toBeTruthy();
  await expect(exactLabel(drawer, "规划工具模型搜索")).toHaveValue(
    /gpt-5\.6-sol/,
  );
  await expect(drawer).not.toContainText("草稿已丢失");
});

test("E2E-R23 其他页面改了默认时提示冲突不覆盖草稿", async ({ page }) => {
  const state = fixtureState();
  await fixturePost(page, "/__fixture/probe-control", {
    behavior: "ok",
    adapterId: "codex",
  });
  await fixturePost(page, "/__fixture/restore-access");
  await page.goto("/");
  await page.getByRole("button", { name: "全局模型设置" }).click();
  const drawer = page.getByRole("dialog", { name: "工具与模型" });
  await pickListedModel(drawer, "规划工具", "gpt-5.6-sol");
  const origin = `http://localhost:${process.env.E2E_PORT || "14811"}`;
  const current = await page.request.get("/api/settings/model-defaults", {
    headers: { Origin: origin },
  });
  expect(current.ok(), await current.text()).toBeTruthy();
  const data = await current.json();
  const defaults = data.defaults ?? data;
  const put = await page.request.put("/api/settings/model-defaults", {
    headers: {
      Origin: origin,
      "content-type": "application/json",
    },
    data: {
      request_id: crypto.randomUUID(),
      expected_defaults_revision: defaults.revision,
      planner_profile: {
        ...defaults.plannerProfile,
        adapterId: "codex",
        executableRef: state.probeCli,
        modelSelection: "explicit",
        modelId: "gpt-5.6-luna",
        reasoning: { mode: "explicit", value: "medium" },
      },
      executor_profile: {
        ...defaults.executorProfile,
        executableRef: state.probeCli,
      },
    },
  });
  expect(put.ok(), await put.text()).toBeTruthy();
  await fixturePost(page, "/__fixture/probe-control", {
    adapterId: "agy",
    behavior: "ok",
    catalog: true,
  });
  await drawer.locator("summary", { hasText: "已检测工具与授权状态" }).click();
  // The drawer rereads defaults only after the catalog operation commits.
  const reloaded = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/settings/model-defaults") &&
      response.request().method() === "GET",
  );
  await drawer
    .locator(".ms-tool-row")
    .filter({ hasText: "Antigravity CLI" })
    .getByRole("button", { name: "刷新" })
    .click();
  const reloadedResponse = await reloaded;
  expect(reloadedResponse.ok(), await reloadedResponse.text()).toBeTruthy();
  await expect(drawer.getByRole("alert")).toContainText("当前草稿已保留", {
    timeout: 15000,
  });
  await expect(exactLabel(drawer, "规划工具模型搜索")).toHaveValue(
    /gpt-5\.6-sol/,
  );
});

test("E2E-R22 长验证不在 16 秒误报失败", async ({ page }) => {
  test.setTimeout(90000);
  const state = fixtureState();
  await fixturePost(page, "/__fixture/probe-control", {
    behavior: "ok",
    adapterId: "codex",
    delayMs: 20000,
  });
  await page.goto("/");
  await page.getByRole("button", { name: "全局模型设置" }).click();
  const drawer = page.getByRole("dialog", { name: "工具与模型" });
  const planner = drawer.locator(".ms-editor").first();
  await planner.getByText("高级选项").click();
  await exactLabel(planner, "规划工具实际 CLI").fill(state.probeCli);
  await planner.getByRole("button", { name: "重新验证" }).click();
  await expect(planner.locator(".ms-access")).toContainText("正在验证");
  await page.waitForTimeout(16500);
  await expect(planner.locator(".ms-access")).toContainText("正在验证");
  await expect(planner.locator(".ms-access")).not.toContainText("验证暂时失败");
  await waitAccessStatus(planner, "已验证可访问");
  await fixturePost(page, "/__fixture/probe-control", {
    behavior: "ok",
    adapterId: "codex",
    delayMs: 0,
  });
});

test("E2E-R24 verified 后重新验证 force=true，普通再保存不重复探针", async ({
  page,
}) => {
  const state = fixtureState();
  await fixturePost(page, "/__fixture/probe-control", {
    behavior: "ok",
    adapterId: "codex",
    delayMs: 0,
  });
  await page.goto("/");
  await page.getByRole("button", { name: "全局模型设置" }).click();
  const drawer = page.getByRole("dialog", { name: "工具与模型" });
  const planner = drawer.locator(".ms-editor").first();
  await pickListedModel(drawer, "规划工具", "gpt-6-astra");
  await waitAccessStatus(planner, "已验证可访问");
  await planner.getByText("高级选项").click();
  await exactLabel(planner, "规划工具实际 CLI").fill(state.probeCli);
  const verifyBodies: Record<string, unknown>[] = [];
  page.on("request", (request) => {
    if (
      request.url().includes("/api/model-access/verify") &&
      request.method() === "POST"
    ) {
      verifyBodies.push(request.postDataJSON() as Record<string, unknown>);
    }
  });
  const before = await fixtureProbeCount(page);
  await planner.getByRole("button", { name: "重新验证" }).click();
  await waitAccessStatus(planner, "已验证可访问");
  const forced = verifyBodies.filter((item) => item.force === true);
  expect(forced.length).toBeGreaterThan(0);
  expect(await fixtureProbeCount(page)).toBeGreaterThan(before);
  const afterForce = await fixtureProbeCount(page);
  await drawer.getByRole("button", { name: /保存默认配置/ }).click();
  await expect(drawer.locator(".ms-success")).toContainText("默认配置已保存", {
    timeout: 15000,
  });
  await expect(drawer.locator(".ms-error")).toHaveCount(0);
  expect(await fixtureProbeCount(page)).toBe(afterForce);
});

test("手工输入只在确认完整模型 ID 后验证", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "全局模型设置" }).click();
  const drawer = page.getByRole("dialog", { name: "工具与模型" });
  const planner = drawer.locator(".ms-editor").first();
  await expect(planner.getByLabel("规划工具模型搜索")).toBeEnabled();
  const candidates: string[] = [];
  await page.route("**/api/model-access/verify", async (route) => {
    const body = route.request().postDataJSON();
    if (String(body.profile.modelId).startsWith("manual-"))
      candidates.push(body.profile.modelId);
    await route.fulfill({ json: { status: "verified" } });
  });
  await planner.getByText("高级选项").click();
  const input = planner.getByLabel("规划工具原始模型 ID");
  await input.fill("manual-");
  await input.pressSequentially("complete-model");
  expect(candidates).toEqual([]);
  await input.press("Enter");
  await expect.poll(() => candidates).toEqual(["manual-complete-model"]);
  await input.blur();
  expect(candidates).toEqual(["manual-complete-model"]);
});

test("安装待验证草稿会预填设置并明确标注", async ({ page }) => {
  await page.route("**/api/settings/model-defaults", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    const defaults = body.defaults ?? body;
    await route.fulfill({
      response,
      json: {
        ...body,
        pending_draft: {
          schema_version: 1,
          expected_defaults_revision: defaults.revision,
          plannerProfile: {
            ...defaults.plannerProfile,
            modelId: "installer-pending-model",
          },
          executorProfile: defaults.executorProfile,
        },
      },
    });
  });
  await page.route("**/api/model-access/verify", (route) =>
    route.fulfill({ json: { status: "verified" } }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "全局模型设置" }).click();
  const drawer = page.getByRole("dialog", { name: "工具与模型" });
  await expect(drawer).toContainText("已载入安装时选择的待验证配置");
  await expect(
    drawer.getByLabel("规划工具模型搜索", { exact: true }),
  ).toHaveValue("installer-pending-model");
});
