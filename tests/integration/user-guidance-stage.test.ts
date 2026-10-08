import { afterEach, expect, it } from "vitest";
import { setup, plan, project } from "../helpers.js";
import type { Run, Workflow } from "../../packages/contracts/src/index.js";

const stores: ReturnType<typeof setup>[] = [];
afterEach(() => { for (const s of stores.splice(0)) s.store.close(); });

it.each(["executor_test", "planner_takeover", "planner_commit"] as const)(
  "a completed user reply cannot complete the scheduled %s stage", async purpose => {
    const s = setup(); stores.push(s);
    const wid = "guidance-stage", time = new Date().toISOString();
    s.store.put("project", "p1", "p1", project(s.root));
    const w: Workflow = { id: wid, project_id: "p1", title: "guidance", request: "original", complexity: "simple",
      workspace_mode: "existing_workspace", state: "EXECUTING", stage: purpose, plan_revision: 1, plan_hash: "approved",
      run_id: "guided-run", environment_revision: 0, quality_policy_version: 2, version: 1,
      feedback: ["你是卡住了吗？"], created_at: time, updated_at: time };
    const r: Run = { id: "guided-run", workflow_id: wid, plan_revision: 1, adapter: "agy", purpose,
      profile: { id: "executor", adapterId: "agy", revision: 1, modelSelection: "explicit", modelId: "fixture-model",
        reasoning: { mode: "not-applicable" }, options: {} }, protocol: "lightweight", stage: purpose,
      status: "completed", exit_code: 0, started_at: time,
      package_hash: "fixture-package",
      dispatch_context: { purpose, review_phase: "after_human", source_run_id: "prior-repair" } };
    const p = plan("project", "a".repeat(40)); p.task_model = "native-v2";
    s.store.put("workflow", wid, "p1", w);
    s.store.put("plan", `${wid}-1`, wid, { revision: 1, hash: "approved", plan: p });
    s.store.put("run", r.id, wid, r);
    s.store.put("quality_flow", wid, wid, { workflow_id: wid, phase: "after_human", planner_repairs_only: true });
    s.store.put("session_input", r.id, wid, { run_id: r.id, kind: "followup", user_input: true,
      stage_key: "fixture", message_ids: ["user-message"], state: "delivered" });
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
