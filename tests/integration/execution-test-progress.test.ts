import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setup, plan, project } from "../helpers.js";
import { recordExecutionTestReport, reportedTestProgress } from "../../packages/core/src/execution-test-progress.js";
import { testProgress } from "../../packages/core/src/progress.js";
import { normalizeOptionalDeliveryManifest, type Run, type Workflow } from "../../packages/contracts/src/index.js";
import { prepareTaskList, syncTaskList, taskListSnapshot } from "../../packages/core/src/task-list.js";
import { projectWorkflowOverview } from "../../packages/core/src/workflow-overview.js";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TaskListSchema, type TaskList } from "../../packages/contracts/src/task-list.js";
import * as materialFilesystem from "../../packages/core/src/material-filesystem.js";

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
    user_interaction: { kind: "action_required", title: "Sign in to the test environment",
      message: "Sign in with the test account, then confirm to resume the integration tests." },
    delivery: { test_results: [passed, { test_id: "IT01", status: "not_run", summary: "No test credentials" }] } });
  expect(s.engine.get(wid).state).toBe("WAITING_INPUT");
  expect(s.store.list("execution_auto_continuation", wid)).toHaveLength(0);
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

it("prepareTaskList 为执行阶段初始化任务清单时，任务初始为 pending 且测试为 not_run，概览投影为 pending", () => {
  const w = s.engine.get(wid), run = s.store.must<Run>("run", "executor");
  const planRecord = s.engine.plan(wid);
  const planFile = join(s.root, "plan.md");
  writeFileSync(planFile, "# Plan\n");
  const record = { ...planRecord, material_path: planFile };

  const taskListFile = prepareTaskList(s.store, w, run, record);
  expect(taskListFile).toBeDefined();

  const diskContent = JSON.parse(readFileSync(taskListFile!, "utf8"));
  expect(diskContent.tasks.every((t: any) => t.status === "pending")).toBe(true);
  expect(diskContent.tests.every((t: any) => t.status === "not_run")).toBe(true);

  const detail = s.engine.detail(wid, false);
  const overview = projectWorkflowOverview(detail);
  expect(overview.tasks.every((t: any) => t.status === "pending")).toBe(true);
  expect(overview.tests.every((t: any) => t.status === "pending")).toBe(true);
});

it("prepareTaskList 正常接管来自人工验收派发的修复运行 (human_acceptance)", () => {
  const w = s.engine.get(wid);
  const fixRun: Run = {
    id: "fix-run-1",
    workflow_id: wid,
    adapter: "agy",
    purpose: "functional_fix",
    protocol: "lightweight",
    stage: "execute",
    status: "running",
    plan_revision: 1,
    quality_policy_version: 2,
    started_at: new Date().toISOString(),
    package_hash: "package",
    dispatch_context: {
      purpose: "functional_fix",
      guidance_mode: "human_acceptance",
    },
  };
  s.store.put("run", fixRun.id, wid, fixRun);
  s.store.put("workflow", wid, "p1", { ...w, run_id: fixRun.id });

  const planRecord = s.engine.plan(wid);
  const planFile = join(s.root, "plan.md");
  writeFileSync(planFile, "# Plan\n");
  const record = { ...planRecord, material_path: planFile };

  const taskListFile = prepareTaskList(s.store, { ...w, run_id: fixRun.id }, fixRun, record);
  expect(taskListFile).toBeDefined();

  const diskContent = JSON.parse(readFileSync(taskListFile!, "utf8"));
  expect(diskContent.writer_run_id).toBe("fix-run-1");
});

