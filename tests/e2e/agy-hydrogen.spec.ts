import { test, expect, type Locator, type Page } from "@playwright/test";
import {
  dismissFirstRun,
  exactLabel,
  executionSpec,
  fixturePost,
  fixtureState,
  openFixtureWorkflow,
  openTaskModels,
  repairBatches,
  showExecutionSidebar,
  workflowDetail,
} from "./native-helper.js";

test.describe.configure({ mode: "serial" });

const GROUP_MEMBER_LIST = (page: Page) =>
  page.getByRole("list", { name: "模型成员", exact: true });

async function setAgyHydrogenCatalog(
  page: Page,
  mode: "supported" | "empty" | "fail" | "default",
) {
  return fixturePost(page, "/__fixture/agy-hydrogen-catalog", { mode });
}

async function selectHydrogenAndVerifyEfforts(
  root: Locator,
  toolLabel: string,
) {
  const toolSelect = exactLabel(root, toolLabel);
  await expect(toolSelect).toBeEnabled({ timeout: 20000 });
  await toolSelect.selectOption("agy");

  const search = exactLabel(root, `${toolLabel}模型搜索`);
  await expect(search).toBeEnabled({ timeout: 20000 });
  await search.click();
  await search.fill("Gemini 4 Hydrogen");

  const listbox = root.page().getByRole("listbox", { name: "模型选项列表" });
  await expect(listbox).toBeVisible({ timeout: 15000 });
  const option = listbox
    .locator('[role="option"]:not(.ms-custom-option)')
    .filter({ hasText: "Gemini 4 Hydrogen" })
    .first();
  await expect(option).toBeVisible({ timeout: 15000 });
  await option.click();

  const effortSelect = exactLabel(root, `${toolLabel}思考强度`);
  await expect(effortSelect).toBeVisible({ timeout: 15000 });
  // 初次选中 Gemini 4 Hydrogen 自动默认选中 High
  await expect(effortSelect).toHaveValue("high");
  // 验证四档名称与显示顺序：默认 + Low / Medium / High / Extra
  await expect(effortSelect.locator("option")).toHaveText([
    "默认",
    "Low",
    "Medium",
    "High",
    "Extra",
  ]);
  await expect(
    effortSelect.locator("option").evaluateAll((nodes) =>
      nodes.map((node) => (node as HTMLOptionElement).value),
    ),
  ).resolves.toEqual(["default", "low", "medium", "high", "xhigh"]);

  await effortSelect.selectOption("xhigh");
  await expect(effortSelect).toHaveValue("xhigh");
  await expect(effortSelect.locator("option:checked")).toHaveText("Extra");
}

let initialDefaults: {
  plannerProfile: Record<string, unknown>;
  executorProfile: Record<string, unknown>;
  reviewerBinding?: Record<string, unknown>;
  revision: number;
} | null = null;

test.beforeEach(async ({ page }) => {
  await dismissFirstRun(page);
});

test.afterEach(async ({ page }) => {
  await setAgyHydrogenCatalog(page, "default").catch(() => undefined);
});

test.afterAll(async ({ request, baseURL }) => {
  if (!initialDefaults) return;
  try {
    const current = await request.get("/api/settings/model-defaults");
    if (!current.ok()) return;
    const latest = (await current.json()).defaults;
    await request.put("/api/settings/model-defaults", {
      headers: {
        Origin: baseURL!,
        "content-type": "application/json",
      },
      data: {
        request_id: crypto.randomUUID(),
        expected_defaults_revision: latest.revision,
        planner_profile: initialDefaults.plannerProfile,
        executor_profile: initialDefaults.executorProfile,
        ...(initialDefaults.reviewerBinding
          ? { reviewer_binding: initialDefaults.reviewerBinding }
          : {}),
      },
    });
  } catch {}
});

