import { expect, it } from "vitest";
import {
  isTestCommand,
  nativeProgress,
  testOutputCounts,
} from "../../packages/presentation/src/native-progress.js";

const event = (
  seq: number,
  index: number,
  command: string | undefined,
  state = "DONE",
  output?: string,
  extra: any = {},
) => ({
  workflow_id: "w",
  run_id: "r",
  event_seq: seq,
  created_at: `2026-09-17T01:00:${String(seq).padStart(2, "0")}.000Z`,
  type: "AgentEvent",
  payload: {
    event: "step_update",
    step_update: {
      step_index: index,
      step_type: "tool",
      tool_name: "run_command",
      state,
      tool_info: {
        parameters: command ? { CommandLine: command } : {},
        output,
      },
      ...extra,
    },
  },
});
function fixture() {
  return {
    workflow: {
      id: "w",
      run_id: "r",
      state: "EXECUTING",
      plan_revision: 2,
      plan_hash: "hash2",
    },
    plan: {
      plan: {
        task_model: "native-v2",
        tasks: [
          { id: "A", module_id: "m", repo_id: "main", paths: ["src/a.ts"] },
          { id: "B", module_id: "m2", repo_id: "other", paths: ["src/a.ts"] },
        ],
      },
    },
    workspaces: [
      { repo_id: "main", root: "C:/work/main" },
      { repo_id: "other", root: "C:/work/other" },
    ],
    runs: [
      { id: "r", status: "running", plan_revision: 2, plan_hash: "hash2" },
      { id: "old", status: "failed", plan_revision: 1 },
    ],
    tasks: ["A", "B"].map((id) => ({
      id,
      completed: false,
      status: "pending",
      development_status: "pending",
      validation_status: "not_run",
    })),
    test_progress: { total: 26, passed: 0, failed: 0, cases: [] },
    events: [] as any[],
  };
}
it("projects existing file changes onto only their repository and never grants completion or evidence", () => {
  const d = fixture(),
    original = structuredClone(d);
  const p = nativeProgress(d, [
    { repo_id: "main", files: [{ path: "SRC/a.ts", status: "M" }] },
  ]);
  expect(p.tasks[0]).toMatchObject({
    development_status: "active",
    completed: false,
    validation_status: "not_run",
  });
  expect(p.tasks[1].development_status).toBe("pending");
  expect(p.task_counts).toMatchObject({
    total: 2,
    started: 1,
    verified: 0,
    developed: 0,
  });
  expect(p.test_progress).toBe(d.test_progress);
  expect(d).toEqual(original);
});
it("shows unavailable observations honestly and preserves verified delivery", () => {
  const d = fixture();
  d.tasks[0]!.status = "verified";
  d.tasks[0]!.development_status = "completed";
  const p = nativeProgress(d);
  expect(p.tasks[0]).toBe(d.tasks[0]);
  expect(p.tasks[1].development_status).toBe("unobserved");
});
it("observes directory work packages without matching sibling prefixes or other repositories", () => {
  const d = fixture();
  d.plan.plan.tasks[0]!.paths = ["src"];
  const p = nativeProgress(d, [
    {
      repo_id: "main",
      files: [{ path: "src/nested/a.ts" }, { path: "src-old/no.ts" }],
    },
  ]);
  expect(p.task_counts.started).toBe(1);
  expect(p.tasks[0].observed_paths).toEqual(["src/nested/a.ts"]);
  expect(p.tasks[0].summary).toContain("1 个相关文件");
  expect(p.tasks[1].development_status).toBe("pending");
  expect(
    nativeProgress(d, [{ repo_id: "main", files: [{ path: "src-old/no.ts" }] }])
      .task_counts.started,
  ).toBe(0);
});
it("streams a test start, failure and passing retry without double counting or promoting plan cases", () => {
  const d = fixture();
  d.events = [event(1, 1, "pnpm vitest run", "ACTIVE")];
  expect(nativeProgress(d).native_progress.running).toBe(1);
  d.events.push(
    event(
      2,
      1,
      undefined,
      "DONE",
      " Test Files 1 failed (1)\n Tests no tests\nError: transform failed",
    ),
  );
  expect(nativeProgress(d).native_progress.latest[0].status).toBe("failed");
  d.events.push(
    event(
      3,
      2,
      "pnpm vitest run",
      "DONE",
      "Error: expected console output\n Tests 5 passed (5)",
    ),
  );
  const p = nativeProgress(d);
  expect(p.native_progress.latest).toHaveLength(1);
  expect(p.native_progress.tests).toHaveLength(2);
  expect(p.native_progress.latest_result).toMatchObject({
    passed: 5,
    failed: 0,
    status: "passed",
  });
  expect(p.test_progress.passed).toBe(0);
});
it("joins background task output to its command and stops stale runs from staying active", () => {
  const d = fixture();
  d.events = [
    event(
      1,
      10,
      "mvn test",
      "DONE",
      "Running in background: conversation/task-10",
    ),
    event(2, 11, undefined, "DONE", undefined, {
      tool_name: "manage_task",
      tool_info: {
        parameters: { TaskId: "conversation/task-10" },
        output: "Status: RUNNING\nLast progress: 1s ago",
      },
    }),
  ];
  expect(nativeProgress(d).native_progress.running).toBe(1);
  d.events.push(
    event(3, 12, undefined, "DONE", undefined, {
      tool_name: "manage_task",
      tool_info: {
        parameters: { TaskId: "conversation/task-10" },
        output:
          "Status: COMPLETED\nTests run: 8, Failures: 1, Errors: 1, Skipped: 2\nBUILD FAILURE",
      },
    }),
  );
  expect(nativeProgress(d).native_progress.latest[0]).toMatchObject({
    status: "failed",
    passed: 4,
    failed: 2,
    skipped: 2,
  });
  d.events.push(event(4, 13, "pnpm test", "ACTIVE"));
  d.workflow.state = "STOPPED";
  expect(nativeProgress(d).native_progress.running).toBe(0);
  expect(nativeProgress(d).native_progress.tests[0].status).toBe("interrupted");
});
it("ignores other workflows, obsolete plans, and model prose", () => {
  const d = fixture();
  d.events = [
    {
      ...event(1, 1, "pnpm test", "DONE", "Tests 99 passed (99)"),
      run_id: "old",
    },
    { ...event(2, 2, "pnpm test", "ACTIVE"), workflow_id: "other" },
    event(3, 3, undefined, "DONE", undefined, {
      step_type: "agent_response",
      text_delta: "all 99 tests passed",
    }),
  ];
  expect(nativeProgress(d).native_progress.tests).toEqual([]);
});
it("keeps command failure even when some test cases passed and does not treat runner prose as a background task", () => {
  const d = fixture();
  d.events = [
    event(
      1,
      1,
      "mvn test",
      "DONE",
      "Running tests\nTests run: 5, Failures: 0, Errors: 0, Skipped: 0\nBUILD FAILURE",
    ),
  ];
  expect(nativeProgress(d).native_progress.latest_result).toMatchObject({
    status: "failed",
    passed: 5,
  });
  d.events = [
    event(2, 2, "pnpm test", "DONE", "Running tests\n Tests 5 passed (5)"),
  ];
  expect(nativeProgress(d).native_progress.latest_result.status).toBe("passed");
});
it("does not confuse scripts writing tests or skipped tests with runner invocations", () => {
  expect(isTestCommand("node -e \"const s='pnpm test';\"")).toBe(false);
  expect(isTestCommand("mvn test -DskipTests")).toBe(false);
  expect(isTestCommand("pnpm vitest run --help")).toBe(false);
  expect(isTestCommand("pnpm vitest run tests/test.ts")).toBe(true);
  expect(isTestCommand('mvn test "-Dtest=DualLoginTest"')).toBe(true);
  expect(testOutputCounts(" 2 failed\n 5 passed (4s)\n 1 skipped")).toEqual({
    passed: 5,
    failed: 2,
    skipped: 1,
  });
});
