import { expect, it } from "vitest";
import { workflowAttention } from "../../packages/core/src/attention.js";
import {
  readableLogs,
  userFacingLogs,
} from "../../packages/presentation/src/activity.js";

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
    "规划模型正在审查代码质量与测试证据，无需手动启动",
  );
  workflow.state = "REVIEW_QUEUED";
  expect(workflowAttention(engine, "w")?.message).toContain("已自动排队");
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
  expect(rows).toHaveLength(2);
  expect(rows[0]?.text).toContain("源码读取 1 次、测试证据 1 次");
  expect(rows[1]?.text).toContain("源码读取 1 次");
  expect(JSON.stringify(rows.map((r) => r.text))).not.toMatch(
    /private reasoning|mcp:|started|completed/,
  );
});