test("A07 共用入口在支持账号下完整支持 Hydrogen 四档、默认 High、Extra 保存恢复及角色/切换/整改", async ({
  page,
}) => {
  test.setTimeout(180000);
  if (!initialDefaults) {
    const res = await page.request.get("/api/settings/model-defaults");
    expect(res.ok(), await res.text()).toBeTruthy();
    initialDefaults = (await res.json()).defaults;
  }

  await setAgyHydrogenCatalog(page, "supported");
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "任务总览", exact: true })).toBeVisible();

  // 1. 全局默认设置（规划 & 执行）
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const settingsDialog = page.getByRole("dialog", { name: "设置" });
  await expect(settingsDialog).toBeVisible();
  await settingsDialog.getByRole("tab", { name: "规划", exact: true }).click();
  await selectHydrogenAndVerifyEfforts(settingsDialog, "工具");
  await settingsDialog.getByRole("tab", { name: "执行", exact: true }).click();
  await selectHydrogenAndVerifyEfforts(settingsDialog, "工具");
  await settingsDialog.getByRole("button", { name: "保存配置", exact: true }).click();
  await expect(settingsDialog).not.toBeVisible({ timeout: 20000 });

  const defaultsRes = await page.request.get("/api/settings/model-defaults");
  expect(defaultsRes.ok(), await defaultsRes.text()).toBeTruthy();
  const savedDefaults = (await defaultsRes.json()).defaults;
  expect(savedDefaults.plannerProfile).toMatchObject({
    adapterId: "agy",
    modelId: "gemini-4-hydrogen-xhigh",
    reasoning: { mode: "explicit", value: "xhigh" },
  });
  expect(savedDefaults.executorProfile).toMatchObject({
    adapterId: "agy",
    modelId: "gemini-4-hydrogen-xhigh",
    reasoning: { mode: "explicit", value: "xhigh" },
  });

  // 刷新页面重开设置验证恢复显示为 Gemini 4 Hydrogen + Extra
  await page.reload();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const reopenedSettings = page.getByRole("dialog", { name: "设置" });
  await reopenedSettings.getByRole("tab", { name: "规划", exact: true }).click();
  await expect(exactLabel(reopenedSettings, "工具")).toHaveValue("agy");
  await expect(exactLabel(reopenedSettings, "工具模型搜索")).toHaveValue(
    "Gemini 4 Hydrogen",
  );
  await expect(exactLabel(reopenedSettings, "工具思考强度")).toHaveValue("xhigh");
  await reopenedSettings.getByRole("button", { name: "取消", exact: true }).click();
  await expect(reopenedSettings).not.toBeVisible();

  // 2. 新建任务入口继承并可提交 Gemini 4 Hydrogen Extra
  await page.getByRole("button", { name: "+ 新建", exact: true }).click();
  const createModal = page.locator(".modal-backdrop").last();
  await createModal.getByRole("tab", { name: "规划", exact: true }).click();
  await expect(exactLabel(createModal, "工具")).toHaveValue("agy");
  await expect(exactLabel(createModal, "工具模型搜索")).toHaveValue(
    "Gemini 4 Hydrogen",
  );
  await expect(exactLabel(createModal, "工具思考强度")).toHaveValue("xhigh");
  // 验证可改 High 再选回 Extra
  await exactLabel(createModal, "工具思考强度").selectOption("high");
  await exactLabel(createModal, "工具思考强度").selectOption("xhigh");

  const state = fixtureState();
  await createModal.getByLabel("任务名称", { exact: true }).fill("Hydrogen 新建验收");
  await createModal.getByLabel("工作区真实路径").fill(state.nativeRepo);
  await createModal
    .locator('input[name="workspaceMode"][value="existing_workspace"]')
    .check();
  await createModal.locator("textarea").fill("验证新建任务保存 Hydrogen Extra");
  const createWait = page.waitForResponse(
    (r) => r.url().endsWith("/api/workflows") && r.request().method() === "POST",
  );
  await createModal.getByRole("button", { name: "创建并开始规划" }).click();
  const createdRes = await createWait;
  expect(createdRes.status(), await createdRes.text()).toBe(200);
  const createdWorkflow = (await createdRes.json()).workflow;
  const createdSpec = await executionSpec(page, createdWorkflow.id);
  expect(createdSpec.spec.plannerProfile).toMatchObject({
    adapterId: "agy",
    modelId: "gemini-4-hydrogen-xhigh",
    reasoning: { mode: "explicit", value: "xhigh" },
  });
  expect(createdSpec.spec.executorProfile).toMatchObject({
    adapterId: "agy",
    modelId: "gemini-4-hydrogen-xhigh",
    reasoning: { mode: "explicit", value: "xhigh" },
  });

  // 3. 任务配置（工具与模型）：规划/执行保存与重开恢复
  const wfId = await openFixtureWorkflow(page);
  const drawer = await openTaskModels(page, "执行");
  await selectHydrogenAndVerifyEfforts(drawer, "工具");
  await drawer.getByRole("button", { name: /^(保存|保存供后续使用)$/ }).click();
  await expect(drawer).not.toBeVisible({ timeout: 20000 });

  const updatedSpec = await executionSpec(page, wfId);
  expect(updatedSpec.spec.executorProfile).toMatchObject({
    adapterId: "agy",
    modelId: "gemini-4-hydrogen-xhigh",
    reasoning: { mode: "explicit", value: "xhigh" },
  });
  const reopenedDrawer = await openTaskModels(page, "执行");
  await expect(exactLabel(reopenedDrawer, "工具")).toHaveValue("agy");
  await expect(exactLabel(reopenedDrawer, "工具模型搜索")).toHaveValue(
    "Gemini 4 Hydrogen",
  );
  await expect(exactLabel(reopenedDrawer, "工具思考强度")).toHaveValue("xhigh");
  await reopenedDrawer.getByRole("button", { name: "取消", exact: true }).click();
  await expect(reopenedDrawer).not.toBeVisible();

  // 4. 审查时模型切换并继续
  const reviewSeeded = await fixturePost(page, "/__fixture/enter-review", {
    phase: "before_human",
  });
  await openFixtureWorkflow(page);
  const switchDialog = await openTaskModels(page, "规划");
  await selectHydrogenAndVerifyEfforts(switchDialog, "工具");
  const switchPromise = page.waitForResponse(
    (r) =>
      r.url().endsWith("/model-switch") && r.request().method() === "POST",
  );
  await switchDialog.getByRole("button", { name: "切换并继续", exact: true }).click();
  const switchRes = await switchPromise;
  expect(switchRes.ok(), await switchRes.text()).toBeTruthy();
  expect(switchRes.request().postDataJSON()).toMatchObject({
    expected_run_id: reviewSeeded.run_id,
    resume_after_switch: true,
    planner_profile: {
      adapterId: "agy",
      modelId: "gemini-4-hydrogen-xhigh",
      reasoning: { mode: "explicit", value: "xhigh" },
    },
  });
  await expect(switchDialog).not.toBeVisible({ timeout: 30000 });
  await expect
    .poll(async () => (await workflowDetail(page, wfId)).workflow, {
      timeout: 30000,
    })
    .toMatchObject({ state: "REVIEWING", stage: "quality_before_human" });

  // 5. 整改修复选择（RepairModelPicker）与任务角色覆盖（功能修复 tab）
  const retestSeeded = await fixturePost(page, "/__fixture/seed-retest");
  await expect
    .poll(
      async () =>
        (await workflowDetail(page, String(retestSeeded.workflow_id))).workflow
          .state,
    )
    .toBe("HUMAN_PENDING");
  await openFixtureWorkflow(page);
  await openTaskModels(page);
  const retestCard = page
    .getByLabel("任务反馈记录")
    .locator("article")
    .filter({ hasText: String(retestSeeded.first_description) })
    .filter({ hasText: "等待你复测" })
    .first();
  await retestCard.getByText("本次修复由谁处理").click();
  await retestCard.getByLabel("自定义工具/模型").check();
  await selectHydrogenAndVerifyEfforts(retestCard, "修复工具");
  await retestCard.getByLabel("同时设为该任务后续人工问题修复默认值").check();
  const repairReqPromise = page.waitForRequest(
    (req) =>
      req.url().includes("/functional-issues/") &&
      req.url().endsWith("/confirm") &&
      req.method() === "POST",
  );
  await retestCard.getByRole("button", { name: "仍有问题，继续修复" }).click();
  const repairReq = await repairReqPromise;
  expect(repairReq.postDataJSON()).toMatchObject({
    batch_id: retestSeeded.batch_id,
    repair_model: {
      mode: "custom",
      profile: {
        adapterId: "agy",
        modelId: "gemini-4-hydrogen-xhigh",
        reasoning: { mode: "explicit", value: "xhigh" },
      },
    },
  });
  await expect
    .poll(async () => {
      const batches = await repairBatches(page, String(retestSeeded.workflow_id));
      return batches[0]?.assignment?.profile;
    })
    .toMatchObject({
      adapterId: "agy",
      modelId: "gemini-4-hydrogen-xhigh",
      reasoning: { mode: "explicit", value: "xhigh" },
    });

  // 关闭当前任务模型窗口后再重开，验证“功能修复”角色覆盖 tab 恢复为 Gemini 4 Hydrogen + Extra
  await page
    .getByRole("dialog", { name: "工具与模型", exact: true })
    .getByRole("button", { name: "取消", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (await executionSpec(page, String(retestSeeded.workflow_id))).spec
          ?.roleOverrides?.functional_fixer,
      { timeout: 20000 },
    )
    .toMatchObject({
      mode: "explicit",
      profile: {
        adapterId: "agy",
        modelId: "gemini-4-hydrogen-xhigh",
        reasoning: { mode: "explicit", value: "xhigh" },
      },
    });
  const overrideDialog = await openTaskModels(page, "规划");
  await overrideDialog.getByRole("tab", { name: "功能修复", exact: true }).click();
  await expect(overrideDialog.getByLabel("单独选择")).toBeChecked();
  await expect(exactLabel(overrideDialog, "工具模型搜索")).toHaveValue(
    "Gemini 4 Hydrogen",
  );
  await expect(exactLabel(overrideDialog, "工具思考强度")).toHaveValue("xhigh");
  await overrideDialog.getByRole("button", { name: "取消", exact: true }).click();
});

