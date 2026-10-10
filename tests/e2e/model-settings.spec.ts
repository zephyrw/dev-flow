import { test, expect } from "@playwright/test";
import type { ModelEntry, ToolProfile } from "../../packages/contracts/src/index.js";
import {
  exactLabel,
  executionSpec,
  fixturePost,
  fixtureProbeCount,
  fixtureState,
  pickListedModel,
  testInstance,
  waitAccessStatus,
  workflowDetail,
} from "./native-helper.js";

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("devflow.first_run_completed", "true");
  });
});

test("E2E-U01 无任务也可打开全局设置并编辑两套默认", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "任务总览" })).toBeVisible();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "设置" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("tab", { name: "默认模型" })).toBeVisible();
  await expect(dialog.getByRole("tab", { name: "规划" })).toBeVisible();
  await expect(dialog.getByRole("tab", { name: "执行" })).toBeVisible();
  await expect(dialog.getByRole("tab", { name: "复核" })).toBeVisible();
  await expect(exactLabel(dialog, "工具")).toBeEnabled();
  await dialog.getByRole("tab", { name: "执行" }).click();
  await expect(exactLabel(dialog, "工具")).toBeEnabled();
});

test("E2E-U02 修改全局默认后新建任务预填新值", async ({ page }) => {
  test.setTimeout(90000);
  const initial = await page.request.get("/api/settings/model-defaults");
  expect(initial.ok(), await initial.text()).toBeTruthy();
  const before = (await initial.json()).defaults;
  await page.goto("/");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "设置" });
  await dialog.getByRole("tab", { name: "规划" }).click();
  await exactLabel(dialog, "工具").selectOption("codex");
  await pickListedModel(dialog, "工具", "gpt-5.6-sol");
  await dialog.getByRole("tab", { name: "执行" }).click();
  await exactLabel(dialog, "工具").selectOption("agy");
  await pickListedModel(dialog, "工具", "gemini-3.8-flash-high");
  await waitAccessStatus(dialog.locator(".ms-editor"), "已验证可访问");
  expect(before.plannerProfile.modelId).not.toBe("gpt-5.6-sol");
  await dialog.getByRole("button", { name: "保存配置" }).click();
  await expect(dialog).not.toBeVisible({ timeout: 15000 });
  const response = await page.request.get("/api/settings/model-defaults");
  expect(response.ok(), await response.text()).toBeTruthy();
  const saved = (await response.json()).defaults;
  expect(saved.revision).toBe(before.revision + 1);
  expect(saved.plannerProfile.modelId).toBe("gpt-5.6-sol");
  expect(saved.executorProfile.modelId).toBe("gemini-3.8-flash-high");
  // Exercise both completion orders. In particular, a catalog may select its
  // seed before saved defaults arrive, or arrive after the saved profile.
  for (const delayed of ["defaults", "catalog"] as const) {
    const defaultsPath = "/api/settings/model-defaults";
    const catalogPath = "/api/model-tools/codex/models";
    const delayedPath = delayed === "defaults" ? defaultsPath : catalogPath;
    const fastPath = delayed === "defaults" ? catalogPath : defaultsPath;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route("**" + delayedPath, async route => {
      const response = await route.fetch();
      await gate;
      await route.fulfill({ response });
    });
    const fastResponse = page.waitForResponse(response => new URL(response.url()).pathname === fastPath && response.request().method() === "GET");
    const delayedResponse = page.waitForResponse(response => new URL(response.url()).pathname === delayedPath && response.request().method() === "GET");
    try {
      await page.getByRole("button", { name: "+ 新建", exact: true }).click();
      const modal = page.locator(".modal-backdrop").last();
      await expect(modal).toContainText("来自系统默认");
      await modal.getByRole("tab", { name: "规划", exact: true }).click();
      const fast = await fastResponse;
      expect(fast.ok(), await fast.text()).toBe(true);
      if (delayed === "defaults") {
        const catalog = await fast.json();
        const entries: ModelEntry[] = catalog.entries ?? catalog.catalog?.entries;
        const usable = entries.filter(entry => !entry.hidden && entry.availability !== "unavailable");
        const catalogDefault = usable.find(entry => entry.source === "native-config") ?? usable[0];
        expect(catalogDefault?.nativeId).not.toBe(saved.plannerProfile.modelId);
        await expect(exactLabel(modal, "工具模型搜索")).toHaveValue(catalogDefault!.label);
      } else {
        expect((await fast.json()).defaults).toEqual(saved);
        await expect(exactLabel(modal, "工具模型搜索")).toHaveValue(/gpt-5\.6-sol|GPT-5\.6 Sol/i);
      }
      release();
      const late = await delayedResponse;
      expect(late.ok(), await late.text()).toBe(true);
      if (delayed === "defaults") expect((await late.json()).defaults).toEqual(saved);
      await expect(exactLabel(modal, "工具")).toHaveValue("codex");
      await expect(exactLabel(modal, "工具模型搜索")).toHaveValue(/gpt-5\.6-sol|GPT-5\.6 Sol/i);
      await modal.getByRole("tab", { name: "执行" }).click();
      await expect(exactLabel(modal, "工具")).toHaveValue("agy");
      await expect(exactLabel(modal, "工具模型搜索")).toHaveValue(/gemini-3\.8-flash|Gemini 3\.8 Flash/i);
      if (delayed === "defaults") await modal.locator(".ms-head button").click();
    } finally {
      release();
      await page.unroute("**" + delayedPath);
    }
  }
  const modal = page.locator(".modal-backdrop").last();
  await modal.getByLabel("工作区真实路径").fill(fixtureState().nativeRepo);
  await modal.locator("textarea").fill("U02 保存默认配置后的真实派发");
  const created = page.waitForResponse(response => response.url().endsWith("/api/workflows") && response.request().method() === "POST");
  await modal.getByRole("button", { name: "创建并开始规划" }).click();
  const createResponse = await created;
  expect(createResponse.status(), await createResponse.text()).toBe(200);
  const id = (await createResponse.json()).workflow.id;
  const spec = await executionSpec(page, id);
  expect(spec.spec.plannerProfile).toMatchObject({ adapterId: saved.plannerProfile.adapterId,
    modelId: saved.plannerProfile.modelId, reasoning: saved.plannerProfile.reasoning });
  expect(spec.spec.executorProfile).toMatchObject({ adapterId: saved.executorProfile.adapterId,
    modelId: saved.executorProfile.modelId, reasoning: saved.executorProfile.reasoning });
  await expect.poll(async () => (await workflowDetail(page, id)).runs?.[0]?.profile, { timeout: 25000 })
    .toMatchObject({ adapterId: saved.plannerProfile.adapterId, modelId: saved.plannerProfile.modelId, reasoning: saved.plannerProfile.reasoning });
});

