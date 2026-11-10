import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { parseAgyModelCatalog } from "../../packages/adapters/agy/src/model-configuration.js";

const currentAgyCatalog = () => parseAgyModelCatalog({
  stdout: readFileSync(new URL("../fixtures/model-catalog/agy/models-20261023.txt", import.meta.url), "utf8"),
});

const memberList = (page: Page) => page.getByRole("list", { name: "模型成员", exact: true });
const memberDialog = (page: Page, name = "编辑成员") => page.getByRole("dialog", { name, exact: true });

async function editMember(page: Page, name: string) {
  const row = memberList(page).getByRole("listitem").filter({ hasText: name });
  await row.hover();
  await row.getByRole("button", { name: `编辑成员 ${name}`, exact: true }).click();
  return memberDialog(page);
}

async function keepFirstMember(page: Page) {
  for (let count = 4; count > 1; count--) {
    const row = memberList(page).getByRole("listitem").last();
    await row.hover();
    await row.getByRole("button", { name: /^移除成员/ }).click();
  }
}

test("群聊加载四个预置成员，刷新失效目录后保存实际 CLI ID", async ({ page }) => {
  const old = parseAgyModelCatalog({ stdout: "gemini-3.7-flash-high\ngemini-3.6-flash-low\nclaude-sonnet-4-6" });
  let refreshed = false;
  let refreshes = 0;
  await page.route("**/api/model-tools/agy/models", route => route.fulfill({ json: refreshed
    ? currentAgyCatalog() : { ...old, status: "failed", discoveryStatus: "missing" } }));
  await page.route("**/api/model-tools/agy/models/refresh", route => {
    refreshes++;
    return route.fulfill({ status: 202, json: { id: "group-catalog-refresh", status: "processing" } });
  });
  await page.route("**/api/model-operations/group-catalog-refresh", route => route.fulfill({
    json: { id: "group-catalog-refresh", status: refreshed ? "committed" : "processing" },
  }));
  await page.goto("/group-chat");
  await page.getByRole("button", { name: "新建群聊" }).click();
  await page.getByLabel("群名称").fill("AGY 模型目录验收");
  await expect(memberList(page).getByRole("listitem")).toHaveCount(4);
  await expect(memberList(page).getByRole("listitem").first()).toContainText("GPT-6 Astra max");
  await expect(page.getByRole("combobox")).toHaveCount(0);
  const editor = await editMember(page, "Gemini 4 Argon high");
  const model = editor.getByRole("combobox", { name: "模型", exact: true });
  const effort = editor.getByRole("combobox", { name: "推理强度", exact: true });
  await expect.poll(() => refreshes).toBe(1);
  await expect(model).toBeDisabled();
  await expect(effort.locator("option:checked")).toHaveText("high");
  await expect(model.locator('option[value="gemini-3.7-flash-high"]')).toHaveCount(0);
  await expect(editor.getByRole("button", { name: "保存成员" })).toBeDisabled();
  refreshed = true;
  await expect(model).toBeEnabled();
  await expect(model.locator("option")).toHaveText([
    "选择具体模型", "Gemini 4 Argon", "Gemini 3.8 Flash（已有成员）", "Claude Opus 5.5", "Claude Sonnet 5.5", "GPT OSS 120B",
  ]);
  const presets = [
    { nickname: "GPT-6 Astra max", tool: "codex", model: "gpt-6-astra", effort: "max" },
    { nickname: "GPT-6.1 Sol high", tool: "codex", model: "gpt-6.1-sol", effort: "high" },
    { nickname: "Gemini 3.8 Flash high", tool: "agy", model: "gemini-3.8-flash-high", effort: "high" },
    { nickname: "Gemini 4 Argon high", tool: "agy", model: "gemini-4-argon-high", effort: "high" },
  ];
  await expect(model.locator('option[value="gemini-3.8-flash-high"]')).toHaveJSProperty("disabled", true);
  await effort.selectOption("medium");
  await expect(model).toHaveValue("gemini-4-argon-high");
  await expect(editor.getByLabel("昵称")).toHaveAttribute("placeholder", "Gemini 4 Argon medium");
  await editor.getByRole("button", { name: "保存成员" }).click();
  await expect(memberList(page)).toContainText("Gemini 4 Argon medium");
  const created = page.waitForRequest(request => request.url().endsWith("/api/groups") && request.method() === "POST");
  await page.getByRole("button", { name: "创建群聊" }).click();
  expect((await created).postDataJSON().members).toEqual([
    presets[0], presets[1], presets[2],
    { nickname: "Gemini 4 Argon medium", tool: "agy", model: "gemini-4-argon-medium", effort: "medium" },
  ]);
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByLabel("群设置").click();
  await page.getByRole("button", { name: "编辑群配置" }).click();
  await editMember(page, "Gemini 4 Argon medium");
  await expect(model).toHaveValue("gemini-4-argon-high");
  await expect(effort).toHaveValue("medium");
  await model.selectOption({ label: "Claude Sonnet 5.5" });
  await effort.selectOption("low");
  await editor.getByRole("button", { name: "保存成员" }).click();
  const updated = page.waitForRequest(request => /\/api\/groups\/[^/]+$/.test(request.url()) && request.method() === "PUT");
  await page.getByRole("button", { name: "保存群配置" }).click();
  expect((await updated).postDataJSON().members[3]).toMatchObject({ model: "claude-sonnet-5-5-low", effort: "low" });
  expect(refreshes).toBe(1);
});