test("A07 群聊独立选择器在支持账号下选 Hydrogen 四档、默认 High、Extra 保存重开恢复与成员同步保留", async ({
  page,
  request,
  baseURL,
}) => {
  test.setTimeout(90000);
  await setAgyHydrogenCatalog(page, "supported");

  const groupTitle = `Hydrogen 群聊验收-${Date.now()}`;
  await page.goto("/group-chat");
  await page.getByRole("button", { name: "新建群聊" }).click();
  await page.getByLabel("群名称").fill(groupTitle);
  await page.getByRole("button", { name: "新增成员", exact: true }).click();

  const editor = page.getByRole("dialog", { name: "新增成员", exact: true });
  await editor.getByLabel("成员昵称").fill("氢气成员");
  await editor.getByLabel("接入工具").selectOption("agy");

  const modelSelect = editor.getByLabel("模型选择");
  await expect(modelSelect).toBeEnabled({ timeout: 15000 });
  const hydrogenOptions = modelSelect.locator("option", {
    hasText: "Gemini 4 Hydrogen",
  });
  await expect(hydrogenOptions).toHaveCount(1);

  await modelSelect.selectOption({ label: "Gemini 4 Hydrogen" });
  const effortSelect = editor.getByLabel("推理强度");
  // 默认 High，选项为 模型默认 + Low / Medium / High / Extra
  await expect(effortSelect).toHaveValue("high");
  await expect(effortSelect.locator("option")).toHaveText([
    "模型默认",
    "Low",
    "Medium",
    "High",
    "Extra",
  ]);
  await effortSelect.selectOption("xhigh");
  await expect(effortSelect).toHaveValue("xhigh");

  await editor.getByRole("button", { name: "添加成员", exact: true }).click();
  await expect(GROUP_MEMBER_LIST(page)).toContainText("氢气成员");

  const createGroupReq = page.waitForRequest(
    (req) => req.url().endsWith("/api/groups") && req.method() === "POST",
  );
  const createGroupRes = page.waitForResponse(
    (res) => res.url().endsWith("/api/groups") && res.request().method() === "POST",
  );
  await page.getByRole("button", { name: "创建群聊" }).click();
  const payload = (await createGroupReq).postDataJSON();
  const hydrogenMemberPayload = payload.members.find(
    (m: { nickname: string }) => m.nickname === "氢气成员",
  );
  expect(hydrogenMemberPayload).toEqual({
    nickname: "氢气成员",
    tool: "agy",
    model: "gemini-4-hydrogen-xhigh",
    effort: "xhigh",
  });
  const createdGroup = await (await createGroupRes).json();
  const groupId = createdGroup.id as string;

  // 刷新整页重开群聊编辑弹窗，校验准确恢复为 Gemini 4 Hydrogen + Extra
  await page.reload();
  const groupCard = page.locator(".gc-group-card", { hasText: groupTitle }).first();
  await groupCard.hover();
  await groupCard.getByRole("button", { name: `编辑群聊 ${groupTitle}`, exact: true }).click();
  const row = GROUP_MEMBER_LIST(page)
    .getByRole("listitem")
    .filter({ hasText: "氢气成员" })
    .first();
  await row.hover();
  await row.getByRole("button", { name: /^编辑成员/ }).click();
  const editDialog = page.getByRole("dialog", { name: "编辑成员", exact: true });
  await expect(editDialog.getByLabel("模型选择").locator("option:checked")).toHaveText(
    /Gemini 4 Hydrogen/,
  );
  await expect(editDialog.getByLabel("推理强度")).toHaveValue("xhigh");
  await expect(
    editDialog.getByLabel("推理强度").locator("option:checked"),
  ).toHaveText("Extra");

  // 建会话并通过 action: "sync" 同步群成员，保留 Hydrogen Extra 不降档不丢失
  const sessRes = await request.post(`/api/groups/${groupId}/sessions`, {
    headers: { Origin: baseURL!, "content-type": "application/json" },
    data: { title: "Hydrogen 同步验证", scene: "open" },
  });
  expect(sessRes.ok(), await sessRes.text()).toBeTruthy();
  const sess = await sessRes.json();
  const syncRes = await request.post(`/api/group-sessions/${sess.id}/actions`, {
    headers: { Origin: baseURL!, "content-type": "application/json" },
    data: {
      version: sess.version,
      request: crypto.randomUUID(),
      input: { action: "sync" },
    },
  });
  expect(syncRes.ok(), await syncRes.text()).toBeTruthy();
  const viewRes = await request.get(`/api/group-sessions/${sess.id}`);
  expect(viewRes.ok(), await viewRes.text()).toBeTruthy();
  const syncedHydrogen = (await viewRes.json()).session.members.find(
    (m: { nickname: string }) => m.nickname === "氢气成员",
  );
  expect(syncedHydrogen).toMatchObject({
    tool: "agy",
    model: "gemini-4-hydrogen-xhigh",
    effort: "xhigh",
  });
});

