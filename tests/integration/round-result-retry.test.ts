import { it, expect } from "vitest";
import { setup, project, plan } from "../helpers.js";
import { FlowError, type Run, type Workflow } from "../../packages/contracts/src/index.js";
import { repairFailure } from "../../packages/core/src/repair.js";
import { readBusinessProgress } from "../../packages/core/src/workflow-progress.js";
import { workflowProgress } from "../../packages/presentation/src/activity.js";

// Exercise the real result receiver and SQLite without unrelated plan-file publication.
async function fixture() {
  const s = setup();
  const time = new Date().toISOString();
  const w: Workflow = { id: "result-retry", project_id: "p1", title: "retry", request: "retry",
    complexity: "simple", workspace_mode: "existing_workspace", state: "QUEUED", stage: "execute",
    quality_policy_version: 2, version: 1, plan_revision: 1, plan_hash: "approved-hash",
    environment_revision: 0, feedback: [], created_at: time, updated_at: time };
  s.store.put("project", "p1", "p1", project(s.root));
  s.store.put("workflow", w.id, "p1", w);
  s.store.put("plan", `${w.id}-1`, w.id, { revision: 1, hash: w.plan_hash,
    plan: { ...plan("project-hash", "a".repeat(40)), task_model: "native-v2" } });
  return { ...s, w };
}
async function cleanup(s: Awaited<ReturnType<typeof fixture>>) { s.store.close(); }

it.each(["before_human", "after_human"] as const)("accepts a reused submission ID in a new test Run and advances once: %s", async phase => {
  const s = await fixture();
  try {
    let w = s.engine.get(s.w.id);
    s.store.put("workflow", w.id, w.project_id, { ...w, quality_policy_version: 2 });
    s.store.put("quality_flow", w.id, w.id, { workflow_id: w.id, phase, executor_repair_completed: true, planner_repairs_only: true });
    s.store.put("delivery", "old-delivery", w.id, { id: "old-delivery", run_id: "old-implement", manifest: { submission_id: "same-id", summary: "development" } });
    const run: Run = { id: "test-result", workflow_id: w.id, plan_revision: w.plan_revision,
      adapter: "agy", purpose: "executor_test", stage: "executor_test", protocol: "lightweight",
      status: "completed", exit_code: 0, started_at: new Date().toISOString(), package_hash: "pkg",
      dispatch_context: { purpose: "executor_test", review_phase: phase } };
    s.store.put("run", run.id, w.id, run);
    s.engine.transition(w.id, [w.state], "EXECUTING", "executor_test", { run_id: run.id });
    const result = { status: "completed", summary: "regression complete", delivery: { submission_id: "same-id", run_id: run.id, summary: "regression complete" } };
    await s.engine.receiveRoundResult(w.id, run.id, result);
    expect(s.engine.get(w.id).state).toBe(phase === "before_human" ? "HUMAN_PENDING" : "QUEUED");
    if (phase === "after_human") expect(s.store.get<any>("pending_dispatch_purpose", w.id)?.purpose).toBe("planner_commit");
    const count = s.store.list("delivery", w.id).length;
    const version = s.engine.get(w.id).version;
    await s.engine.receiveRoundResult(w.id, run.id, result);
    expect(s.store.list("delivery", w.id)).toHaveLength(count);
    expect(s.engine.get(w.id).version).toBe(version);
  } finally { await cleanup(s); }
});

it("keeps quality progress through restart-shaped pauses without UI event history", async () => {
  const s = await fixture();
  try {
    const w = s.engine.get(s.w.id);
    s.engine.transition(w.id, [w.state], "REVIEWING", "quality_before_human");
    s.engine.transition(w.id, ["REVIEWING"], "EXECUTING", "executor_test");
    s.engine.transition(w.id, ["EXECUTING"], "STOPPED", "stopped");
    const businessProgress = readBusinessProgress(s.store, s.engine.get(w.id));
    expect(businessProgress.index).toBe(4);
    expect(s.engine.detail(w.id, false).business_progress.index).toBe(4);
    const view = workflowProgress(s.engine.get(w.id), [], { native: true, businessProgress });
    expect(view.title).toBe("验收前质量审查");
    expect(view.done[5]).toBe(false);
    s.engine.transition(w.id, ["STOPPED"], "EXECUTING", "executor_test");
    expect(readBusinessProgress(s.store, s.engine.get(w.id)).index).toBe(4);
  } finally { await cleanup(s); }
});

it("protocol conflicts never enter code repair; test failures preserve the test purpose", async () => {
  const s = await fixture();
  try {
    const w = s.engine.get(s.w.id);
    s.store.put("run", "test-run", w.id, { id: "test-run", workflow_id: w.id, purpose: "executor_test" });
    s.engine.transition(w.id, [w.state], "EXECUTING", "executor_test", { run_id: "test-run" });
    expect(await repairFailure(s.engine, w.id, new FlowError("DELIVERY_CONFLICT", "old id"), "test-run")).toBeNull();
    expect(s.store.get("repair_state", w.id)).toBeUndefined();
    const retry = await repairFailure(s.engine, w.id, new FlowError("CHECK_FAILED", "assertion mismatch"), "test-run");
    expect(retry?.retry).toBe(true);
    expect(s.store.get<any>("repair_state", w.id).phase).toBe("executor_test");
    expect(retry?.instructions).not.toContain("全部开发任务");
    expect(retry?.instructions).toContain("继续当前整改后测试");
  } finally { await cleanup(s); }
});

it("pending feedback during test completion preserves the frozen test route", async () => {
  const s = await fixture();
  try {
    const w = s.engine.get(s.w.id);
    s.store.put("workflow", w.id, w.project_id, { ...w, quality_policy_version: 2 });
    s.store.put("run", "test-feedback", w.id, { id: "test-feedback", workflow_id: w.id, plan_revision: w.plan_revision,
      adapter: "agy", purpose: "executor_test", stage: "executor_test", protocol: "lightweight", status: "completed", exit_code: 0,
      dispatch_context: { purpose: "executor_test", review_phase: "before_human", source_run_id: "planner-done" } });
    s.engine.transition(w.id, [w.state], "EXECUTING", "executor_test", { run_id: "test-feedback" });
    s.store.put("feedback_message", "f", w.id, { message_id: "f", status: "pending", text: "continue the remaining regression" });
    await s.engine.receiveRoundResult(w.id, "test-feedback", { status: "completed", summary: "test done" });
    expect(s.engine.get(w.id)).toMatchObject({ state: "QUEUED", stage: "executor_test" });
    expect(s.store.get<any>("pending_dispatch_purpose", w.id)).toMatchObject({ purpose: "executor_test", review_phase: "before_human", source_run_id: "planner-done" });
  } finally { await cleanup(s); }
});