test("群聊目录刷新失败时显示错误并阻止提交，重试后恢复", async ({ page }) => {
  let recovered = false;
  await page.route("**/api/model-tools/agy/models", route => route.fulfill({ json: recovered
    ? currentAgyCatalog() : { ...currentAgyCatalog(), status: "stale" } }));
  await page.route("**/api/model-tools/agy/models/refresh", route => route.fulfill({ json: recovered
    ? { status: "committed" } : { status: "retryable", error_message: "无法读取当前账号模型，请重试" } }));
  await page.goto("/group-chat");
  await page.getByRole("button", { name: "新建群聊" }).click();
  await keepFirstMember(page);
  await page.getByRole("button", { name: "新增成员", exact: true }).click();
  const editor = memberDialog(page, "新增成员");
  await expect(editor.locator('option[value="gpt-6-astra"]')).toHaveJSProperty("disabled", true);
  await editor.getByRole("combobox", { name: "工具", exact: true }).selectOption("agy");
  await expect(editor.getByRole("alert")).toContainText("无法读取当前账号模型，请重试");
  await expect(editor.getByRole("combobox", { name: "模型", exact: true })).toBeDisabled();
  await expect(editor.getByRole("button", { name: "添加成员", exact: true })).toBeDisabled();
  recovered = true;
  await page.getByRole("button", { name: "刷新模型目录" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  const model = page.getByRole("combobox", { name: "模型", exact: true });
  await expect(model).toBeEnabled();
  await model.selectOption({ label: "GPT OSS 120B" });
  await expect(page.getByRole("combobox", { name: "推理强度", exact: true }).locator("option")).toHaveText(["模型默认", "medium"]);
  await editor.getByRole("button", { name: "添加成员", exact: true }).click();
  await expect(memberList(page)).toContainText("GPT OSS 120B medium");
  await expect(page.getByRole("button", { name: "创建群聊" })).toBeEnabled();
});

test("编辑旧群时保留已下线模型提示，重选前不能保存", async ({ page, request, baseURL }) => {
  await page.route("**/api/model-tools/agy/models", route => route.fulfill({ json: currentAgyCatalog() }));
  const response = await request.post("/api/groups", { headers: { Origin: baseURL! }, data: {
    title: "旧模型群配置", human: "我", admin: 0,
    members: [{ nickname: "旧成员", tool: "agy", model: "gemini-3.7-flash-low" }],
  } });
  expect(response.ok()).toBeTruthy();
  await page.goto("/group-chat");
  await page.getByRole("button", { name: /旧模型群配置/ }).click();
  await page.getByLabel("群设置").click();
  await page.getByRole("button", { name: "编辑群配置" }).click();
  await expect(page.getByRole("alert")).toContainText("当前目录不可用，请修改或移除");
  await expect(page.getByRole("button", { name: "保存群配置" })).toBeDisabled();
  const editor = await editMember(page, "Gemini 3.7 Flash low");
  const model = page.getByRole("combobox", { name: "模型", exact: true });
  await expect(model.locator('option[value="gemini-3.7-flash-low"]')).toHaveJSProperty("disabled", true);
  await model.selectOption({ label: "Gemini 3.8 Flash" });
  await editor.getByRole("button", { name: "保存成员" }).click();
  await expect(page.getByRole("button", { name: "保存群配置" })).toBeEnabled();
});

test("群聊界面修改各昵称、比较方案并指定成员成稿", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "模型群聊" }).click();
  await page.getByRole("button", { name: "新建群聊" }).click();
  await keepFirstMember(page);
  await page.getByLabel("群名称").fill("群聊浏览器验收");
  const first = await editMember(page, "GPT-6 Astra max");
  await first.getByRole("combobox", { name: "模型", exact: true }).selectOption({ label: "GPT-6.1 Sol" });
  await expect(first.getByLabel("昵称")).toHaveAttribute("placeholder", "GPT-6.1 Sol");
  await first.getByRole("button", { name: "保存成员" }).click();
  await page.getByRole("button", { name: "新增成员", exact: true }).click();
  const second = memberDialog(page, "新增成员");
  await second.getByLabel("昵称").fill("远山");
  await second.getByRole("combobox", { name: "模型", exact: true }).selectOption({ label: "GPT-6 Astra" });
  await second.getByRole("button", { name: "添加成员", exact: true }).click();
  await page.getByRole("button", { name: "创建群聊" }).click();
  await page.getByLabel("会话名称").fill("方案互评");
  await page.getByRole("combobox", { name: "场景", exact: true }).selectOption("design");
  await page.getByRole("button", { name: "创建会话" }).click();
  await page.getByRole("button", { name: "会话成员", exact: true }).click();
  const model = page.getByRole("dialog").locator("form").filter({ has: page.getByLabel("GPT-6.1 Sol的昵称") });
  await model.getByLabel("GPT-6.1 Sol的昵称").fill("墨舟新名");
  await model.getByRole("button", { name: "保存昵称" }).click();
  await expect(page.getByLabel("墨舟新名的昵称")).toHaveValue("墨舟新名");
  const human = page.getByRole("dialog").locator("form").filter({ has: page.getByLabel("我的昵称") });
  await human.getByLabel("我的昵称").fill("创作者");
  await human.getByRole("button", { name: "保存昵称" }).click();
  await expect(page.getByLabel("创作者的昵称")).toHaveValue("创作者");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByLabel("群消息").fill("设计独立文件目录");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByRole("heading", { name: "评分与简报" })).toBeVisible();
  const firstScores = page.getByRole("list", { name: "墨舟新名的方案评分" });
  const secondScores = page.getByRole("list", { name: "远山的方案评分" });
  for (const scores of [firstScores, secondScores]) {
    await expect(scores.getByRole("listitem")).toHaveCount(2);
    await expect(scores.getByText("82.0", { exact: true })).toHaveCount(2);
    await expect(scores.getByText("自评", { exact: true })).toHaveCount(1);
  }
  await firstScores.getByRole("button", { name: "查看远山的简报" }).click();
  await expect(page.locator(".gc-document-heading")).toContainText("方案比较简报");
  await page.getByRole("button", { name: "关闭预览" }).click();
  await page.getByRole("button", { name: "墨舟新名 · 完整方案" }).click();
  await expect(page.getByRole("heading", { name: "文档预览" })).toBeVisible();
  await expect(page.getByRole("link", { name: "下载 .md" })).toBeVisible();
  await page.getByRole("button", { name: "并排比较" }).click();
  await page.getByRole("combobox", { name: "第二份文档" }).selectOption({ label: "远山 · 完整方案" });
  await expect(page.locator(".gc-documents article")).toHaveCount(2);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".gc-documents article:visible")).toHaveCount(1);
  await page.getByRole("button", { name: "墨舟新名 · 第一份" }).click();
  await expect(page.locator(".gc-documents article:visible")).toContainText("墨舟新名");
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "退出比较" }).click();
  await page.getByRole("button", { name: "交给成员修订" }).click();
  await page.getByLabel("修订要求").fill("补充失败恢复");
  await page.getByRole("button", { name: "发送给指定成员" }).click();
  await expect(page.getByRole("button", { name: "采用此稿" })).toBeVisible();
  await page.getByRole("button", { name: "采用此稿" }).click();
  await expect(page.getByRole("button", { name: "已采用" })).toBeDisabled();
  await page.getByLabel("会话选项").click();
  await page.getByRole("button", { name: "删除", exact: true }).click();
  await page.getByLabel("同时删除此会话的全部受管文件").check();
  await page.getByRole("button", { name: "确认删除" }).click();
  await expect(page.getByRole("status")).toContainText("会话与受管文件已删除");
});

