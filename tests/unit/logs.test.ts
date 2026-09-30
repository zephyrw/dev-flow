import { it, expect } from "vitest";
import { readableLogs, userFacingLogs, workflowProgress } from "../../apps/web/src/logs.js";
import { toolSummary } from "../../packages/presentation/src/tool-summary.js";
import { runtimePurposeNames } from "../../packages/presentation/src/run-observation.js";

it("reuses immutable public event copies across projections and skips hidden metadata", () => {
  let reads = 0;
  const event = { workflow_id: "cache-w", event_seq: 1, created_at: "2026-09-30T00:00:00Z",
    type: "UserGuidance", payload: { get text() { reads++; return "hello password=secret-value"; } } };
  const first = readableLogs([event], "cache-w");
  const second = readableLogs([event], "cache-w");
  expect(reads).toBe(1);
  expect(second).toEqual(first);
  expect(JSON.stringify(second)).not.toContain("secret-value");
  expect(readableLogs([{ workflow_id: "cache-w", event_seq: 2, type: "ConversationUpdated",
    payload: { get text() { throw Error("hidden metadata must not be traversed"); } } }], "cache-w")).toEqual([]);
});

it("shows automatic integration recovery without a terminal failure badge", () => {
  const rows = readableLogs([{ workflow_id: "w", event_seq: 1,
    type: "PlannerIntegrationFailed", payload: { repo_id: "main", message: "EACCES", recovery_scheduled: true } }], "w");
  expect(rows[0]?.title).toBe("提交问题已交模型处理");
  expect(rows[0]?.status).toBeUndefined();
  expect(rows[0]?.text).toContain("EACCES");
});

it("shows the repository and redacted integration failure while keeping partial delivery recoverable", () => {
  const events = [
    { workflow_id: "w", event_seq: 1, type: "PlannerIntegrationFailed",
      payload: { repo_id: "main", message: "Error: SOURCE_BUSY 目标工作区存在未提交改动 --password example-secret" } },
    { workflow_id: "w", event_seq: 2, type: "StateChanged",
      payload: { from: "COMMITTING", to: "COMMIT_PARTIAL", stage: "commit_recovery" } },
    { workflow_id: "other", event_seq: 3, type: "PlannerIntegrationFailed",
      payload: { repo_id: "unrelated", message: "other failure" } },
  ];
  const before = JSON.stringify(events);
  const rows = userFacingLogs(readableLogs(events, "w"));
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({ title: "提交合并失败", status: "error" });
  expect(rows[0]?.text).toContain("仓库：main");
  expect(rows[0]?.text).toContain("SOURCE_BUSY 目标工作区存在未提交改动");
  expect(JSON.stringify(rows)).not.toContain("example-secret");
  expect(rows[1]).toMatchObject({ title: "提交合并需要恢复", status: "error" });
  expect(rows[1]?.text).toContain("保留已有提交和修改");
  expect(rows[1]?.text).toContain("合并交付尚未完成");
  expect(JSON.stringify(events)).toBe(before);
  const progress = workflowProgress({ id: "w", state: "COMMIT_PARTIAL", stage: "commit_recovery" }, events);
  expect(progress).toMatchObject({ index: 6, paused: true, completed: false });
  expect(progress.done[6]).toBe(false);
  expect(progress.next).toContain("重试原提交");
});

it("does not invent a cause for integration failure events without a recorded message", () => {
  const rows = readableLogs([{ workflow_id: "w", event_seq: 1,
    type: "PlannerIntegrationFailed", payload: {} }], "w");
  expect(rows[0]).toMatchObject({ title: "提交合并失败", status: "error", text: "合并未完成，失败原因未记录。" });
});

it("redacts historical guidance display without altering the execution input", () => {
  const guidance = { id: "secret-guidance", workflow_id: "w",
    text: "使用 --password sample-guidance-secret 继续处理", created_at: "2026-09-29T02:00:00Z" };
  const rows = readableLogs([], "w", [guidance]);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.text).not.toContain("sample-guidance-secret");
  expect(guidance.text).toContain("sample-guidance-secret");
});

it("projects an acceptance conversation as guidance processing without a new testing cycle", () => {
  const events = [
    { from: "HUMAN_PENDING", to: "QUEUED", stage: "acceptance_guidance" },
    { from: "QUEUED", to: "EXECUTING", stage: "acceptance_guidance" },
    { from: "EXECUTING", to: "HUMAN_PENDING", stage: "accept", guidance_mode: "human_acceptance" },
  ].map((payload, i) => ({ workflow_id: "w", event_seq: i + 1, created_at: "2026-09-29T02:00:00Z", type: "StateChanged", payload }));
  expect(readableLogs(events, "w").map(row => row.title)).toEqual(["验收指导已排队", "处理验收指导", "指导处理完成"]);
});

