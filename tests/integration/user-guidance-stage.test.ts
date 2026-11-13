import { afterEach, expect, it, vi } from "vitest";
import { setup, plan, project } from "../helpers.js";
import type { Run, Workflow } from "../../packages/contracts/src/index.js";
import { ProfileRuntime } from "../../packages/runtime/src/profile-runtime.js";

function guidedExecution(purpose: NonNullable<Run["purpose"]>, phase: "before_human" | "after_human") {
  const s = setup();
  const wid = "guidance-stage", time = new Date().toISOString();
  s.store.put("project", "p1", "p1", project(s.root));
  const w: Workflow = { id: wid, project_id: "p1", title: "guidance", request: "original", complexity: "simple",
    workspace_mode: "existing_workspace", state: "EXECUTING", stage: purpose, plan_revision: 1, plan_hash: "approved",
    run_id: "guided-run", environment_revision: 0, quality_policy_version: 2, version: 1,
    feedback: [], created_at: time, updated_at: time };
  const r: Run = { id: "guided-run", workflow_id: wid, plan_revision: 1, adapter: "agy", purpose,
    profile: { id: "executor", adapterId: "agy", revision: 1, modelSelection: "explicit", modelId: "fixture-model",
      reasoning: { mode: "not-applicable" }, options: {} }, protocol: "lightweight", stage: purpose,
    status: "completed", exit_code: 0, started_at: time,
    package_hash: "fixture-package",
    dispatch_context: { purpose, review_phase: phase, source_run_id: "prior-repair" } };
  const p = plan("project", "a".repeat(40)); p.task_model = "native-v2";
  s.store.put("workflow", wid, "p1", w);
  s.store.put("plan", `${wid}-1`, wid, { revision: 1, hash: "approved", plan: p });
  s.store.put("run", r.id, wid, r);
  s.store.put("quality_flow", wid, wid, { workflow_id: wid, phase, planner_repairs_only: true });
  s.store.put("session_input", r.id, wid, { run_id: r.id, kind: "followup", user_input: true,
    stage_key: "fixture", message_ids: ["user-message"], state: "delivered" });
  stores.push(s);
  return { s, w, r, wid };
}

const stores: ReturnType<typeof setup>[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const s of stores.splice(0)) s.store.close();
});

it.each(["implement", "executor_test", "planner_takeover", "planner_commit"] as const)(
  "a completed user reply cannot complete the scheduled %s stage", async purpose => {
    const { s, r, wid } = guidedExecution(purpose, "after_human");
    const priorReport = { run_id: "prior-test", summary: "existing tested results" };
    s.store.put("execution_test_report", "prior-test", wid, priorReport);
    await s.engine.receiveRoundResult(wid, r.id, { status: "completed", summary: "刚才核验超时，指导已收到。" });
    expect(s.engine.get(wid)).toMatchObject({ state: "QUEUED", stage: purpose });
    expect(s.store.get("execution_test_report", "prior-test")).toEqual(priorReport);
    expect(s.store.get("execution_test_report", r.id)).toBeUndefined();
    expect(s.store.list("delivery", wid)).toHaveLength(0);
    expect(s.store.get("pending_dispatch_purpose", wid)).toMatchObject({ purpose, review_phase: "after_human" });
    expect(s.store.events(wid).some(e => e.type === "UserGuidanceCompleted")).toBe(true);
    expect(s.store.get("quality_flow", wid)).toMatchObject({ phase: "after_human" });
  },
);

it.each([
  { status: "completed", summary: "开发和自测已完成", completed_items: ["t1"], unfinished_items: [] },
  { delivery: { status: "completed", summary: "开发和自测已完成" } },
])("routes an explicit implementation result after a user follow-up directly to code review", async result => {
  const { s, w, r, wid } = guidedExecution("implement", "before_human");
  const runtime = new ProfileRuntime(s.engine, {} as any);
  vi.spyOn(runtime as any, "invoke").mockResolvedValue(result);

  await runtime.execute(w, r, "fixture-token");

  expect(s.engine.get(wid)).toMatchObject({ state: "REVIEW_QUEUED", stage: "quality_before_human" });
  expect(s.store.list("delivery", wid)).toHaveLength(1);
  expect(s.store.get("pending_dispatch_purpose", wid)).toMatchObject({ purpose: "quality_review", source_run_id: r.id });
  expect(s.store.events(wid).some(e => e.type === "UserGuidanceCompleted")).toBe(false);
});

it("resumes a failed executor test after guidance and hands completed testing to human acceptance", async () => {
  const { s, r, wid } = guidedExecution("executor_test", "before_human");
  s.store.put("run", r.id, wid, { ...r, status: "failed" });
  s.engine.transition(wid, ["EXECUTING"], "BLOCKED", "blocked", {
    blocker: { code: "NATIVE_RUN_FAILED", message: "执行工具异常退出" },
  });

  expect(s.engine.feedback(wid, "已处理运行问题，请继续原任务", "within_plan"))
    .toMatchObject({ state: "QUEUED", stage: "executor_test" });
  const context = s.store.must<NonNullable<Run["dispatch_context"]>>("pending_dispatch_purpose", wid);
  expect(context).toMatchObject({
    purpose: "executor_test", review_phase: "before_human", source_run_id: "prior-repair",
  });

  const resumed = { ...r, id: "resumed-test", dispatch_context: context };
  s.store.put("run", resumed.id, wid, resumed);
  s.store.put("session_input", resumed.id, wid, {
    run_id: resumed.id, kind: "followup", user_input: true, stage_key: "fixture",
    message_ids: ["user-message"], state: "delivered",
  });
  const workflow = s.engine.transition(wid, ["QUEUED"], "EXECUTING", "executor_test", { run_id: resumed.id });
  const runtime = new ProfileRuntime(s.engine, {} as any);
  vi.spyOn(runtime as any, "invoke").mockResolvedValue({
    status: "completed", summary: "已完成整改后的执行测试", completed_items: ["t1"], unfinished_items: [],
  });

  await runtime.execute(workflow, resumed, "fixture-token");
  expect(s.engine.get(wid)).toMatchObject({ state: "HUMAN_PENDING", stage: "accept" });
  expect(s.store.events(wid).some(e => e.type === "UserGuidanceCompleted")).toBe(false);
});

it("checks a guided completion claim that still lists unfinished work", async () => {
  const { s, r, wid } = guidedExecution("implement", "before_human");
  await s.engine.receiveRoundResult(wid, r.id, {
    status: "completed", summary: "已完成", unfinished_items: [{ id: "t1", reason: "仍待处理" }],
  });
  expect(s.engine.get(wid)).toMatchObject({ state: "QUEUED", stage: "implement" });
  expect(s.store.get("execution_auto_continuation", r.id)).toMatchObject({ mode: "clarify" });
  expect(s.store.list("delivery", wid)).toHaveLength(0);
});
