import { normalizeOptionalDeliveryManifest, type DeliveryManifest, type Plan, type Run, type Workflow } from "../../contracts/src/index.js";
import type { Store } from "../../store/src/store.js";
import type { testProgress } from "./progress.js";
import { now } from "./util.js";

type TestReport = {
  run_id: string;
  workflow_id: string;
  plan_revision: number;
  plan_hash?: string;
  environment_revision: number;
  source: "executor_report";
  recorded_at: string;
  material: DeliveryManifest;
};

/** Optional display material is retained even when the executor needs input.
 * It does not approve the round, import evidence, or change workflow routing. */
export function recordExecutionTestReport(store: Store, w: Workflow, run: Run, value: unknown) {
  if (run.workflow_id !== w.id || run.plan_revision !== w.plan_revision ||
      !["implement", "executor_test", "functional_fix", "planner_takeover"].includes(run.purpose ?? "implement")) return;
  const material = normalizeOptionalDeliveryManifest(value);
  if ((material.workflow_id && material.workflow_id !== w.id) ||
      (material.run_id && material.run_id !== run.id) ||
      (material.plan_revision !== undefined && material.plan_revision !== w.plan_revision) ||
      (material.plan_hash && material.plan_hash !== w.plan_hash)) return;
  const report: TestReport = { run_id: run.id, workflow_id: w.id, plan_revision: w.plan_revision,
    plan_hash: w.plan_hash, environment_revision: w.environment_revision, source: "executor_report",
    recorded_at: now(), material };
  store.put("execution_test_report", run.id, w.id, report);
}

/** Project explicitly reported plan cases. A command exit or a mapping alone
 * says nothing about whether the planned scenario passed. */
export function reportedTestProgress(store: Store, w: Workflow, plan: Plan | null, base: ReturnType<typeof testProgress>) {
  if (plan?.task_model !== "native-v2") return base;
  const reports = store.list<TestReport>("execution_test_report", w.id)
    .filter(r => r.plan_revision === w.plan_revision && r.plan_hash === w.plan_hash)
    .sort((a, b) => a.recorded_at.localeCompare(b.recorded_at));
  const latest = new Map<string, { report: TestReport; result: NonNullable<DeliveryManifest["test_results"]>[number] }>();
  for (const report of reports) {
    for (const result of report.material.test_results ?? []) {
      const test = plan.tests.find(t => t.id === result.test_id);
      // A precise test ID already identifies its sole planned case. Providers
      // sometimes put the executed file/class in case_id; retain that explicit
      // report without guessing between cases of a multi-case test.
      const caseId = test?.expected_case_ids.includes(result.case_id ?? "") ? result.case_id
        : test?.expected_case_ids.length === 1 ? test.expected_case_ids[0] : undefined;
      if (!caseId || !test?.expected_case_ids.includes(caseId)) continue;
      latest.set(`${test.id}:${caseId}`, { report, result });
    }
  }
  const cases = base.cases.map(c => {
    const entry = latest.get(`${c.test_id}:${c.id}`);
    // Valid imported evidence remains authoritative. A newer explicit report
    // may supersede a stale display row, never mutate the evidence itself.
    if (c.evidence_id) {
      if (c.status !== "stale" || !entry) return c;
      const evidence = store.get<{ created_at?: string }>("evidence", c.evidence_id) ??
        store.get<{ created_at?: string }>("development_evidence", c.evidence_id);
      const acceptance = store.get<{ delivery_id?: string }>("acceptance_result", c.evidence_id);
      const deliveredAt = acceptance?.delivery_id
        ? store.get<{ submitted_at?: string }>("delivery", acceptance.delivery_id)?.submitted_at : undefined;
      const priorTime = Date.parse(evidence?.created_at ?? deliveredAt ?? "");
      if (!Number.isFinite(priorTime) || Date.parse(entry.report.recorded_at) <= priorTime) return c;
    }
    if (!entry) return { ...c, status: "unreported" };
    const stale = c.layer !== "unit" && entry.report.environment_revision !== w.environment_revision;
    return { ...c, status: stale ? "stale" : entry.result.status, last_status: entry.result.status, evidence_id: undefined,
      report_source: entry.report.source, report_run_id: entry.report.run_id, reported_at: entry.report.recorded_at,
      summary: entry.result.summary };
  });
  return { ...base, cases, passed: cases.filter(c => c.status === "passed").length,
    failed: cases.filter(c => c.status === "failed").length, stale: cases.filter(c => c.status === "stale").length,
    previously_passed: cases.filter(c => c.status === "stale" && c.last_status === "passed").length,
    unreported: cases.filter(c => c.status === "unreported").length };
}