it("syncTaskList 能够准确区分错误分类、保留上次有效进度并在合法恢复时自动清除告警", () => {
  const w = s.engine.get(wid);
  const run = s.store.must<Run>("run", "executor");
  const planRecord = s.engine.plan(wid);
  const planFile = join(s.root, "plan.md");
  writeFileSync(planFile, "# Plan\n");
  const record = { ...planRecord, material_path: planFile };
  const taskListFile = prepareTaskList(s.store, w, run, record)!;

  // 1. 正常写入一次进度并同步
  const validList = JSON.parse(readFileSync(taskListFile, "utf8"));
  validList.tasks[0].status = "in_progress";
  writeFileSync(taskListFile, JSON.stringify(validList, null, 2));
  syncTaskList(s.store, w);

  let snap = taskListSnapshot(s.store, w)!;
  expect(snap.error).toBeUndefined();
  expect(snap.list.tasks[0]?.status).toBe("in_progress");

  // 2. 写入无效 JSON，断言错误分类为语法无效，且保留上次有效进度
  writeFileSync(taskListFile, "{ invalid json content");
  syncTaskList(s.store, w);
  snap = taskListSnapshot(s.store, w)!;
  expect(snap.error).toBe("任务清单 JSON 解析失败，语法无效，已保留上次进度。");
  expect(snap.list.tasks[0]?.status).toBe("in_progress");

  // 3. 写入归属错误的 writer_run_id，断言归属冲突
  const wrongWriterList = { ...validList, writer_run_id: "other-intruder" };
  writeFileSync(taskListFile, JSON.stringify(wrongWriterList, null, 2));
  syncTaskList(s.store, w);
  snap = taskListSnapshot(s.store, w)!;
  expect(snap.error).toBe("任务清单写入者归属冲突，非当前授权运行，已保留上次进度。");
  expect(snap.list.tasks[0]?.status).toBe("in_progress");

  // 4. 模拟运行已中断/结束（非 running，且非 finishingRun），旧写入者在失去权限后写入新状态并恢复合法结构
  s.store.put("run", "executor", wid, { ...run, status: "stopped" });
  s.store.put("workflow", wid, "p1", { ...w, state: "BLOCKED" });
  validList.tasks[0].status = "completed";
  writeFileSync(taskListFile, JSON.stringify(validList, null, 2));

  // 调用 syncTaskList 进行告警恢复：告警恢复与进度接收严格隔离，已失去写入权限的运行无法改变任务状态
  syncTaskList(s.store, s.engine.get(wid));
  snap = taskListSnapshot(s.store, s.engine.get(wid))!;
  expect(snap.error).toBeUndefined();
  expect(snap.list.tasks[0]?.status).toBe("in_progress"); // 严格保留上次合法进度，不接收撤权后的新状态
});

function acceptedTaskList() {
  const w = s.engine.get(wid);
  const run = s.store.must<Run>("run", "executor");
  const planFile = join(s.root, "plan.md");
  writeFileSync(planFile, "# Plan\n");
  const record = { ...s.engine.plan(wid), material_path: planFile };
  const file = prepareTaskList(s.store, w, run, record)!;
  const list = TaskListSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  list.tasks[0]!.status = "completed";
  list.tests[0]!.status = "passed";
  list.checks[0]!.status = "passed";
  writeFileSync(file, JSON.stringify(list));
  syncTaskList(s.store, w);
  return { w, run, record, file, list };
}

function successor(w: Workflow, run: Run) {
  const nextRun: Run = { ...run, id: "successor", status: "running" };
  const nextWorkflow: Workflow = { ...w, state: "EXECUTING", run_id: nextRun.id };
  s.store.put("run", nextRun.id, wid, nextRun);
  s.store.put("workflow", wid, "p1", nextWorkflow);
  return { nextRun, nextWorkflow };
}

it.each(["stopped", "failed", "completed"] as const)("交接不接收 %s 运行的迟到进度", (status) => {
  const { w, run, record, file, list } = acceptedTaskList();
  s.store.put("run", run.id, wid, { ...run, status });
  if (status === "stopped") s.store.put("run_stop", run.id, wid, { source: "controller" });
  list.tasks[0]!.status = "pending";
  list.tests[0]!.status = "failed";
  writeFileSync(file, JSON.stringify(list));
  const { nextRun, nextWorkflow } = successor(w, run);

  prepareTaskList(s.store, nextWorkflow, nextRun, record);

  const snapshot = taskListSnapshot(s.store, nextWorkflow)!;
  expect(snapshot.list.writer_run_id).toBe(nextRun.id);
  expect(snapshot.list.tasks[0]!.status).toBe("completed");
  expect(snapshot.list.tests[0]!.status).toBe("passed");
  expect(snapshot.list.checks[0]!.status).toBe("passed");
  expect(TaskListSchema.parse(JSON.parse(readFileSync(file, "utf8")))).toEqual(snapshot.list);
  expect(s.store.must<{ writer: string }>("task_list_binding", wid).writer).toBe(nextRun.id);
});

function invalidateTaskList(list: TaskList, kind: "missing-task" | "duplicate-test" | "unknown-check") {
  if (kind === "missing-task") list.tasks = [];
  if (kind === "duplicate-test") list.tests[1] = { ...list.tests[0]! };
  if (kind === "unknown-check") list.checks[0]!.id = "not-approved";
}