test("E2E-U04 高级项只改 reviewer 时其余保持继承", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "+ 新建", exact: true }).click();
  const modal = page.locator(".modal-backdrop").last();
  await modal.getByRole("tab", { name: "代码审查" }).click();
  await expect(modal.getByRole("radio", { name: /同规划/ })).toBeChecked();
  await modal.getByRole("radio", { name: /单独选择/ }).check();
  await expect(exactLabel(modal, "工具")).toBeVisible();
});

test("E2E-U12 快速切换工具会清掉旧模型并选中新工具默认模型", async ({ page }) => {
  const defaultsResponse = await page.request.get("/api/settings/model-defaults");
  expect(defaultsResponse.ok(), await defaultsResponse.text()).toBe(true);
  const savedDefaults = (await defaultsResponse.json()).defaults;
  const catalogResponse = await page.request.get("/api/model-tools/codex/models");
  expect(catalogResponse.ok(), await catalogResponse.text()).toBe(true);
  const catalog = await catalogResponse.json();
  // Tool switching resets the profile and selects the catalog's first usable
  // choice, prioritizing native-config entries. It does not restore the edited
  // global planner default saved in U02.
  const entries: ModelEntry[] = catalog.entries ?? catalog.catalog?.entries;
  const usableEntries = entries.filter(entry => !entry.hidden && entry.availability !== "unavailable");
  const defaultEntry = usableEntries.find(entry => entry.source === "native-config") ?? usableEntries[0];
  if (!defaultEntry) throw new Error("Codex fixture catalog has no usable default model");
  const expectedEffort = defaultEntry.effort.defaultValue;
  const expectedModelId = expectedEffort
    ? defaultEntry.effort.variants?.[expectedEffort] ?? defaultEntry.nativeId
    : defaultEntry.nativeId;
  expect(savedDefaults.plannerProfile.modelId).not.toBe(expectedModelId);
  const verifiedProfiles: ToolProfile[] = [];
  page.on("request", request => {
    if (request.url().endsWith("/api/model-access/verify") && request.method() === "POST")
      verifiedProfiles.push(request.postDataJSON().profile);
  });
  await page.goto("/");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "设置" });
  await dialog.getByRole("tab", { name: "规划" }).click();
  const planner = exactLabel(dialog, "工具");
  await planner.selectOption("codex");
  await planner.selectOption("agy");
  await planner.selectOption("codex");
  await expect(exactLabel(dialog, "工具模型搜索")).toHaveValue(defaultEntry.label);
  await waitAccessStatus(dialog.locator(".ms-editor"), "已验证可访问");
  expect(verifiedProfiles.at(-1)).toMatchObject({ adapterId: "codex", modelId: expectedModelId,
    reasoning: { mode: "explicit", value: expectedEffort } });
  await expect(planner.locator("option")).toHaveCount(2);
  const unchangedDefaults = await page.request.get("/api/settings/model-defaults");
  expect(unchangedDefaults.ok(), await unchangedDefaults.text()).toBe(true);
  expect((await unchangedDefaults.json()).defaults).toEqual(savedDefaults);
});

