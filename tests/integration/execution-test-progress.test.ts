import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setup, plan, project } from "../helpers.js";
import { recordExecutionTestReport, reportedTestProgress } from "../../packages/core/src/execution-test-progress.js";
import { testProgress } from "../../packages/core/src/progress.js";
import { normalizeOptionalDeliveryManifest, type Run, type Workflow } from "../../packages/contracts/src/index.js";

let s: ReturnType<typeof setup>;
const wid = "reported-tests";
beforeEach(() => {
  s = setup();
  const p = plan("a".repeat(64), "b".repeat(40)); p.task_model = "native-v2";
  p.tests[0]!.expected_case_ids = ["case-a", "case-b"];
  p.tests.push({ ...p.tests[0]!, id: "IT01", layer: "integration", expected_case_ids: ["IT01"] });
  s.store.put("project", "p1", "p1", project(s.root));
  const w: Workflow = { id: wid, project_id: "p1", title: "reports", request: "original scope", complexity: "simple",
    workspace_mode: "existing_workspace", state: "EXECUTING", stage: "execute", plan_revision: 1, plan_hash: "plan-hash",
    environment_revision: 0, quality_policy_version: 2, run_id: "executor", version: 1, feedback: [],
    created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  s.store.put("workflow", wid, "p1", w);
  s.store.put("plan", `${wid}-1`, wid, { id: `${wid}-1`, plan: p, hash: w.plan_hash, revision: 1 });
  s.store.put("run", "executor", wid, { id: "executor", workflow_id: wid, adapter: "agy", purpose: "implement",
    protocol: "lightweight", stage: "execute", status: "running", plan_revision: 1, quality_policy_version: 2,
    started_at: new Date().toISOString(), package_hash: "package" });
  vi.spyOn(s.engine, "dispatch").mockResolvedValue(undefined);
});
afterEach(() => { vi.restoreAllMocks(); s.store.close(); });
function both() {
  const detail = s.engine.detail(wid, false).test_progress;
  expect(s.engine.summary(wid).test_progress).toEqual(detail);
  return detail;
}
const passed = { test_id: "UT01", case_id: "case-a", status: "passed" };

it("persists partial optional results on need_user and retains them through review", async () => {
  await s.engine.receiveRoundResult(wid, "executor", { status: "need_user", summary: "Need external credentials",
    delivery: { test_results: [passed, { test_id: "IT01", status: "not_run", summary: "No test credentials" }] } });
  expect(s.engine.get(wid).state).toBe("WAITING_INPUT");
  expect(s.store.must<any>("execution_test_report", "executor").material.test_results).toHaveLength(2);
  expect(both()).toMatchObject({ total: 3, passed: 1, unreported: 1 });
  expect(both().cases.map(c => c.status)).toEqual(["passed", "unreported", "not_run"]);
  expect(both().cases[0]).toMatchObject({ report_source: "executor_report", report_run_id: "executor" });
  expect((both().cases[0] as any).reported_at).toBe(s.store.must<any>("execution_test_report", "executor").recorded_at);
  const w = s.engine.get(wid);
  s.store.put("workflow", wid, "p1", { ...w, state: "REVIEWING", stage: "quality_before_human", run_id: "reviewer" });
  expect(both()).toMatchObject({ passed: 1, unreported: 1 });
});

it("completed reports reach review without requiring all planned results", async () => {
  s.store.put("run", "executor", wid, { ...s.store.must<Run>("run", "executor"), status: "completed" });
  await s.engine.receiveRoundResult(wid, "executor", { status: "completed", summary: "Implementation completed",
    test_results: [passed] });
  expect(s.engine.get(wid).state).toBe("REVIEW_QUEUED");
  expect(both()).toMatchObject({ total: 3, passed: 1, unreported: 2 });
});

it("a later explicit case result replaces that case and preserves untouched results", () => {
  const w = s.engine.get(wid), run = s.store.must<Run>("run", "executor");
  recordExecutionTestReport(s.store, w, run, { test_results: [passed, { test_id: "IT01", status: "skipped" }] });
  recordExecutionTestReport(s.store, w, { ...run, id: "retry" }, { test_results: [{ ...passed, status: "failed" }] });
  expect(both().cases.map(c => c.status)).toEqual(["failed", "unreported", "skipped"]);
});

it("does not promote command exits, mappings, unknown cases, or invalid status rows to passed", async () => {
  await s.engine.receiveRoundResult(wid, "executor", { status: "need_user", summary: "Pending actual acceptance",
    delivery: { test_executions: [{ tool_call_id: "test", command: "test", exit_code: 0, report_paths: [] }],
      acceptance_mappings: [{ requirement_id: "UT01", scene_id: "case-a", case_id: "case-a", test_execution_id: "test", report_path: "report.json" }],
      test_results: [{ ...passed, status: "unknown" }, { ...passed, case_id: "unknown-case" }, { ...passed, case_id: undefined }] } });
  expect(both()).toMatchObject({ passed: 0, unreported: 3 });
});

it("excludes aside and mismatched plans while leaving legacy test progress unchanged", () => {
  const w = s.engine.get(wid), run = s.store.must<Run>("run", "executor");
  recordExecutionTestReport(s.store, w, { ...run, purpose: "aside" }, { test_results: [passed] });
  recordExecutionTestReport(s.store, w, run, { plan_hash: "other-plan", test_results: [passed] });
  expect(s.store.list("execution_test_report", wid)).toEqual([]);
  recordExecutionTestReport(s.store, w, run, { test_results: [passed] });
  s.store.put("workflow", wid, "p1", { ...w, plan_hash: "other-plan" });
  expect(both()).toMatchObject({ passed: 0, unreported: 3 });
  const p = s.engine.plan(wid); p.plan.task_model = "leaf-v1";
  s.store.put("plan", `${wid}-1`, wid, p);
  expect(both().cases.every(c => c.status === "not_run")).toBe(true);
});

it("normalizes optional result rows independently instead of discarding valid siblings", () => {
  const value = normalizeOptionalDeliveryManifest({ status: "need_user", test_results: [passed, { test_id: "bad" }] });
  expect(value.status).toBe("need_user");
  expect(value.test_results).toEqual([passed]);
});

it("uses the uniquely named planned test when the model puts a test file in its case field", () => {
  const w = s.engine.get(wid), run = s.store.must<Run>("run", "executor");
  recordExecutionTestReport(s.store, w, run, { test_results: [
    { test_id: "IT01", case_id: "tests/integration/real.spec.ts", status: "passed", summary: "Model reported its result" },
    { test_id: "UT01", case_id: "tests/unit/ambiguous.spec.ts", status: "passed" },
    { test_id: "not-in-plan", case_id: "case-a", status: "passed" },
  ] });
  expect(both().cases.map(c => c.status)).toEqual(["unreported", "unreported", "passed"]);
  expect(both().cases[2]).toMatchObject({ id: "IT01", report_source: "executor_report", summary: "Model reported its result" });
});

it("uses a newer explicit report in place of stale evidence without changing the evidence record", () => {
  const w = s.engine.get(wid), run = s.store.must<Run>("run", "executor"), p = s.engine.plan(wid).plan;
  recordExecutionTestReport(s.store, w, run, { test_results: [passed] });
  const evidence = { id: "old-evidence", created_at: "2020-01-01T00:00:00.000Z", status: "passed" };
  s.store.put("evidence", evidence.id, wid, evidence);
  const base = testProgress(p, [], w);
  base.cases[0] = { ...base.cases[0]!, status: "stale", evidence_id: evidence.id, last_status: "passed" };
  const projected = reportedTestProgress(s.store, w, p, base);
  expect(projected.cases[0]).toMatchObject({ status: "passed", report_source: "executor_report", evidence_id: undefined });
  expect(s.store.get("evidence", evidence.id)).toEqual(evidence);
  // The same report cannot override a newer stale result or a valid result.
  s.store.put("evidence", evidence.id, wid, { ...evidence, created_at: "2099-01-01T00:00:00.000Z" });
  expect(reportedTestProgress(s.store, w, p, base).cases[0]).toEqual(base.cases[0]);
  base.cases[0] = { ...base.cases[0]!, status: "failed" };
  expect(reportedTestProgress(s.store, w, p, base).cases[0]).toEqual(base.cases[0]);
});

it("retains the original report time across stages and marks an environment change stale only for integration", () => {
  const w = s.engine.get(wid), run = s.store.must<Run>("run", "executor");
  recordExecutionTestReport(s.store, w, run, { test_results: [passed, { test_id: "IT01", status: "passed" }] });
  const time = s.store.must<any>("execution_test_report", run.id).recorded_at;
  s.store.put("workflow", wid, "p1", { ...w, state: "REVIEWING", environment_revision: 1 });
  expect(both().cases.map(c => c.status)).toEqual(["passed", "unreported", "stale"]);
  expect((both().cases[0] as any).reported_at).toBe(time);
  expect((both().cases[2] as any).reported_at).toBe(time);
});