test("A07 不支持账号隐藏 Hydrogen、空目录/刷新失败严格区分、禁止手工输入、迟到防污染及切回恢复", async ({
  page,
  request,
  baseURL,
}) => {
  test.setTimeout(120000);
  // 先在支持状态保存默认设置与一个包含 Hydrogen Extra 的群聊
  await setAgyHydrogenCatalog(page, "supported");
  const curDefaults = (
    await (await request.get("/api/settings/model-defaults")).json()
  ).defaults;
  await request.put("/api/settings/model-defaults", {
    headers: { Origin: baseURL!, "content-type": "application/json" },
    data: {
      request_id: crypto.randomUUID(),
      expected_defaults_revision: curDefaults.revision,
      planner_profile: {
        id: "planner",
        revision: 1,
        adapterId: "agy",
        modelSelection: "explicit",
        modelId: "gemini-4-hydrogen-xhigh",
        reasoning: { mode: "explicit", value: "xhigh" },
        selectionKind: "fixed",
        options: {},
      },
      executor_profile: curDefaults.executorProfile,
    },
  });
  const histGroupTitle = `历史 Hydrogen 群-${Date.now()}`;
  await request.post("/api/groups", {
    headers: { Origin: baseURL!, "content-type": "application/json" },
    data: {
      title: histGroupTitle,
      human: "我",
      admin: 0,
      members: [
        {
          nickname: "历史氢气",
          tool: "agy",
          model: "gemini-4-hydrogen-xhigh",
          effort: "xhigh",
        },
      ],
    },
  });

  // 1. 切换至有效空目录（模拟不支持账号）
  await setAgyHydrogenCatalog(page, "empty");
  await page.goto("/");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const settingsDialog = page.getByRole("dialog", { name: "设置" });
  await settingsDialog.getByRole("tab", { name: "规划", exact: true }).click();
  // 已有历史配置不被静默降档，且明确提示不支持
  await expect(settingsDialog.getByRole("alert")).toContainText(
    "当前账号不支持模型 Gemini 4 Hydrogen，请切换到支持的账号或重新选择模型。",
  );
  const search = exactLabel(settingsDialog, "工具模型搜索");
  await search.click();
  const listbox = page.getByRole("listbox", { name: "模型选项列表" });
  await expect(listbox).toContainText("当前账号暂无可用模型");
  // 禁止手工添加 Hydrogen
  await search.fill("gemini-4-hydrogen-xhigh");
  await expect(listbox.locator(".ms-custom-option")).toHaveCount(0);
  await expect(listbox).not.toContainText("Gemini 4 Hydrogen");
  await settingsDialog.getByRole("button", { name: "取消", exact: true }).click();

  // 验证全局默认未被修改
  const preservedDefaults = (
    await (await request.get("/api/settings/model-defaults")).json()
  ).defaults;
  expect(preservedDefaults.plannerProfile.modelId).toBe(
    "gemini-4-hydrogen-xhigh",
  );

  // 2. 群聊在有效空目录 vs 刷新失败下严格区分提示，且历史成员不被静默降档
  await page.goto("/group-chat");
  const histGroupCard = page.locator(".gc-group-card", { hasText: histGroupTitle }).first();
  await histGroupCard.hover();
  await histGroupCard.getByRole("button", { name: `编辑群聊 ${histGroupTitle}`, exact: true }).click();
  const histRow = GROUP_MEMBER_LIST(page)
    .getByRole("listitem")
    .filter({ hasText: "历史氢气" })
    .first();
  await histRow.hover();
  await histRow.getByRole("button", { name: /^编辑成员/ }).click();
  const histEditor = page.getByRole("dialog", { name: "编辑成员", exact: true });
  await expect(histEditor.getByLabel("模型选择")).toContainText(
    /Gemini 4 Hydrogen（当前目录不可用）/,
  );
  await expect(histEditor.getByLabel("推理强度")).toHaveValue("xhigh");
  await histEditor.getByRole("button", { name: "关闭", exact: true }).click();

  // 打开新增成员确认有效空目录展示“当前工具未读取到可用模型” + “刷新目录”（非失败 alert）
  await page.getByRole("button", { name: "新增成员", exact: true }).click();
  const emptyEditor = page.getByRole("dialog", { name: "新增成员", exact: true });
  await emptyEditor.getByLabel("接入工具").selectOption("agy");
  await expect(emptyEditor).toContainText("当前工具未读取到可用模型");
  await expect(emptyEditor.getByRole("button", { name: "刷新目录" })).toBeVisible();
  await expect(emptyEditor.getByRole("alert")).toHaveCount(0);

  // 切换至刷新失败状态，点击刷新目录应展示失败 alert 与“重试加载”
  await setAgyHydrogenCatalog(page, "fail");
  await emptyEditor.getByRole("button", { name: "刷新目录" }).click();
  await expect(emptyEditor.getByRole("alert")).toBeVisible({ timeout: 15000 });
  await expect(emptyEditor.getByRole("button", { name: "重试加载" })).toBeVisible();

  // 3. 迟到目录响应不污染新账号当前结果，且切回支持后可刷新恢复
  let holdOldRequest = true;
  let releaseOld!: () => void;
  const oldGate = new Promise<void>((resolve) => {
    releaseOld = resolve;
  });
  let markFirstIntercepted!: () => void;
  const firstIntercepted = new Promise<void>((resolve) => {
    markFirstIntercepted = resolve;
  });
  let interceptActive = true;
  await page.route("**/api/model-tools/agy/models", async (route) => {
    if (!interceptActive || !holdOldRequest) {
      await route.continue();
      return;
    }
    holdOldRequest = false;
    markFirstIntercepted();
    await oldGate;
    // 迟到的旧账号响应携带 Hydrogen
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        adapterId: "agy",
        scopeHash: "stale-account-a",
        status: "fresh",
        discoveryStatus: "complete",
        entries: [
          {
            entryId: "agy/gemini-4-hydrogen-high",
            adapterId: "agy",
            nativeId: "gemini-4-hydrogen-high",
            label: "Gemini 4 Hydrogen (High)",
            familyId: "gemini-4-hydrogen",
            accessModelKey: "gemini-4-hydrogen",
            selectionKind: "fixed",
            effort: {
              status: "supported",
              transport: "variant-id",
              values: ["low", "medium", "high", "xhigh"],
              defaultValue: "high",
              fixedValue: "high",
              variants: {
                low: "gemini-4-hydrogen-low",
                medium: "gemini-4-hydrogen-medium",
                high: "gemini-4-hydrogen-high",
                xhigh: "gemini-4-hydrogen-xhigh",
              },
            },
            source: "native-live",
            discoveredAt: new Date().toISOString(),
            hidden: false,
            availability: "listed",
          },
        ],
      }),
    });
  });

  // 回到首页触发第一次旧请求被挂起，切换工具再切回 AGY 让最新空目录先行返回，再放行旧请求
  await setAgyHydrogenCatalog(page, "empty");
  await page.goto("/");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const raceDialog = page.getByRole("dialog", { name: "设置" });
  await firstIntercepted;
  // 触发第二次（新账号）请求后再释放旧请求
  await exactLabel(raceDialog, "工具").selectOption("codex");
  await exactLabel(raceDialog, "工具").selectOption("agy");
  const raceSearch = exactLabel(raceDialog, "工具模型搜索");
  await raceSearch.click();
  await expect(page.getByRole("listbox", { name: "模型选项列表" })).toContainText(
    "当前账号暂无可用模型",
  );
  releaseOld();
  await page.waitForTimeout(300);
  // 迟到结果不得污染当前 AGY 空目录
  await expect(page.getByRole("listbox", { name: "模型选项列表" })).not.toContainText(
    "Gemini 4 Hydrogen",
  );
  interceptActive = false;
  await page.unroute("**/api/model-tools/agy/models");

  // 切回支持并点击刷新按钮即时恢复目录，再关闭重开验证已存历史配置完整恢复
  await setAgyHydrogenCatalog(page, "supported");
  await raceDialog.getByTitle("刷新模型目录").click();
  await raceSearch.click();
  await expect(page.getByRole("listbox", { name: "模型选项列表" })).toContainText(
    "Gemini 4 Hydrogen",
    { timeout: 30000 },
  );
  await raceSearch.press("Escape");
  page.once("dialog", (d) => d.accept());
  await raceDialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(raceDialog).not.toBeVisible({ timeout: 10000 });
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const recoveredDialog = page.getByRole("dialog", { name: "设置" });
  await expect(exactLabel(recoveredDialog, "工具")).toHaveValue("agy");
  await expect(exactLabel(recoveredDialog, "工具思考强度")).toHaveValue("xhigh");
  await expect(exactLabel(recoveredDialog, "工具模型搜索")).toHaveValue(
    "Gemini 4 Hydrogen",
  );
});