it.each(["missing-task", "duplicate-test", "unknown-check"] as const)("%s 错误在结束后仍保留，合法修复仅清除告警", (kind) => {
  const { w, run, file, list } = acceptedTaskList();
  const accepted = taskListSnapshot(s.store, w)!.list;
  invalidateTaskList(list, kind);
  writeFileSync(file, JSON.stringify(list));
  syncTaskList(s.store, w);
  const invalid = taskListSnapshot(s.store, w)!;
  expect(invalid.error).toBeDefined();
  s.store.put("run", run.id, wid, { ...run, status: "failed" });
  s.store.put("workflow", wid, "p1", { ...w, state: "BLOCKED" });

  syncTaskList(s.store, s.engine.get(wid));
  expect(taskListSnapshot(s.store, w)).toEqual(invalid);

  const repaired = { ...accepted, tasks: accepted.tasks.map(t => ({ ...t, status: "pending" as const })) };
  writeFileSync(file, JSON.stringify(repaired));
  syncTaskList(s.store, s.engine.get(wid));
  expect(taskListSnapshot(s.store, w)!.error).toBeUndefined();
  expect(taskListSnapshot(s.store, w)!.list).toEqual(accepted);
});

it.each(["missing-task", "duplicate-test", "unknown-check"] as const)("交接遇到 %s 时从合法快照重建，不重置已有结果", (kind) => {
  const { w, run, record, file, list } = acceptedTaskList();
  const accepted = taskListSnapshot(s.store, w)!.list;
  invalidateTaskList(list, kind);
  writeFileSync(file, JSON.stringify(list));
  syncTaskList(s.store, w);
  expect(taskListSnapshot(s.store, w)!.error).toBeDefined();
  const { nextRun, nextWorkflow } = successor(w, run);

  prepareTaskList(s.store, nextWorkflow, nextRun, record);

  const expected = { ...accepted, writer_run_id: nextRun.id };
  expect(taskListSnapshot(s.store, nextWorkflow)!.list).toEqual(expected);
  expect(taskListSnapshot(s.store, nextWorkflow)!.error).toBeUndefined();
  expect(TaskListSchema.parse(JSON.parse(readFileSync(file, "utf8")))).toEqual(expected);
});

it("交接比较替换失败时不发布快照、绑定或进度事件", () => {
  const { w, run, record, file, list } = acceptedTaskList();
  writeFileSync(file, "{ invalid");
  syncTaskList(s.store, w);
  writeFileSync(file, JSON.stringify(list));
  const beforeSnapshot = taskListSnapshot(s.store, w);
  const beforeBinding = s.store.get("task_list_binding", wid);
  const { nextRun, nextWorkflow } = successor(w, run);
  const beforeEvents = s.store.events(wid);
  const replace = materialFilesystem.replaceMaterialFile;
  const concurrent = JSON.stringify({ ...list, updated_at: "concurrent-write" });
  vi.spyOn(materialFilesystem, "replaceMaterialFile").mockImplementationOnce((...args) => {
    writeFileSync(file, concurrent);
    replace(...args);
  });

  expect(() => prepareTaskList(s.store, nextWorkflow, nextRun, record)).toThrow();
  expect(taskListSnapshot(s.store, nextWorkflow)).toEqual(beforeSnapshot);
  expect(s.store.get("task_list_binding", wid)).toEqual(beforeBinding);
  expect(s.store.events(wid)).toEqual(beforeEvents);
  expect(readFileSync(file, "utf8")).toBe(concurrent);
});

it("交接文件已替换但数据库登记失败时回滚文件和绑定", () => {
  const { w, run, record, file } = acceptedTaskList();
  const beforeFile = readFileSync(file, "utf8");
  const beforeSnapshot = taskListSnapshot(s.store, w);
  const beforeBinding = s.store.get("task_list_binding", wid);
  const { nextRun, nextWorkflow } = successor(w, run);
  const beforeEvents = s.store.events(wid);
  const put = s.store.put.bind(s.store);
  vi.spyOn(s.store, "put").mockImplementation((kind, key, owner, value) => {
    if (kind === "task_list_snapshot") throw new Error("snapshot persistence failed");
    return put(kind, key, owner, value);
  });

  expect(() => prepareTaskList(s.store, nextWorkflow, nextRun, record)).toThrow("snapshot persistence failed");
  expect(taskListSnapshot(s.store, nextWorkflow)).toEqual(beforeSnapshot);
  expect(s.store.get("task_list_binding", wid)).toEqual(beforeBinding);
  expect(s.store.events(wid)).toEqual(beforeEvents);
  expect(readFileSync(file, "utf8")).toBe(beforeFile);
});