test("小说场景重想、选择低票点子、回答问题与大纲交付", async ({ page, request, baseURL }) => {
  const group = await request.post("/api/groups", {
    headers: { Origin: baseURL! },
    data: { title: "小说验收群", human: "作者", admin: 0, members: [
      { nickname: "墨舟", tool: "codex", model: "gpt-6.1-sol" },
      { nickname: "远山", tool: "codex", model: "gpt-6-astra" },
    ] },
  });
  expect(group.ok()).toBeTruthy();
  await page.goto("/group-chat");
  await page.getByRole("button", { name: /小说验收群/ }).click();
  await page.getByRole("button", { name: "新建会话" }).click();
  await page.getByLabel("会话名称").fill("故事构思");
  await page.getByRole("combobox", { name: "场景", exact: true }).selectOption("fiction");
  await page.getByRole("button", { name: "创建会话" }).click();
  await page.getByLabel("群消息").fill("以时间错位为起点，探索完整故事。");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByRole("heading", { name: "投票结果" })).toBeVisible();
  await expect(page.locator(".gc-poll-summary")).toContainText("2 有效票");
  await expect(page.locator(".gc-vote-voters")).toContainText(["自投", "暂无成员投票"]);
  await page.getByRole("button", { name: "全部重想" }).click();
  await page.getByLabel("本轮要避开的方向").fill("不要以梦收尾");
  await page.getByRole("button", { name: "重新生成" }).click();
  await expect(page.getByText("重新开始本轮", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "采用这个点子" })).toHaveCount(2);
  await page.locator(".gc-vote-row").filter({ hasText: "0 票" }).getByRole("button", { name: "采用这个点子" }).click();
  await expect(page.getByRole("button", { name: "回答这个问题" })).toHaveCount(2);
  await page.getByRole("button", { name: "回答这个问题" }).first().click();
  await page.getByRole("button", { name: "主动坦白" }).click();
  await expect(page.getByLabel("我的回答")).toHaveValue("主动坦白");
  await page.getByRole("button", { name: "提交回答" }).click();
  await expect(page.getByRole("button", { name: "回答这个问题" })).toHaveCount(2);
  await page.getByRole("button", { name: "整理大纲", exact: true }).click();
  await page.getByRole("button", { name: "发送给指定成员" }).click();
  await expect(page.getByRole("button", { name: "采用此稿" })).toBeVisible();
});

