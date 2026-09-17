import { test, expect, type Page } from "@playwright/test";

const longCommand =
  'powershell -NoProfile -Command "' +
  "Write-Output example; ".repeat(35) +
  '"';
const longPath =
  "C:/Code/project/" + "nested-directory/".repeat(14) + "PlannerRuntime.ts";

async function screen(page: Page) {
  const workflow = {
    id: "wf-telemetry",
    title: "规划修复过程展示",
    project_id: "p",
    run_id: "r",
    state: "EXECUTING",
    stage: "planner_takeover",
    version: 1,
    plan_revision: 1,
    feedback: [],
    updated_at: new Date().toISOString(),
  };
  let seq = 0;
  const event = (type: string, payload: any, run = "r") => ({
    type,
    payload,
    workflow_id: workflow.id,
    run_id: run,
    event_seq: ++seq,
    created_at: new Date().toISOString(),
  });
  const runtime = {
    run_id: "r",
    adapter: "codex",
    purpose: "planner_takeover",
    requested_model: "gpt-6-astra",
    actual_model: "gpt-6-astra",
    effort: "xhigh",
    status: "responding",
    active_tools: 0,
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    activity_at: new Date().toISOString(),
    quota: {
      source: "native_session",
      observed_at: new Date().toISOString(),
      buckets: [
        {
          id: "codex",
          windows: [
            { used_percent: 73, window_minutes: 10080, resets_at: 1900000000 },
          ],
        },
      ],
    },
  };
  const events = [
    event("NativeActivity", {
      id: "cmd",
      kind: "tool",
      title: "执行命令",
      text: longCommand,
      command: longCommand,
      status: "active",
    }),
    event("NativeActivity", {
      id: "file",
      kind: "tool",
      title: "修改文件",
      text: longPath,
      status: "done",
    }),
    event(
      "AgentEvent",
      {
        event: "step_update",
        step_update: {
          step_index: 1,
          step_type: "tool",
          tool_name: "run_command",
          state: "DONE",
          tool_info: { parameters: { CommandLine: longCommand } },
        },
      },
      "old-agy",
    ),
    event(
      "AgentEvent",
      {
        event: "step_update",
        step_update: {
          step_index: 2,
          step_type: "tool",
          tool_name: "view_file",
          state: "DONE",
          tool_info: { parameters: { AbsolutePath: longPath } },
        },
      },
      "old-agy",
    ),
  ];
  const detail: any = {
    workflow,
    runtime,
    plan: null,
    tasks: [],
    evidence: [],
    operations: [],
    events,
    runs: [],
    history_cursor: null,
  };
  let socket: any;
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({
      json:
        path === "/api/workflows"
          ? [workflow]
          : path === "/api/projects"
            ? [{ id: "p", name: "隔离测试" }]
            : /\/(asides|functional-issues|messages)$/.test(path)
              ? []
              : detail,
    });
  });
  await page.routeWebSocket("**/api/notifications", () => {});
  await page.routeWebSocket("**/api/events?*", (ws) => {
    socket = ws;
  });
  await page.goto("/?workflow=" + workflow.id);
  await expect(page.getByRole("region", { name: "执行过程侧栏" })).toBeVisible();
  return {
    detail,
    send(type: string, payload: any, run = workflow.run_id) {
      const e = event(type, payload, run);
      detail.events.push(e);
      socket.send(JSON.stringify(e));
      return e;
    },
    duplicate(e: any) {
      socket.send(JSON.stringify(e));
    },
  };
}

