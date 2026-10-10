import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setup, project, plan, publishPlanFixture } from "../helpers.js";
import { ProfileRuntime } from "../../packages/runtime/src/profile-runtime.js";
import type { Run, Workflow } from "../../packages/contracts/src/index.js";
import type { ProcessManager } from "../../packages/process/src/manager.js";
import { readFileSync } from "node:fs";

let s: ReturnType<typeof setup>;
const wid = "review-handoff";
const findings = Array.from({ length: 10 }, (_, i) => ({
  id: `F${i + 1}`, severity: "P1" as const, repo_id: "main", path: `src/module-${i + 1}.ts`, line: i + 1,
  trigger: `trigger ${i + 1}`, evidence: `exact evidence ${i + 1}`, consequence: `impact ${i + 1}`,
  suggestion: `repair suggestion ${i + 1}`, disposition: "confirmed" as const, relation_to_change: "in_scope" as const,
}));
beforeEach(() => {
  s = setup();
  s.store.put("project", "p1", "p1", project(s.root));
  const time = new Date().toISOString();
  const w: Workflow = { id: wid, project_id: "p1", title: "review repair", request: "same approved scope",
    complexity: "simple", workspace_mode: "existing_workspace", state: "REVIEWING", stage: "quality_before_human",
    run_id: "original-review", review_request_id: "review-request", quality_policy_version: 2,
    version: 3, plan_revision: 1, plan_hash: "approved-hash", environment_revision: 0, feedback: [], created_at: time, updated_at: time };
  s.store.put("workflow", wid, "p1", w);
  s.store.put("workspace", `${wid}-workspace`, wid, { id: `${wid}-workspace`, workflow_id: wid, repo_id: "main", root: s.root, source_root: s.root });
  s.store.put("plan", `${wid}-1`, wid, { id: `${wid}-1`, revision: 1, hash: "approved-hash", plan: { ...plan("project-hash", "a".repeat(40)), task_model: "native-v2", markdown: "# Approved repair plan\nRepair the original review findings within scope.\n" } });
  publishPlanFixture(s.engine, wid);
  s.store.put("run", "original-review", wid, { id: "original-review", workflow_id: wid, plan_revision: 1,
    adapter: "codex", purpose: "quality_review", protocol: "lightweight", stage: "quality_before_human",
    status: "running", started_at: time, package_hash: "review-package" });
  s.store.put("plan_check_review_intent", wid, wid, { review_run_id: "original-review", phase: "before_human" });
  vi.spyOn(s.engine, "dispatch").mockResolvedValue(undefined);
});
afterEach(() => { vi.restoreAllMocks(); s.store.close(); });

async function receive() {
  const approved = s.engine.plan(wid);
  await s.engine.receiveReview(wid, { verdict: "changes_required", summary: "Fix all ten findings", findings,
    repair_document: "Apply F1 through F10 within the approved scope; preserve completed work." });
  const assignment = s.store.must<any>("repair_assignment", wid);
  expect(s.engine.plan(wid)).toEqual(approved);
  expect(s.engine.get(wid)).toMatchObject({ plan_revision: 1, plan_hash: "approved-hash" });
  return assignment;
}
function materials(assignment: any, extra: Partial<Run> = {}) {
  const run: Run = { id: "repair-run", workflow_id: wid, plan_revision: 1, adapter: "agy", purpose: "implement",
    quality_policy_version: 2, assignment_id: assignment.assignment_id, routing_role: "review_fixer",
    stage: "execute", status: "running", started_at: new Date().toISOString(), package_hash: "repair-package", ...extra };
  return (new ProfileRuntime(s.engine, {} as ProcessManager) as any).executeMaterials(s.engine.get(wid), run);
}

it("carries all ten original findings from receiveReview through the assignment into actual execution materials", async () => {
  const assignment = await receive();
  expect(assignment.source_review).toMatchObject({ run_id: "original-review", findings });
  const result = materials(assignment);
  expect(result.source_review.findings).toEqual(findings);
  expect(result.source_review.run_id).toBe("original-review");
  expect(result.repair_instructions).toBe(assignment.instructions);
  expect(result.instructions).toContain("按问题编号逐项修复");
  const approved = s.engine.plan(wid);
  expect(result.plan).toMatchObject({ id: approved.id, revision: approved.revision, hash: approved.hash,
    material_id: approved.material_id, markdown: approved.plan.markdown });
  expect(readFileSync(result.plan.path, "utf8")).toBe(approved.plan.markdown);
  expect(result.plan.plan.scope).toMatchObject({ ...approved.plan.scope, allowed_paths: [], repository_paths: {} });
  expect(s.engine.plan(wid)).toEqual(approved);
});

it("backfills a legacy assignment and review lacking run_id from the exact saved review pointer", async () => {
  const assignment = await receive();
  delete assignment.source_review;
  s.store.put("repair_assignment", wid, wid, assignment);
  const saved = s.store.must<any>("review", "review-request");
  delete saved.run_id;
  s.store.put("review", "review-request", wid, saved);
  s.store.put("review", "unrelated", wid, { ...saved, review_request_id: "unrelated", run_id: "other-review", findings: [{ id: "unrelated" }] });
  expect(materials(assignment).source_review).toMatchObject({ run_id: "original-review", findings });
});

it.each(["plan_revision", "plan_hash", "assignment", "aside", "pointer"])("does not inject a review with mismatched %s", async (kind) => {
  const assignment = await receive();
  const extra: Partial<Run> = {};
  if (kind === "plan_revision") assignment.plan_revision = 2;
  if (kind === "plan_hash") assignment.plan_hash = "other-plan";
  if (kind === "assignment") extra.assignment_id = "other-assignment";
  if (kind === "aside") extra.purpose = "aside";
  if (kind === "pointer") {
    delete assignment.source_review;
    const saved = s.store.must<any>("review", "review-request"); delete saved.run_id;
    s.store.put("review", "review-request", wid, saved);
    s.store.put("plan_check_review_intent", wid, wid, { review_run_id: "other-review" });
  }
  s.store.put("repair_assignment", wid, wid, assignment);
  expect(materials(assignment, extra).source_review).toBeNull();
});
