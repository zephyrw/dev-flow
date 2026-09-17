import { test, expect } from "@playwright/test";

test("native tool actions show concrete targets and output while repair transitions remain explicit", async ({
  page,
}) => {
  const workflow = {
    id: "wf-native-logs",
    title: "原生操作日志",
    project_id: "p1",
    state: "EXECUTING",
    version: 1,
    plan_revision: 1,
    environment_revision: 0,
    feedback: [],
  };
  const event = (seq: number, type: string, payload: any) => ({
    workflow_id: workflow.id,
    event_seq: seq,
    run_id: "r",
    created_at: new Date().toISOString(),
    type,
    payload,
  });
  const tool = (seq: number, name: string, parameters: any, output?: string) =>
    event(seq, "AgentEvent", {
      event: "step_update",
      step_update: {
        step_index: seq,
        step_type: "tool",
        state: "DONE",
        tool_name: name,
        tool_info: { parameters, output },
      },
    });
  const events = [
    tool(
      0,
      "run_command",
      { CommandLine: "Get-Content run.jsonl" },
      "1111: grep_search - DONE\n1115: ACTIVE - internal-script-output-marker",
    ),
    tool(
      1,
      "run_command",
      {
        CommandLine:
          "mvn -q compile -DskipTests\nsecond-command-line " +
          "long-command-marker".repeat(60),
        Cwd: "C:/work/backend",
      },
      "[INFO] compiling\n[ERROR] invalid character BOM\nfull-output-marker",
    ),
    tool(
      2,
      "view_file",
      { AbsolutePath: "C:/work/UserService.java" },
      "200 lines, 8000 bytes",
    ),
    tool(3, "unknown_empty_tool", {}),
    event(4, "RepairScheduled", { message: "修复编译错误" }),
    event(5, "StateChanged", {
      from: "EXECUTING",
      to: "QUEUED",
      stage: "auto_repair",
    }),
    event(6, "StateChanged", {
      from: "QUEUED",
      to: "EXECUTING",
      stage: "execute",
    }),
    event(7, "AgentEvent", {
      event: "result",
      result: {
        response:
          "# 交付报告\n\n## 已完成\n\n- **登录检查**：通过\n- [工作目录](file:///C:/work/task)\n\n" +
          "实施与测试分别记录，最终核验仍按真实证据确认。".repeat(35) +
          "\n\n| 项目 | 结果 |\n| --- | --- |\n| 自测 | 通过 |\n\n`C:/work/" +
          "long-directory/".repeat(35) +
          "result.json`\n\n## 下一步\n\n等待人工验收。",
      },
    }),
    event(8, "AgentEvent", {
      event: "step_update",
      step_update: {
        step_index: 8,
        step_type: "agent_response",
        state: "DONE",
        text_delta: "## 自测摘要\n\n**测试已结束**，正在整理结果。",
      },
    }),
    event(9, "AgentEvent", {
      event: "step_update",
      step_update: {
        step_index: 9,
        step_type: "tool",
        tool_name: "replace_file_content",
        state: "ERROR",
        tool_info: { parameters: { TargetFile: "C:/work/failed-file.ts" } },
      },
    }),
  ];
  const detail = {
    workflow,
    plan: null,
    tasks: [],
    evidence: [],
    runs: [],
    events,
    review: null,
    environment: null,
  };
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({
      json: /\/(functional-issues|asides)$/.test(path)
        ? []
        : path === "/api/projects"
          ? [{ id: "p1", name: "日志测试" }]
          : path === "/api/workflows"
            ? [workflow]
            : detail,
    });
  });
  await page.routeWebSocket("**/api/notifications", () => {});
  await page.routeWebSocket("**/api/events?*", () => {});
  await page.goto("/");
  await page
    .getByRole("button")
    .filter({ has: page.getByRole("heading", { name: workflow.title }) })
    .click();
  if (!(await page.locator(".execution-sidebar").isVisible()))
    await page.getByRole("button", { name: "执行过程", exact: true }).click();
  const logs = page.locator(".logs");
  const compile = logs.locator(".activity").filter({
    hasText: "mvn -q compile -DskipTests",
  });
  await expect(compile.locator(".command-first-line")).toHaveText(
    "mvn -q compile -DskipTests",
  );
  await expect(logs.locator(".command-full")).toHaveCount(0);
  await compile
    .getByRole("button", { name: "展开命令", exact: true })
    .first()
    .click();
  await expect(logs.locator(".command-full").first()).toContainText(
    "long-command-marker".repeat(60),
  );
  await compile
    .getByRole("button", { name: "收起命令", exact: true })
    .first()
    .click();
  await expect(logs.locator(".command-full")).toHaveCount(0);
  await expect(logs.locator(".activity-result").first()).toHaveText(
    "编译遇到文件编码问题，需要修正后重试。",
  );
  await expect(logs).toContainText("C:/work/UserService.java");
  await expect(logs).not.toContainText("unknown_empty_tool");
  await expect(logs).not.toContainText("进入开发实施");
  await expect(logs).toContainText("修复已排队");
  await expect(logs).toContainText("继续开发与自测");
  await expect(logs.getByText("查看操作输出", { exact: true })).toHaveCount(0);
  await expect(logs.getByText("查看操作详情", { exact: true })).toHaveCount(0);
  await expect(logs).not.toContainText("full-output-marker");
  await expect(logs).not.toContainText("internal-script-output-marker");
  await expect(logs).not.toContainText("1111: grep_search");
  await expect(logs).not.toContainText("200 lines, 8000 bytes");
  await expect(logs.locator(".activity-status.done")).toHaveCount(0);
  await expect(logs).not.toContainText("已返回");
  await expect(logs.locator(".activity-status.error")).toHaveText("失败");
  const report = logs
    .locator(".activity")
    .filter({ hasText: "Gemini 执行结果" });
  await expect(
    report.getByRole("heading", { name: "交付报告", exact: true }),
  ).toBeVisible();
  await expect(
    report.getByRole("heading", { name: "下一步", exact: true }),
  ).toBeVisible();
  await expect(report.locator("strong")).toHaveText("登录检查");
  await expect(report.locator("a")).toHaveText("工作目录");
  await expect(report.locator("table")).toContainText("自测");
  await expect(report).not.toContainText("##");
  await expect(report).not.toContainText("**登录检查**");
  await expect(
    logs.getByRole("heading", { name: "自测摘要", exact: true }),
  ).toBeVisible();
  expect(
    await logs.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
  ).toBe(true);
  await page.screenshot({
    path: ".cache/e2e-native-log-details.png",
    fullPage: true,
  });
});