it.each([true, false])("labels functional guidance neutrally without declaring a new development cycle (resumed=%s)", resumed => {
  const events = ["QUEUED", "EXECUTING"].map((to, i) => ({ workflow_id: "w", event_seq: i + 1, created_at: "2026-09-29T02:00:00Z",
    type: "StateChanged", payload: { from: i === 0 ? "HUMAN_PENDING" : "QUEUED", to, stage: "functional_fix", resumed } }));
  const rows = readableLogs(events, "w");
  expect(rows.map(row => row.title)).toEqual(["验收指导已排队", "处理验收指导"]);
  expect(rows[1]?.text).toContain("启动验收服务或具体修改");
  expect(rows[1]?.text).not.toContain("本轮开发与自测");
  expect(runtimePurposeNames.functional_fix).toBe("执行模型 · 验收指导处理");
});

it.each([true, false])("labels a bound quality repair as remediation rather than implementation (resumed=%s)", (resumed) => {
  const rows = readableLogs([{ workflow_id: "w", event_seq: 1, created_at: "2026-09-28T09:54:06Z",
    type: "StateChanged", payload: { from: "QUEUED", to: "EXECUTING", stage: "execute", resumed,
      repair_source: "quality_review", source_review_id: "review-run" } }], "w");
  expect(rows[0]).toMatchObject({ title: "修复代码复核问题" });
  expect(rows[0]?.text).toContain("按本轮代码复核问题逐项整改");
  expect(rows[0]?.text).not.toContain("自主安排本轮开发");
});

it("distinguishes a resumed implementation and displays historical formal guidance once", () => {
  const events = [{ workflow_id: "w", event_seq: 4, created_at: "2026-09-28T08:00:00Z",
    type: "StateChanged", payload: { from: "QUEUED", to: "EXECUTING", stage: "execute", resumed: true } }];
  const guidance = { id: "m", workflow_id: "w", text: "Token 已更新，不要刷新", feedback_id: "f",
    created_at: "2026-09-28T07:59:00Z" };
  const rows = readableLogs(events, "w", [guidance, { ...guidance, workflow_id: "other" }]);
  expect(rows.map((row) => row.title)).toEqual(["收到你的指导", "继续开发与自测"]);
  expect(rows[0]?.text).toBe(guidance.text);
  expect(rows[1]?.text).toContain("已有修改和执行进度");
  const savedEvent = { workflow_id: "w", event_seq: 3, created_at: guidance.created_at,
    type: "UserGuidance", payload: { feedback_id: "f", text: guidance.text } };
  expect(readableLogs([savedEvent, ...events], "w", [guidance])
    .filter((row) => row.title === "收到你的指导")).toHaveLength(1);
  expect(readableLogs([{ ...events[0], payload: { ...events[0]!.payload, resumed: false } }], "w")[0]?.title)
    .toBe("开始开发与自测");
  expect(readableLogs([{ ...events[0], payload: { ...events[0]!.payload, stage: "executor_test" } }], "w")[0]?.title)
    .toBe("继续测试");
  const paused = readableLogs([{ ...events[0], payload: { to: "STOPPED" } }], "w")[0];
  expect(paused).toMatchObject({ title: "执行已暂停" });
  expect(paused?.status).not.toBe("error");
});

it("renders native commands, file targets and returned output, hiding empty unknown events", () => {
  const tool = (
    seq: number,
    index: number,
    name: string,
    state: string,
    info: any,
  ) => ({
    event_seq: seq,
    workflow_id: "native",
    run_id: "r",
    type: "AgentEvent",
    payload: {
      event: "step_update",
      step_update: {
        step_index: index,
        step_type: "tool",
        tool_name: name,
        state,
        tool_info: info,
      },
    },
  });
  const rows = readableLogs(
    [
      tool(1, 1, "run_command", "ACTIVE", {
        parameters: {
          CommandLine: "mvn -q compile -DskipTests",
          Cwd: "C:/work/backend",
        },
      }),
      tool(2, 1, "run_command", "DONE", {
        output: "[INFO] compiling\n[ERROR] invalid character BOM\nSee help",
      }),
      tool(3, 2, "replace_file_content", "ERROR", {
        parameters: {
          TargetFile: "C:/work/UserService.java",
          ReplacementContent: "private-code",
        },
      }),
      tool(4, 3, "mystery", "DONE", {}),
      tool(5, 4, "view_file", "DONE", {
        parameters: { AbsolutePath: "C:/work/app.ts" },
        output: "20 lines, 400 bytes",
      }),
    ],
    "native",
  );
  expect(rows).toHaveLength(3);
  expect(rows[0]).toMatchObject({
    title: "执行命令",
    text: "mvn -q compile -DskipTests\n工作目录：C:/work/backend",
    resultText: "编译遇到文件编码问题，需要修正后重试。",
  });
  expect(rows[0]!.output).toContain("See help");
  expect(rows[1]).toMatchObject({
    title: "修改文件",
    text: "C:/work/UserService.java",
    status: "error",
  });
  expect(rows[1]!.text).not.toContain("private-code");
  expect(rows[2]).toMatchObject({ title: "读取文件", text: "C:/work/app.ts" });
});