test("开放场景按提及单人或全员回应，普通群消息可仅记录", async ({ page, request, baseURL }) => {
  const groupResponse = await request.post("/api/groups", {
    headers: { Origin: baseURL! },
    data: { title: "开放验收群", human: "群主", admin: 0, members: [
      { nickname: "墨舟", tool: "codex", model: "gpt-6.1-sol" },
      { nickname: "远山", tool: "codex", model: "gpt-6-astra" },
    ] },
  });
  expect(groupResponse.ok()).toBeTruthy();
  const group = await groupResponse.json();
  const session = await request.post(`/api/groups/${group.id}/sessions`, { headers: { Origin: baseURL! }, data: { title: "提及测试", scene: "open" } });
  expect(session.ok()).toBeTruthy();
  const { id: sessionId } = await session.json();
  let disconnected = true;
  await page.route(`**/api/group-sessions/${sessionId}`, route => disconnected ? route.abort() : route.continue());
  await page.goto("/group-chat");
  await page.getByRole("button", { name: /开放验收群/ }).click();
  await page.getByRole("button", { name: /提及测试/ }).click();
  await expect(page.getByRole("alert")).toContainText("正在自动重连");
  disconnected = false;
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByLabel("群消息").fill("@远山 只请你回应");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByText("远山 · 完成")).toBeVisible();
  await expect(page.getByText("墨舟 · 完成")).toHaveCount(0);
  await page.getByLabel("群消息").fill("@全部模型 请各回应一次");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByText("墨舟 · 完成")).toBeVisible();
  await expect(page.getByText("远山 · 完成")).toBeVisible();
  await page.getByRole("combobox", { name: "发送方式" }).selectOption("record");
  await page.getByLabel("群消息").fill("仅保存这条材料");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByText("仅保存这条材料", { exact: true })).toBeVisible();
});
