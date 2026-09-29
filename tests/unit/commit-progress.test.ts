import { expect, it } from "vitest";
import { readableLogs, workflowProgress } from "../../packages/presentation/src/activity.js";
import { formatWorkflowState } from "../../packages/presentation/src/workflow-status.js";

it.each(["QUEUED", "EXECUTING", "VERIFYING"])("keeps %s final commit in the last step", (state) => {
  const workflow = { id: "wf", state, stage: "planner_commit" };
  const events = [{ workflow_id: "wf", event_seq: 1, type: "StateChanged",
    payload: { from: "QUEUED", to: state, stage: "planner_commit" } }];
  const progress = workflowProgress(workflow, events, { native: true, humanAccepted: true });
  expect(progress.index).toBe(7);
  expect(progress.title).toBe("本地提交");
  expect(progress.done).toEqual([true, true, true, true, true, true, true, false]);
  expect(progress.completed).toBe(false);
  expect(progress.next).toContain("提交与合并");
  expect(workflowProgress(workflow, events).index).toBe(6);
  expect(formatWorkflowState(state, workflow.stage)).toBe(state === "QUEUED" ? "等待提交" : "提交中");
  const log = readableLogs(events, "wf")[0];
  expect(log?.title).toContain("本地提交");
  expect(log?.text).not.toContain("开发与自测");
});

it("does not turn ordinary development or paused commit into active submission", () => {
  expect(formatWorkflowState("EXECUTING", "execute")).toBe("实施中");
  expect(formatWorkflowState("STOPPED", "planner_commit")).toBe("已暂停");
  expect(workflowProgress({ id: "wf", state: "EXECUTING", stage: "execute" }, [], { native: true }).index).toBe(2);
});
