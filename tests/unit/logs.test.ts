import { it, expect } from "vitest";
import { readableLogs } from "../../apps/web/src/logs.js";
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

it('groups blank and high-volume service output without crowding meaningful progress',()=>{
 const events:any[]=[{workflow_id:'w',event_seq:1,type:'ServiceStarting',run_id:'r',payload:{service_id:'backend',label:'后端服务',process_id:'p'}}];
 for(let i=2;i<102;i++)events.push({workflow_id:'w',event_seq:i,type:'ServiceOutput',run_id:'r',payload:{service_id:'backend',process_id:'p',text:i%2?'\n':'startup line\n'}});
 events.push({workflow_id:'w',event_seq:102,type:'ServiceReady',run_id:'r',payload:{service_id:'backend',label:'后端服务',process_id:'p'}});
 events.push({workflow_id:'w',event_seq:103,type:'UnknownInternal',payload:{}});
 const rows=readableLogs(events,'w');expect(rows).toHaveLength(2);expect(rows.filter(r=>r.kind!=='diagnostic')).toMatchObject([{title:'后端服务已就绪',status:'done'}]);expect(rows.some(r=>r.title==='工作流记录')).toBe(false);
});