it("keeps raw execution facts for progress but never uses log tails as user summaries", () => {
  const sample = (
    seq: number,
    name: string,
    parameters: any,
    output: string,
  ) => ({
    workflow_id: "w",
    run_id: "r",
    event_seq: seq,
    type: "AgentEvent",
    payload: {
      event: "step_update",
      step_update: {
        step_index: seq,
        step_type: "tool",
        tool_name: name,
        state: "DONE",
        tool_info: { parameters, output },
      },
    },
  });
  const raw =
    "1111: grep_search - DONE\n1115: ACTIVE - Get-Content | ConvertFrom-Json";
  const rows = readableLogs(
    [
      sample(1, "run_command", { CommandLine: "Get-Content run.jsonl" }, raw),
      sample(
        2,
        "view_file",
        { AbsolutePath: "src/example.ts" },
        "SyntaxError: fake string in source",
      ),
      sample(3, "grep_search", { Query: '"step_type":"tool"' }, '"tool_name"'),
      sample(
        4,
        "run_command",
        { CommandLine: "pnpm vitest run" },
        " Tests 5 passed (5)",
      ),
      {
        workflow_id: "w",
        event_seq: 5,
        type: "AgentDiagnostic",
        payload: { text: "raw-runtime-diagnostic" },
      },
    ],
    "w",
  );
  expect(rows.find((r) => r.command === "Get-Content run.jsonl")).toMatchObject(
    { output: raw, resultText: "" },
  );
  expect(rows.find((r) => r.title === "读取文件")?.resultText).toBe("");
  expect(rows.find((r) => r.title === "搜索源码")).toBeUndefined();
  expect(rows.find((r) => r.command === "pnpm vitest run")?.resultText).toBe(
    "测试输出：5 项通过，0 项失败，0 项跳过。",
  );
  expect(
    userFacingLogs(rows).some((r) => r.text.includes("raw-runtime-diagnostic")),
  ).toBe(false);
});

it("hides abandoned partial model fragments while retaining the current narrative", () => {
  const events = ["old", "current"].map((run_id, event_seq) => ({
    workflow_id: "w",
    run_id,
    event_seq,
    type: "AgentEvent",
    payload: {
      event: "step_update",
      step_update: {
        step_index: 1,
        step_type: "agent_response",
        state: "ACTIVE",
        text_delta: run_id === "old" ? "n 1 (d8b2..." : "正在修复登录测试。",
      },
    },
  }));
  const rows = userFacingLogs(readableLogs(events, "w"), "current");
  expect(rows.map((r) => r.text)).toEqual(["正在修复登录测试。"]);
  expect(
    toolSummary("view_file", {
      AbsolutePath: "C:/work/.devflow/containers/task/handoff.json",
    }),
  ).toMatchObject({
    title: "读取文件",
    text: "C:/work/.devflow/containers/task/handoff.json",
  });
});

it("distinguishes repair queuing and resume from entering the development stage again", () => {
  const event = (seq: number, type: string, payload: any) => ({
    workflow_id: "w",
    event_seq: seq,
    type,
    payload,
  });
  const rows = readableLogs(
    [
      event(1, "RepairScheduled", { attempt: 2, message: "修复编译错误" }),
      event(2, "StateChanged", {
        from: "EXECUTING",
        to: "QUEUED",
        stage: "auto_repair",
      }),
      event(3, "StateChanged", {
        from: "QUEUED",
        to: "EXECUTING",
        stage: "execute",
      }),
      event(4, "StateChanged", {
        from: "QUEUED",
        to: "EXECUTING",
        stage: "executor_plan_self_check",
      }),
    ],
    "w",
  );
  expect(rows.map((r) => r.title)).toEqual([
    "执行模型自动修复",
    "修复已排队",
    "继续开发与自测",
    "开始开发与自测",
  ]);
  expect(rows.some((r) => r.text.includes("进入开发实施"))).toBe(false);
});
it("UT-19 log projection orders and deduplicates events, joins text chunks and never mixes workflows or runs", () => {
  const event = (
    seq: number,
    text: string,
    run = "run1",
    workflow = "wf1",
  ) => ({
    event_seq: seq,
    workflow_id: workflow,
    run_id: run,
    created_at: "2026-09-11T00:00:00Z",
    type: "AgentEvent",
    payload: {
      event: "step_update",
      step_update: {
        step_index: 2,
        step_type: "agent_response",
        state: "ACTIVE",
        text_delta: text,
      },
    },
  });
  const input = [
    event(2, "世界\n"),
    event(1, "你好"),
    event(2, "世界\n"),
    event(3, "其他流程", "run1", "wf2"),
    event(4, "新运行", "run2"),
  ];
  const before = JSON.stringify(input);
  const rows = readableLogs(input, "wf1");
  expect(rows.map((r) => r.text)).toEqual(["你好世界\n", "新运行"]);
  expect(rows[0]!.raw).toHaveLength(2);
  expect(JSON.stringify(input)).toBe(before);
  expect(
    readableLogs(
      [
        {
          event_seq: 1,
          workflow_id: "wf1",
          type: "AgentEvent",
          payload: { event: "result", result: { response: "第一行\n第二行" } },
        },
      ],
      "wf1",
    )[0]!.text,
  ).toBe("第一行\n第二行");
});