test("A08 回归既有 AGY 型号（不增加 Extra）、默认继承、角色覆盖与群聊成员保留", async ({
  page,
  request,
  baseURL,
}) => {
  test.setTimeout(90000);
  await setAgyHydrogenCatalog(page, "supported");
  await page.goto("/");

  // 1. 验证既有 Gemini 3.8 Flash High / Medium 仅保持自身固定档位，不出现 Extra
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const settingsDialog = page.getByRole("dialog", { name: "设置" });
  await settingsDialog.getByRole("tab", { name: "规划", exact: true }).click();
  await exactLabel(settingsDialog, "工具").selectOption("agy");

  const search = exactLabel(settingsDialog, "工具模型搜索");
  await search.click();
  await search.fill("gemini-3.8-flash-high");
  const listbox = page.getByRole("listbox", { name: "模型选项列表" });
  await expect(listbox).toBeVisible();
  const flashHighOpt = listbox
    .locator('[role="option"]:not(.ms-custom-option)')
    .filter({ hasText: /Gemini 3\.8 Flash/i })
    .first();
  await expect(flashHighOpt).toBeVisible();
  await flashHighOpt.click();

  const effortSelect = exactLabel(settingsDialog, "工具思考强度");
  if ((await effortSelect.count()) > 0) {
    await expect(effortSelect.locator('option[value="xhigh"]')).toHaveCount(0);
    await effortSelect.selectOption("high");
  } else {
    await expect(settingsDialog.locator(".ms-fixed-value")).toHaveText("High");
  }

  await settingsDialog.getByRole("button", { name: "保存配置", exact: true }).click();
  await expect(settingsDialog).not.toBeVisible({ timeout: 20000 });

  // 2. 新建任务默认继承 3.8 Flash High，角色覆盖 inherit 跟随，已保存群成员保留
  await page.getByRole("button", { name: "+ 新建", exact: true }).click();
  const createModal = page.locator(".modal-backdrop").last();
  await createModal.getByRole("tab", { name: "规划", exact: true }).click();
  await expect(exactLabel(createModal, "工具")).toHaveValue("agy");
  await expect(exactLabel(createModal, "工具模型搜索")).toHaveValue(/Gemini 3\.8 Flash/i);
  await createModal.getByRole("tab", { name: "代码审查", exact: true }).click();
  await expect(createModal.getByLabel("同规划")).toBeChecked();
  await expect(createModal).toContainText(/Gemini 3\.8 Flash/i);
  await createModal.getByRole("button", { name: "×" }).click();

  const groupRes = await request.post("/api/groups", {
    headers: { Origin: baseURL!, "content-type": "application/json" },
    data: {
      title: "既有型号与 Hydrogen 共存群",
      human: "我",
      admin: 0,
      members: [
        { nickname: "Flash 成员", tool: "agy", model: "gemini-3.8-flash-high", effort: "high" },
        { nickname: "Hydrogen 成员", tool: "agy", model: "gemini-4-hydrogen-xhigh", effort: "xhigh" },
      ],
    },
  });
  expect(groupRes.ok(), await groupRes.text()).toBeTruthy();
  const group = await groupRes.json();
  const sessRes = await request.post(`/api/groups/${group.id}/sessions`, {
    headers: { Origin: baseURL!, "content-type": "application/json" },
    data: { title: "回归同步", scene: "open" },
  });
  expect(sessRes.ok(), await sessRes.text()).toBeTruthy();
  const sess = await sessRes.json();
  const synced = await request.post(`/api/group-sessions/${sess.id}/actions`, {
    headers: { Origin: baseURL!, "content-type": "application/json" },
    data: { version: sess.version, request: crypto.randomUUID(), input: { action: "sync" } },
  });
  expect(synced.ok(), await synced.text()).toBeTruthy();
  const viewRes = await request.get(`/api/group-sessions/${sess.id}`);
  expect(viewRes.ok(), await viewRes.text()).toBeTruthy();
  const syncedMembers = (await viewRes.json()).session.members.map(
    ({ id: _id, ...rest }: { id: string }) => rest,
  );
  expect(syncedMembers).toEqual([
    { nickname: "Flash 成员", tool: "agy", model: "gemini-3.8-flash-high", effort: "high" },
    { nickname: "Hydrogen 成员", tool: "agy", model: "gemini-4-hydrogen-xhigh", effort: "xhigh" },
  ]);
});
