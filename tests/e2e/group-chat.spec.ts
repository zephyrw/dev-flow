import { test, expect } from "@playwright/test";
test("群聊界面修改各昵称、比较方案并指定成员成稿", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "模型群聊" }).click();
  await page.getByRole("button", { name: "新建群聊" }).click();
  await page.getByLabel("群名称").fill("群聊浏览器验收");
  await page.getByRole("combobox", { name: "模型", exact: true }).selectOption({ label: "GPT-6.1 Sol" });
  await expect(page.getByLabel("成员 1 昵称")).toHaveAttribute("placeholder", "GPT-6.1 Sol");
  await page.getByRole("button", { name: "添加模型成员" }).click();
  const second = page.getByRole("group", { name: "模型成员 2" });
  await second.getByLabel("成员 2 昵称").fill("远山");
  await second.getByRole("combobox", { name: "模型", exact: true }).selectOption({ label: "GPT-6 Astra" });
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
  await page.goto("/group-chat");
  await page.getByRole("button", { name: /开放验收群/ }).click();
  await page.getByRole("button", { name: /提及测试/ }).click();
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
