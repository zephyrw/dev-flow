import { expect, it } from "vitest";
import { workflowAttention } from "../../packages/core/src/attention.js";
import {
  readableLogs,
  userFacingLogs,
} from "../../packages/presentation/src/activity.js";
import { setup, plan, project } from "../helpers.js";

it("distinguishes a running planner review from waiting for a review slot", () => {
  const workflow = {
    id: "w",
    stage: "quality_before_human",
    state: "REVIEWING",
  };
  const engine = {
    get: () => workflow,
    store: { get: () => undefined },
  } as any;
  expect(workflowAttention(engine, "w")?.message).toBe(
    "规划模型正在审查代码质量，无需手动启动",
  );
  workflow.state = "REVIEW_QUEUED";
  expect(workflowAttention(engine, "w")?.message).toContain(
    "等待规划模型审查代码质量",
  );
});

it("shows scoped review activity across diagnostic chunks without exposing technical output or reasoning", () => {
  const event = (seq: number, text: string, run = "r") => ({
    workflow_id: "w",
    run_id: run,
    event_seq: seq,
    created_at: String(seq),
    type: "ReviewDiagnostic",
    payload: { text },
  });
  const rows = userFacingLogs(
    readableLogs(
      [
        event(1, "thinking\nprivate reasoning\nmcp:"),
        event(2, " devflow_review/devflow_review_read_file started\n"),
        event(3, "mcp: devflow_review/devflow_review_read_file (completed)\n"),
        event(4, "mcp: devflow_review/devflow_review_evidence (completed)\n"),
        event(
          5,
          "mcp: devflow_review/devflow_review_read_file (completed)\n",
          "other-run",
        ),
      ],
      "w",
    ),
  );
  expect(rows).toHaveLength(3);
  expect(rows[0]).toMatchObject({
    title: "读取文件",
    kind: "tool",
    status: "done",
  });
  expect(rows[1]).toMatchObject({
    title: "读取测试证据",
    kind: "tool",
    status: "done",
  });
  expect(rows[2]).toMatchObject({
    title: "读取文件",
    kind: "tool",
    status: "done",
  });
  expect(JSON.stringify(rows.map((r) => r.text))).not.toMatch(
    /private reasoning|mcp:|started|completed/,
  );
});

it("TR-07 排队落实新修改时开发投影为未完成，不沿用刚完成运行", () => {
  const s = nativeProgressFixture({
    state: "QUEUED",
    runId: "run-done",
    completionRunId: "run-done",
  });
  try {
    const tasks = s.engine.taskStatus(s.workflowId, false);
    expect(tasks[0]?.development_status).not.toBe("completed");
    expect(tasks[0]?.completed).toBe(false);
  } finally {
    s.store.close();
  }
});

it("TR-07 审查等待用户时开发投影仍为完成", () => {
  const s = nativeProgressFixture({
    state: "WAITING_INPUT",
    runId: "run-review",
    completionRunId: "run-done",
  });
  try {
    const tasks = s.engine.taskStatus(s.workflowId, false);
    expect(tasks[0]?.development_status).toBe("completed");
    expect(tasks[0]?.completed).toBe(true);
  } finally {
    s.store.close();
  }
});

it("QR-08 COMMIT_PARTIAL 再入队执行时开发投影为未完成", () => {
  const s = nativeProgressFixture({
    state: "COMMIT_PARTIAL",
    runId: "run-done",
    completionRunId: "run-done",
  });
  try {
    expect(s.engine.taskStatus(s.workflowId, false)[0]?.completed).toBe(true);
    (s.engine as any).clearCurrentImplementationIntent(s.workflowId);
    s.engine.transition(s.workflowId, ["COMMIT_PARTIAL"], "QUEUED", "execute", {
      blocker: undefined,
    });
    const tasks = s.engine.taskStatus(s.workflowId, false);
    expect(tasks[0]?.development_status).not.toBe("completed");
    expect(tasks[0]?.completed).toBe(false);
  } finally {
    s.store.close();
  }
});

function nativeProgressFixture(options: {
  state: string;
  runId: string;
  completionRunId: string;
}) {
  const s = setup();
  const workflowId = "wf-progress";
  const p = plan("a".repeat(64), "b".repeat(40));
  p.task_model = "native-v2";
  s.store.put("project", "p1", "p1", project(s.root));
  s.store.put("workflow", workflowId, workflowId, {
    id: workflowId,
    project_id: "p1",
    state: options.state,
    stage: "quality_before_human",
    plan_revision: 1,
    plan_hash: "plan-hash",
    snapshot_id: "snapshot",
    environment_revision: 0,
    version: 1,
    run_id: options.runId,
    feedback: [],
  });
  s.store.put("plan", `${workflowId}-1`, workflowId, {
    id: `${workflowId}-1`,
    plan: p,
  });
  s.store.put("run", options.runId, workflowId, {
    id: options.runId,
    workflow_id: workflowId,
    status: options.state === "QUEUED" ? "completed" : "waiting",
    protocol: "lightweight",
  });
  s.store.put("run", options.completionRunId, workflowId, {
    id: options.completionRunId,
    workflow_id: workflowId,
    status: "completed",
    protocol: "lightweight",
  });
  const queuedNewWork = options.state === "QUEUED";
  s.store.put(
    "plan_check_review_intent",
    workflowId,
    workflowId,
    queuedNewWork
      ? {}
      : {
          implementation_run_id: options.completionRunId,
          completion_run_id: options.completionRunId,
          source_run_id: options.completionRunId,
        },
  );
  s.store.put("execution_completion", options.completionRunId, workflowId, {
    run_id: options.completionRunId,
    workflow_id: workflowId,
    intent: "completed",
    recorded_at: "2026-09-18T00:00:00Z",
  });
  return { ...s, workflowId };
}
