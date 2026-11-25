import { test, expect } from "@playwright/test";

test("模型群聊默认选中首条会话、真无会话居中提示、去除多余查看原文及 Markdown 排版", async ({ page }) => {
  const group1Id = "11111111-1111-4111-8111-111111111111";
  const group2Id = "11111111-1111-4111-8111-111111111112";
  const emptyGroupId = "11111111-1111-4111-8111-111111111113";
  const emptySessionId = "22222222-2222-4222-8222-222222222221";
  const sessionId = "22222222-2222-4222-8222-222222222222";
  const group2SessionId = "22222222-2222-4222-8222-222222222223";
  const artifactId = "33333333-3333-4333-8333-333333333333";
  const replyArtifactId = "33333333-3333-4333-8333-333333333334";
  const longReplyArtifactId = "33333333-3333-4333-8333-333333333335";
  const memberId = "44444444-4444-4444-8444-444444444444";

  const baseRoster = {
    version: 1,
    human: "我",
    admin: memberId,
    members: [{ id: memberId, nickname: "GPT-6 Astra", tool: "codex", model: "gpt-6-astra", effort: "high" }],
  };

  const groups = [
    { ...baseRoster, id: group1Id, title: "通用群" },
    { ...baseRoster, id: group2Id, title: "方案群" },
    { ...baseRoster, id: emptyGroupId, title: "空群聊" },
  ];

  const emptySession = {
    ...baseRoster,
    id: emptySessionId,
    group: group1Id,
    title: "新群",
    scene: "open",
    archived: false,
    answers: [],
    created: "2026-11-17T08:00:00Z",
    updated: "2026-11-17T08:00:00Z",
  };

  let activeSession = {
    ...baseRoster,
    id: sessionId,
    group: group1Id,
    title: "生物多样性方案",
    scene: "open",
    version: 3,
    archived: false,
    answers: [],
    created: "2026-11-17T08:00:00Z",
    updated: "2026-11-17T08:00:00Z",
  };

  const group2Session = {
    ...baseRoster,
    id: group2SessionId,
    group: group2Id,
    title: "方案群首个会话",
    scene: "design",
    archived: false,
    answers: [],
    created: "2026-11-17T08:00:00Z",
    updated: "2026-11-17T08:00:00Z",
  };

  let roundState: { id: string; stage: string; status: string; request: string; candidates: string[]; jobs: { member: string; state: string; error?: string }[]; context: string } | undefined = {
    id: "round-paused",
    stage: "reply",
    status: "paused",
    request: "请制定生物多样性方案",
    candidates: [],
    jobs: [{ member: memberId, state: "failed", error: "模拟成员失败暂停" }],
    context: "",
  };
  const postedActions: string[] = [];

  const shortMarkdownReply = "## 执行要点\n\n- 保护核心栖息地\n- 建立长期监测\n\n```ts\nconst ok = true;\n```\n\n| 指标 | 目标 |\n| --- | --- |\n| 覆盖率 | 95% |";
  const longTruncatedText = "超长回复内容 ".repeat(200).slice(0, 1200) + "…";

  await page.route("**/api/groups", (route) => route.fulfill({ json: groups }));
  await page.route(`**/api/groups/${group1Id}/sessions*`, (route) =>
    route.fulfill({ json: { items: [emptySession, activeSession] } }),
  );
  await page.route(`**/api/groups/${group2Id}/sessions*`, (route) =>
    route.fulfill({ json: { items: [group2Session] } }),
  );
  await page.route(`**/api/groups/${emptyGroupId}/sessions*`, (route) =>
    route.fulfill({ json: { items: [] } }),
  );
  await page.route(`**/api/group-sessions/${emptySessionId}`, (route) =>
    route.fulfill({ json: { session: emptySession, messages: [], artifacts: [] } }),
  );
  await page.route(`**/api/group-sessions/${group2SessionId}`, (route) =>
    route.fulfill({ json: { session: group2Session, messages: [], artifacts: [] } }),
  );
  await page.route(`**/api/group-sessions/${sessionId}`, (route) =>
    route.fulfill({
      json: {
        session: activeSession,
        round: roundState,
        messages: [
          {
            id: "msg-1",
            seq: 1,
            author: "我",
            text: "请制定生物多样性方案",
            recipients: [memberId],
            created: "2026-11-17T08:01:00Z",
          },
          {
            id: "msg-2",
            seq: 2,
            author: "GPT-6 Astra",
            text: shortMarkdownReply,
            recipients: ["human"],
            created: "2026-11-17T08:01:30Z",
            artifact: replyArtifactId,
          },
          {
            id: "msg-3",
            seq: 3,
            author: "GPT-6 Astra",
            text: longTruncatedText,
            recipients: ["human"],
            created: "2026-11-17T08:01:45Z",
            artifact: longReplyArtifactId,
          },
          {
            id: "msg-4",
            seq: 4,
            author: "GPT-6 Astra",
            text: "生物多样性保护实施方案",
            recipients: ["human"],
            created: "2026-11-17T08:02:00Z",
            artifact: artifactId,
          },
        ],
        artifacts: [
          {
            id: replyArtifactId,
            round: "round-0",
            stage: "reply",
            member: memberId,
            author: "GPT-6 Astra",
            title: "执行要点",
          },
          {
            id: longReplyArtifactId,
            round: "round-0b",
            stage: "reply",
            member: memberId,
            author: "GPT-6 Astra",
            title: "完整长篇回复",
          },
          {
            id: artifactId,
            round: "round-1",
            stage: "plans",
            member: memberId,
            author: "GPT-6 Astra",
            title: "生物多样性保护实施方案",
          },
        ],
      },
    }),
  );
  await page.route(`**/api/group-sessions/${sessionId}/actions`, async (route) => {
    const body = route.request().postDataJSON() as { input: { action: string } };
    postedActions.push(body.input.action);
    activeSession = { ...activeSession, version: activeSession.version + 1 };
    if (body.input.action === "cancel") {
      roundState = { ...roundState!, status: "done" };
    } else if (body.input.action === "send") {
      roundState = { ...roundState!, status: "running" };
    }
    return route.fulfill({
      json: {
        session: activeSession,
        round: roundState,
        messages: [],
        artifacts: [],
      },
    });
  });
  await page.route(`**/api/group-sessions/${sessionId}/artifacts/${artifactId}`, (route) =>
    route.fulfill({
      json: {
        id: artifactId,
        round: "round-1",
        stage: "plans",
        member: memberId,
        author: "GPT-6 Astra",
        title: "生物多样性保护实施方案",
        body: "# 生物多样性保护实施方案\n\n## 阶段目标\n\n- 生态修复\n\n```bash\necho ok\n```\n",
      },
    }),
  );
  await page.route(`**/api/group-sessions/${sessionId}/artifacts/${longReplyArtifactId}`, (route) =>
    route.fulfill({
      json: {
        id: longReplyArtifactId,
        round: "round-0b",
        stage: "reply",
        member: memberId,
        author: "GPT-6 Astra",
        title: "完整长篇回复",
        body: "## 完整回复标题\n\n> 重点引用内容\n\n```ts\nconsole.log('full');\n```\n",
      },
    }),
  );

  await page.goto("/group-chat");

  const sidebar = page.locator(".gc-sidebar");
  const chat = page.locator(".gc-chat");
  await expect(sidebar).toBeVisible();
  await expect(chat).toBeVisible();

  // 首次进入默认自动打开第一个群的第一个会话（"新群"），在正中间显示图形化引导
  const emptyHero = page.locator(".gc-thread-empty-hero");
  const thread = page.locator(".gc-thread");
  await expect(page.locator(".gc-chat-header").getByRole("heading", { name: "新群" })).toBeVisible();
  await expect(emptyHero).toBeVisible();
  await expect(page.locator(".gc-status")).toHaveCount(0);

  const sidebarPos = await sidebar.evaluate((el) => getComputedStyle(el).position);
  expect(sidebarPos).toBe("static");
  const sidebarBox = (await sidebar.boundingBox())!;
  const threadBox = (await thread.boundingBox())!;
  const heroBox = (await emptyHero.boundingBox())!;
  expect(Math.abs((heroBox.x + heroBox.width / 2) - (threadBox.x + threadBox.width / 2))).toBeLessThan(20);
  expect(Math.abs((heroBox.y + heroBox.height / 2) - (threadBox.y + threadBox.height / 2))).toBeLessThan(40);

  // 切换群到"方案群"时，默认自动选中它的第一个会话，而不显示"创建第一个会话"
  await page.locator(".gc-group-card").filter({ hasText: "方案群" }).click();
  await expect(page.locator(".gc-chat-header").getByRole("heading", { name: "方案群首个会话" })).toBeVisible();
  await expect(page.getByRole("button", { name: "创建第一个会话" })).toHaveCount(0);

  // 切换到真正 0 会话的"空群聊"，居中显示空群引导与"新建会话"
  await page.locator(".gc-group-card").filter({ hasText: "空群聊" }).click();
  const emptyGroupBox = page.locator(".gc-empty");
  await expect(emptyGroupBox).toBeVisible();
  await expect(emptyGroupBox.getByRole("heading", { name: "当前群聊暂无会话" })).toBeVisible();
  await expect(emptyGroupBox.getByRole("button", { name: "新建会话" })).toBeVisible();
  const chatBoxEmpty = (await chat.boundingBox())!;
  const emptyBoxRect = (await emptyGroupBox.boundingBox())!;
  expect(Math.abs((emptyBoxRect.x + emptyBoxRect.width / 2) - (chatBoxEmpty.x + chatBoxEmpty.width / 2))).toBeLessThan(20);
  expect(Math.abs((emptyBoxRect.y + emptyBoxRect.height / 2) - (chatBoxEmpty.y + chatBoxEmpty.height / 2))).toBeLessThan(40);

  // 切回"通用群"，再点击有消息的会话"生物多样性方案"
  await page.locator(".gc-group-card").filter({ hasText: "通用群" }).click();
  await page.locator(".gc-session-item").filter({ hasText: "生物多样性方案" }).click();

  await expect(page.locator(".gc-status")).toHaveCount(0);
  // 未截断的普通 reply 不应显示"查看原文"，仅超长截断的一条显示"展开完整回复 →"
  await expect(page.locator(".gc-reply-source")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "查看原文" })).toHaveCount(0);
  await expect(page.locator(".gc-reply-expand-btn")).toHaveCount(1);

  // 验证会话内 Markdown 正常渲染出标题、代码块、表格
  const bubbleMd = page.locator(".gc-msg-bubble-markdown .gc-markdown").first();
  await expect(bubbleMd.locator("h2", { hasText: "执行要点" })).toBeVisible();
  await expect(bubbleMd.locator("pre code")).toBeVisible();
  await expect(bubbleMd.locator("table th", { hasText: "指标" })).toBeVisible();

  // 双方会话左右边界应与下方居中输入框对齐，且内容轨道宽度比此前 820px 至少宽 1/3（>= 1100px）
  const composerBox = (await page.locator(".gc-composer-wechat").boundingBox())!;
  const composer = page.getByLabel("群消息输入框");
  const ownRowBox = (await page.locator(".gc-message-own").boundingBox())!;
  const aiRowBox = (await page.locator(".gc-message-ai").first().boundingBox())!;
  expect(composerBox.width).toBeGreaterThanOrEqual(1100);
  expect(Math.abs(aiRowBox.x - composerBox.x)).toBeLessThanOrEqual(2);
  expect(Math.abs((ownRowBox.x + ownRowBox.width) - (composerBox.x + composerBox.width))).toBeLessThanOrEqual(2);

  // 1920px 宽屏下，内容轨道应定宽 1120px 居中显示，两侧保留明显留白而非贴边拉伸
  await page.setViewportSize({ width: 1920, height: 1080 });
  const chatBoxWide = (await chat.boundingBox())!;
  const composerWide = (await page.locator(".gc-composer-wechat").boundingBox())!;
  const ownWide = (await page.locator(".gc-message-own").boundingBox())!;
  const aiWide = (await page.locator(".gc-message-ai").first().boundingBox())!;
  expect(composerWide.width).toBeCloseTo(1120, 1);
  expect(aiWide.x).toBeGreaterThan(chatBoxWide.x + 80);
  expect(ownWide.x + ownWide.width).toBeLessThan(chatBoxWide.x + chatBoxWide.width - 80);
  await page.setViewportSize({ width: 1440, height: 1000 });

  // 点击超长回复的"展开完整回复 →"，打开右侧优化后的原文阅读区并验证 Markdown 渲染
  await page.locator(".gc-reply-expand-btn").click();
  const preview = page.locator(".gc-preview");
  await expect(preview).toBeVisible();
  await expect(preview.locator(".gc-markdown h2", { hasText: "完整回复标题" })).toBeVisible();
  await expect(preview.locator(".gc-markdown blockquote")).toBeVisible();
  await expect(preview.locator(".gc-markdown pre code")).toBeVisible();
  expect(await preview.evaluate((el) => getComputedStyle(el).position)).toBe("static");

  // 点击文档卡片切换到文档预览，验证三栏并排
  await page.locator(".gc-doc-card-wechat").click();
  await expect(preview.locator(".gc-document-heading h3", { hasText: "生物多样性保护实施方案" })).toBeVisible();
  const sidebarBox3 = (await sidebar.boundingBox())!;
  const chatBox3 = (await chat.boundingBox())!;
  const previewBox = (await preview.boundingBox())!;
  expect(chatBox3.x).toBeGreaterThanOrEqual(sidebarBox3.x + sidebarBox3.width - 1);
  expect(previewBox.x).toBeGreaterThanOrEqual(chatBox3.x + chatBox3.width - 1);

  // paused 状态下仍可继续发送新消息（自动先 cancel 再 send）
  await composer.fill("继续下一轮讨论");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect.poll(() => postedActions).toEqual(["cancel", "send"]);
});