it("summarizes tool calls, hides prompts and marks interrupted operations", async () => {
  const { workflowProgress } = await import("../../apps/web/src/logs.js");
  const events = [
    {
      event_seq: 1,
      workflow_id: "wf",
      run_id: "r",
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
              Arguments: JSON.stringify({
                path: "src/app.ts",
                private_parameter: "do-not-show",
              }),
            },
          },
        },
      },
    },
    {
      event_seq: 2,
      workflow_id: "wf",
      type: "StateChanged",
      payload: { from: "EXECUTING", to: "BLOCKED" },
    },
    {
      event_seq: 3,
      workflow_id: "wf",
      type: "AgentEvent",
      payload: {
        event: "step_update",
        step_update: {
          step_type: "user_input",
          text_delta: "long internal prompt",
        },
      },
    },
  ];
  const rows = readableLogs(events, "wf");
  expect(rows[0]).toMatchObject({
    title: "读取文件",
    text: "src/app.ts",
    status: "interrupted",
  });
  expect(rows.some((r) => r.text.includes("long internal prompt"))).toBe(false);
  expect(
    workflowProgress({ id: "wf", state: "BLOCKED" }, events),
  ).toMatchObject({ index: 2, paused: true, title: "开发实施" });
  expect(
    workflowProgress({ id: "wf", state: "HUMAN_PENDING" }, events),
  ).toMatchObject({ index: 4, paused: false });
});

it("groups blank and high-volume service output without crowding meaningful progress", () => {
  const events: any[] = [
    {
      workflow_id: "w",
      event_seq: 1,
      type: "ServiceStarting",
      run_id: "r",
      payload: { service_id: "backend", label: "后端服务", process_id: "p" },
    },
  ];
  for (let i = 2; i < 102; i++)
    events.push({
      workflow_id: "w",
      event_seq: i,
      type: "ServiceOutput",
      run_id: "r",
      payload: {
        service_id: "backend",
        process_id: "p",
        text: i % 2 ? "\n" : "startup line\n",
      },
    });
  events.push({
    workflow_id: "w",
    event_seq: 102,
    type: "ServiceReady",
    run_id: "r",
    payload: { service_id: "backend", label: "后端服务", process_id: "p" },
  });
  events.push({
    workflow_id: "w",
    event_seq: 103,
    type: "UnknownInternal",
    payload: {},
  });
  const rows = readableLogs(events, "w");
  expect(rows).toHaveLength(2);
  expect(rows.filter((r) => r.kind !== "diagnostic")).toMatchObject([
    { title: "后端服务已就绪", status: "done" },
  ]);
  expect(rows.some((r) => r.title === "工作流记录")).toBe(false);
});

it("DF-STAGE-U08 blocked event explains timeout without inventing history", () => {
  const events = [
    {
      event_seq: 1,
      workflow_id: "wf-test",
      run_id: "run-old",
      type: "StateChanged",
      payload: {
        from: "EXECUTING",
        to: "BLOCKED",
        stage: "blocked",
      },
    },
    {
      event_seq: 2,
      workflow_id: "wf-test",
      run_id: "run-curr",
      type: "StateChanged",
      payload: {
        from: "EXECUTING",
        to: "BLOCKED",
        stage: "blocked",
        blocker: {
          code: "TIMEOUT",
          message: "本轮执行达到配置时限，现场已保留，可继续执行",
        },
      },
    },
  ];

  const rows = readableLogs(events, "wf-test");
  expect(rows).toHaveLength(2);

  expect(rows[0]).toMatchObject({
    title: "执行暂停",
    text: "执行已暂停，等待处理",
    status: "error",
  });

  expect(rows[1]).toMatchObject({
    title: "运行达到时限",
    text: expect.stringContaining("尚不能据此判定代码修复失败"),
    status: "error",
  });
  expect(rows[1]?.text).toContain("处理对应阻塞");
});