test("continuous WebSocket output becomes visible before the stream ends and survives an older HTTP response", async ({
  page,
}) => {
  const workflow = {
    id: "wf-stream",
    title: "连续日志验收",
    project_id: "p1",
    state: "EXECUTING",
    version: 1,
    plan_revision: 1,
    environment_revision: 0,
    feedback: [],
  };
  const detail = {
    workflow,
    plan: null,
    tasks: [],
    evidence: [],
    runs: [],
    events: [],
    review: null,
    environment: null,
  };
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const data = /\/(functional-issues|asides)$/.test(path)
      ? []
      : path === "/api/projects"
        ? [{ id: "p1", name: "日志测试" }]
        : path === "/api/workflows"
          ? [workflow]
          : detail;
    await route.fulfill({ json: data });
  });
  let timer: ReturnType<typeof setInterval> | undefined;
  let sent = 0;
  await page.routeWebSocket("**/api/notifications", () => {});
  await page.routeWebSocket("**/api/events?*", (socket) => {
    timer = setInterval(() => {
      sent++;
      socket.send(
        JSON.stringify({
          workflow_id: workflow.id,
          project_id: "p1",
          event_seq: sent,
          created_at: new Date().toISOString(),
          type: sent % 10 === 0 ? "StateChanged" : "AgentEvent",
          payload: {
            event: "step_update",
            step_update: {
              step_index: 1,
              step_type: "agent_response",
              state: "ACTIVE",
              text_delta: `流式日志-${sent}\n`,
            },
          },
        }),
      );
    }, 30);
    socket.onClose(() => clearInterval(timer));
  });
  try {
    await page.goto("/");
    await page
      .getByRole("button")
      .filter({ has: page.getByRole("heading", { name: workflow.title }) })
      .click();
    if (!(await page.locator(".execution-sidebar").isVisible()))
      await page.getByRole("button", { name: "执行过程", exact: true }).click();
    await expect(page.locator(".logs")).toContainText("流式日志-1", {
      timeout: 2000,
    });
    expect(timer).toBeDefined();
    await expect.poll(() => sent).toBeGreaterThan(20);
    // State events trigger HTTP snapshots with no events. Previously streamed
    // text must remain visible while the socket keeps sending every 30ms.
    await expect(page.locator(".logs")).toContainText("流式日志-1");
    await page.screenshot({ path: ".cache/e2e-log-stream.png" });
  } finally {
    clearInterval(timer);
  }
});