test("Codex and AGY use identical one-line command and middle-ellipsis path rendering; runtime remains when the sidebar closes", async ({
  page,
}) => {
  await screen(page);
  const card = page.getByRole("region", { name: "当前工具与模型" });
  await expect(card).toContainText("Codex CLI");
  await expect(card).toContainText("gpt-6-astra · xhigh");
  await expect(card).toContainText("剩余 27%");
  await expect(card).toContainText("账号共享额度");
  const logs = page.locator(".execution-sidebar .logs");
  await expect(logs.locator(".command-first-line")).toHaveCount(2);
  for (const line of await logs.locator(".command-first-line").all()) {
    expect(
      await line.evaluate((el) => ({
        nowrap: getComputedStyle(el).whiteSpace,
        clipped: el.scrollWidth > el.clientWidth,
      })),
    ).toEqual({ nowrap: "nowrap", clipped: true });
  }
  const paths = logs.locator(".activity-summary");
  await expect(paths).toHaveCount(2);
  expect(await paths.first().textContent()).toBe(
    await paths.last().textContent(),
  );
  await expect(paths.first()).toContainText("...");
  await expect(paths.first()).toContainText("PlannerRuntime.ts");
  await expect(paths.first()).toHaveAttribute("title", longPath);
  expect(
    await paths
      .first()
      .evaluate((el) => el.getBoundingClientRect().height < 30),
  ).toBe(true);
  await logs.getByRole("button", { name: "展开命令" }).first().click();
  await expect(logs.locator(".command-full")).toHaveText(longCommand);
  await logs.getByRole("button", { name: "收起命令" }).click();
  await page.screenshot({
    path: ".cache/runtime-observability/desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "收起执行过程" }).click();
  await expect(card).toBeVisible();
  await page.setViewportSize({ width: 900, height: 950 });
  expect(
    await card.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
  ).toBe(true);
});

test("live updates reconcile completed commands, survive reload, and reject old-run model and quota after takeover", async ({
  page,
}) => {
  const fixture = await screen(page);
  const card = page.getByRole("region", { name: "当前工具与模型" });
  const done = fixture.send("NativeActivity", {
    id: "cmd",
    kind: "tool",
    title: "执行命令",
    text: longCommand,
    command: longCommand,
    status: "done",
    resultText: "命令退出码：0",
  });
  fixture.duplicate(done);
  await expect(page.locator(".logs .activity-result")).toHaveText(
    "命令退出码：0",
  );
  await expect(page.locator(".logs .command-first-line")).toHaveCount(2);
  await page.reload();
  await expect(card).toContainText("剩余 27%");
  await expect(page.locator(".logs .command-first-line")).toHaveCount(2);
  fixture.detail.workflow.run_id = "r2";
  fixture.detail.workflow.version++;
  fixture.detail.runtime = {
    run_id: "r2",
    adapter: "agy",
    purpose: "implement",
    status: "starting",
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    active_tools: 0,
  };
  fixture.send(
    "StateChanged",
    { from: "QUEUED", to: "EXECUTING", stage: "execute" },
    "r2",
  );
  await expect(card).toContainText("Antigravity CLI");
  await expect(card).toContainText("实际模型未确认");
  fixture.send(
    "RunObserved",
    {
      ...fixture.detail.runtime,
      run_id: "r",
      actual_model: "late-old-model",
      quota: {
        observed_at: new Date().toISOString(),
        buckets: [
          {
            id: "codex",
            windows: [{ used_percent: 99, window_minutes: 10080 }],
          },
        ],
      },
    },
    "r",
  );
  await expect(card).not.toContainText("late-old-model");
  await expect(card).not.toContainText("剩余");
  await expect(card).toContainText("尚未提供");
});

test("stale quota is labeled and a failed run cannot continue showing a running tool", async ({
  page,
}) => {
  const fixture = await screen(page);
  fixture.detail.workflow.state = "BLOCKED";
  fixture.detail.runtime.quota.observed_at = "2000-01-01T00:00:00Z";
  fixture.detail.runtime.current_activity = {
    id: "x",
    kind: "tool",
    title: "执行命令",
    command: "stale-active-command",
    text: "stale-active-command",
    status: "active",
  };
  await page.reload();
  const card = page.getByRole("region", { name: "当前工具与模型" });
  await expect(card).toContainText("上次读取，待更新");
  await expect(card).not.toContainText("stale-active-command");
  await expect(card).toContainText("已停止或结束");
});