test("E2E-U13 历史模型不在目录时保留并标注", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "设置" });
  await dialog.getByRole("tab", { name: "规划" }).click();
  const searchInput = exactLabel(dialog, "工具模型搜索");
  await searchInput.click();
  await searchInput.fill("historical-model-not-listed");
  const customOption = page.getByRole("option").filter({ hasText: "使用自定义模型: historical-model-not-listed" });
  await expect(customOption).toBeVisible();
  await customOption.click();
  await expect(searchInput).toHaveValue("historical-model-not-listed");
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
  await page.getByRole("button", { name: "设置", exact: true }).focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "设置" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("tab", { name: "规划" }).click();
  const toolSelect = exactLabel(dialog, "工具");
  await toolSelect.focus();
  await expect(toolSelect).toBeFocused();
  await page.keyboard.press("Tab");
  const planner = dialog.locator(".ms-editor").first();
  await expect(planner.locator(".ms-error")).toContainText("夹具目录暂不可用");
  const failures = catalogRequests;
  catalogueAvailable = true;
  await planner.getByRole("button", { name: "重试", exact: true }).click();
  await expect(planner.locator(".ms-error")).toHaveCount(0);
  await pickListedModel(planner, "工具", "gpt-6-astra");
  expect(catalogRequests).toBeGreaterThan(failures);
  await expect(exactLabel(planner, "工具模型搜索")).toHaveValue(
    /gpt-6-astra|GPT-6 Astra/i,
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
  await modal.getByRole("tab", { name: "规划" }).click();
  await pickListedModel(modal, "工具", "gpt-5.6-sol");
  await exactLabel(modal, "工具思考强度").selectOption("xhigh");
  await waitAccessStatus(modal.locator(".ms-editor"), "已验证可访问");
  await modal.getByRole("tab", { name: "执行" }).click();
  await exactLabel(modal, "工具").selectOption("agy");
  await pickListedModel(modal, "工具", "gemini-3.8-flash-high");
  await waitAccessStatus(modal.locator(".ms-editor"), "已验证可访问");
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
    adapterId: "agy",
    modelId: "gemini-3.8-flash-high",
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
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "设置" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("tab", { name: "规划" }).click();
  await pickListedModel(dialog, "工具", "gpt-6-astra");
  await waitAccessStatus(dialog.locator(".ms-editor").first(), "已验证可访问");
  await expect(page.getByRole("dialog", { name: /登录|验证访问/ })).toHaveCount(
    0,
  );
  await expect(dialog.getByText("需要登录该工具")).toHaveCount(0);
  expect(await fixtureProbeCount(page)).toBe(before);
});

