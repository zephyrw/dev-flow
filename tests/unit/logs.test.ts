import { it, expect } from "vitest";
import { readableLogs, userFacingLogs } from "../../apps/web/src/logs.js";
import { toolSummary } from "../../packages/presentation/src/tool-summary.js";

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
    title: "读取任务说明",
    text: "读取本轮任务要求和已有进度",
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