test("execution narrative keeps payloads collapsed and shows the interrupted stage on every tab", async ({
  page,
}) => {
  const workflow = {
    id: "wf-narrative",
    title: "执行过程验收",
    project_id: "p1",
    state: "BLOCKED",
    version: 1,
    plan_revision: 1,
    environment_revision: 0,
    feedback: [],
    blocker: {
      code: "INTERNAL_FAILURE",
      message: "Expected ',' or '}' in JSON",
    },
  };
  const events = [
    {
      workflow_id: workflow.id,
      event_seq: 1,
      run_id: "run1",
      created_at: new Date().toISOString(),
      type: "AgentEvent",
      payload: {
        event: "step_update",
        step_update: {
          step_index: 1,
          step_type: "tool",
          state: "ACTIVE",
          tool_name: "call_mcp_tool",
          tool_info: {
            parameters: {
              ToolName: "devflow_read_file",
              Arguments: {
                path: "src/customer.ts",
                internal: "payload-only-marker",
              },
            },
            output: "very-long-response-only-marker",
          },
        },
      },
    },
    {
      workflow_id: workflow.id,
      event_seq: 2,
      created_at: new Date().toISOString(),
      type: "StateChanged",
      payload: { from: "EXECUTING", to: "BLOCKED" },
    },
  ];
  const detail = {
    workflow,
    plan: null,
    tasks: [{ id: "t1", title: "筛选修复", status: "pending" }],
    evidence: [],
    runs: [],
    events,
    review: null,
    environment: null,
  };
  await page.route("**/api/**", (route) =>
    route.fulfill({
      json: /\/(functional-issues|asides)$/.test(
        new URL(route.request().url()).pathname,
      )
        ? []
        : new URL(route.request().url()).pathname === "/api/projects"
          ? [{ id: "p1", name: "过程测试" }]
          : new URL(route.request().url()).pathname === "/api/workflows"
            ? [workflow]
            : detail,
    }),
  );
  await page.routeWebSocket("**/api/notifications", () => {});
  await page.routeWebSocket("**/api/events?*", () => {});
  await page.goto("/");
  await page
    .getByRole("button")
    .filter({ has: page.getByRole("heading", { name: workflow.title }) })
    .click();
  await expect(page.getByLabel("当前执行进度")).toContainText(
    "开发实施 · 暂停",
  );
  await page.locator(".execution-toggle").waitFor();
  if (
    (await page.locator(".execution-toggle").getAttribute("aria-expanded")) ===
    "false"
  )
    await page.getByRole("button", { name: "执行过程", exact: true }).click();
  await expect(page.locator(".activity").first()).toContainText("读取文件");
  await expect(page.locator(".activity").first()).toContainText("已中断");
  await expect(
    page.locator(".activity").first().locator("pre:visible"),
  ).toHaveCount(0);
  await expect(page.locator(".activity-summary").first()).toHaveText(
    "src/customer.ts",
  );
  await page.screenshot({
    path: ".cache/e2e-execution-narrative.png",
    fullPage: true,
  });
  await expect(page.getByText("查看操作详情", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "任务进度", exact: true }).click();
  await expect(page.getByLabel("当前执行进度")).toContainText(
    "尚未生成细项清单",
  );
});
