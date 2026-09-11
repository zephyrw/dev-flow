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
