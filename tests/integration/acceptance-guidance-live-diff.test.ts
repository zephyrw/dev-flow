import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { setup, repository, project, plan, publishPlanFixture } from "../helpers.js";
import { objectHash } from "../../packages/core/src/util.js";
import { ProfileRuntime } from "../../packages/runtime/src/profile-runtime.js";
import type { Run, Workflow } from "../../packages/contracts/src/index.js";

it("reviews current tracked and untracked guidance changes after an older snapshot without changing plan or test progress", async () => {
  const s = setup();
  try {
    const repo = await repository(s.root);
    const p = project(repo.repo), wid = "guidance-live-diff", time = new Date().toISOString();
    const originalPlan = { id: `${wid}-1`, revision: 1, hash: "approved", plan: {
      ...plan(objectHash(p), repo.baseline), task_model: "native-v2" as const,
      markdown: "# Approved guidance plan\nPreserve completed work and test progress.\n",
    } };
    s.store.put("project", p.id, p.id, p);
    s.store.put("plan", `${wid}-1`, wid, originalPlan);
    const workflow: Workflow = { id: wid, project_id: p.id, title: "guidance", request: "original request",
      complexity: "simple", workspace_mode: "existing_workspace", state: "HUMAN_PENDING", stage: "accept",
      quality_policy_version: 2, plan_revision: 1, plan_hash: "approved", environment_revision: 0,
      version: 1, feedback: [], created_at: time, updated_at: time };
    s.store.put("workflow", wid, p.id, workflow);
    await s.engine.git.prepare(p, wid, "existing_workspace", { main: repo.baseline });
    publishPlanFixture(s.engine, wid);
    const approvedPlan = s.engine.plan(wid);
    writeFileSync(join(repo.repo, "app.txt"), "before guidance\n");
    const snapshot = await s.engine.git.snapshot(wid, 0);
    s.store.put("workflow", wid, p.id, { ...workflow, snapshot_id: snapshot.id });
    const report = { run_id: "prior-tests", material: { test_results: [{ test_id: "UT01", status: "passed" }] } };
    s.store.put("execution_test_report", "prior-tests", wid, report);

    s.engine.feedback(wid, "修复验收时发现的文字问题并添加帮助说明", "within_plan");
    const guidance: Run = { id: "guidance-run", workflow_id: wid, adapter: "agy", purpose: "functional_fix",
      dispatch_context: { purpose: "functional_fix", guidance_mode: "human_acceptance" },
      protocol: "lightweight", quality_policy_version: 2, plan_revision: 1, stage: "acceptance_guidance",
      status: "completed", started_at: time, package_hash: "fixture", conversation_id: "existing-session" };
    s.store.put("run", guidance.id, wid, guidance);
    s.store.put("workflow", wid, p.id, { ...s.engine.get(wid), state: "EXECUTING", run_id: guidance.id });
    writeFileSync(join(repo.repo, "app.txt"), "after guidance\n");
    writeFileSync(join(repo.repo, "guidance-help.txt"), "new help content\n");
    await s.engine.receiveRoundResult(wid, guidance.id, { status: "completed", summary: "本轮指导已落实" });
    expect(s.engine.get(wid)).toMatchObject({ state: "HUMAN_PENDING", snapshot_id: snapshot.id });

    const review: Run = { ...guidance, id: "review-run", purpose: "quality_review", dispatch_context: { purpose: "quality_review" }, stage: "review", status: "running" };
    const current = { ...s.engine.get(wid), state: "REVIEWING" as const, stage: "review", run_id: review.id };
    s.store.put("workflow", wid, p.id, current);
    s.store.put("run", review.id, wid, review);
    const runtime = new ProfileRuntime(s.engine, {} as any) as any;
    const material = await runtime.reviewMaterials(current, review, snapshot);
    expect(material.diff_source).toBe("current_workspaces");
    expect(material.diff[0].diff).toContain("+after guidance");
    expect(material.diff[0].diff).not.toContain("+before guidance");
    expect(material.diff[0].paths).toEqual(expect.arrayContaining(["app.txt", "guidance-help.txt"]));
    expect(material.diff[0].untracked_paths).toContain("guidance-help.txt");
    expect(material.instructions).toContain("untracked_paths");
    expect(s.store.must("snapshot", snapshot.id)).toEqual(snapshot);
    expect(s.store.must("plan", `${wid}-1`)).toEqual(approvedPlan);
    expect(s.store.must("execution_test_report", "prior-tests")).toEqual(report);
    const beforeHuman = await runtime.reviewMaterials({ ...current, stage: "quality_before_human" }, review, snapshot);
    expect(beforeHuman.diff[0].diff).toContain("+before guidance");
    expect(beforeHuman.diff_source).toBeUndefined();
  } finally { s.store.close(); }
}, 60000);