test("E2E-U10 首次验证失败准确错误与草稿不丢", async ({ page }) => {
  const state = fixtureState();
  await fixturePost(page, "/__fixture/probe-control", {
    behavior: "login",
    adapterId: "codex",
  });
  await page.goto("/");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "设置" });
  await dialog.getByRole("tab", { name: "规划" }).click();
  const planner = dialog.locator(".ms-editor").first();
  const searchInput = exactLabel(planner, "工具模型搜索");
  await pickListedModel(planner, "工具", "codex-login-required-model");
  await expect(planner.locator(".ms-access")).toContainText(/登录|验证未通过/, {
    timeout: 20000,
  });
  await expect(planner.getByRole("button", { name: "重新验证" })).toBeVisible();
  await expect(searchInput).toHaveValue(
    /Login Required|codex-login-required-model/,
  );
  await fixturePost(page, "/__fixture/probe-control", {
    behavior: "ok",
    adapterId: "codex",
  });
  await fixturePost(page, "/__fixture/restore-access");
});

test("E2E-R23 编辑后刷新目录草稿保持", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "设置" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("tab", { name: "规划" }).click();
  await pickListedModel(dialog, "工具", "gpt-5.6-sol");
  await fixturePost(page, "/__fixture/probe-control", {
    adapterId: "codex",
    behavior: "ok",
    catalog: true,
  });
  await dialog.getByTitle("刷新模型目录").click();
  await expect(exactLabel(dialog, "工具模型搜索")).toHaveValue(
    /gpt-5\.6-sol|GPT-5\.6 Sol/i,
  );
});

test("E2E-R23 其他页面改了默认时提示冲突不覆盖草稿", async ({ page }) => {
  const state = fixtureState();
  await fixturePost(page, "/__fixture/probe-control", {
    behavior: "ok",
    adapterId: "codex",
  });
  await fixturePost(page, "/__fixture/restore-access");
  await page.goto("/");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "设置" });
  await dialog.getByRole("tab", { name: "规划" }).click();
  await pickListedModel(dialog, "工具", "gpt-5.6-sol");
  const origin = testInstance().humanOrigin;
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
  const saveResponse = page.waitForResponse(response =>
    response.url().endsWith("/api/settings/model-defaults") && response.request().method() === "PUT");
  await dialog.getByRole("button", { name: "保存配置" }).click();
  const conflict = await saveResponse;
  expect(conflict.status()).toBe(409);
  expect(await conflict.json()).toMatchObject({ error: { code: "DEFAULTS_VERSION_CONFLICT" } });
  await expect(dialog.locator('.ms-error-bar[role="alert"]')).toContainText("全局默认配置已在其他位置更新", {
    timeout: 15000,
  });
  await expect(exactLabel(dialog, "工具模型搜索")).toHaveValue(
    /gpt-5\.6-sol|GPT-5\.6 Sol/i,
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
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "设置" });
  await dialog.getByRole("tab", { name: "规划" }).click();
  const planner = dialog.locator(".ms-editor").first();
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
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "设置" });
  await dialog.getByRole("tab", { name: "规划" }).click();
  const planner = dialog.locator(".ms-editor").first();
  await pickListedModel(dialog, "工具", "gpt-6-astra");
  await waitAccessStatus(planner, "已验证可访问");
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
  await dialog.getByRole("button", { name: "保存配置" }).click();
  await expect(dialog).not.toBeVisible({ timeout: 15000 });
  expect(await fixtureProbeCount(page)).toBe(afterForce);
});

test("手工输入只在确认完整模型 ID 后验证", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "设置" });
  await dialog.getByRole("tab", { name: "规划" }).click();
  const planner = dialog.locator(".ms-editor").first();
  const searchInput = exactLabel(planner, "工具模型搜索");
  await expect(searchInput).toBeEnabled();
  const candidates: string[] = [];
  await page.route("**/api/model-access/verify", async (route) => {
    const body = route.request().postDataJSON();
    if (String(body.profile.modelId).startsWith("manual-"))
      candidates.push(body.profile.modelId);
    await route.fulfill({ json: { status: "verified" } });
  });
  await searchInput.click();
  await searchInput.fill("manual-");
  await searchInput.pressSequentially("complete-model");
  expect(candidates).toEqual([]);
  await searchInput.press("Enter");
  await expect.poll(() => candidates).toEqual(["manual-complete-model"]);
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
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "设置" });
  await expect(dialog).toContainText("已载入安装时选择的待验证配置");
  await expect(
    dialog.getByLabel("工具模型搜索", { exact: true }),
  ).toHaveValue("installer-pending-model");
});
