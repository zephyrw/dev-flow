import { randomUUID } from "node:crypto";
import { basename, dirname, resolve } from "node:path";
import { watch, type FSWatcher } from "node:fs";
import { TaskListSchema, type TaskList } from "../../contracts/src/task-list.js";
import type { Plan, Project, Run, Workflow } from "../../contracts/src/index.js";
import type { Store } from "../../store/src/store.js";
import { publishMaterialFile, readMaterialFile, replaceMaterialFile } from "./material-filesystem.js";
import { projectDocsWorkspace } from "./project-materials.js";
import { hash, now } from "./util.js";

export const progressInstructions =
  "任务和测试的顺序、并行方式与测试时机由你根据真实依赖自主决定。每项任务开始、完成、受阻或返工时及时更新 task-list.json 中该项 status（in_progress/completed/blocked）；测试开始或结束时及时更新该场景 status（running/passed/failed/blocked/skipped/stale），受阻或失败说明原因。有多个项目同时执行时各自更新，不等其他项目、批次或本轮结束。只更新实际变化的项目，保留原编号、文件归属及其他结果。并发分工时协调原子保存，或由主执行模型收到单项结果后即时合并。清单状态用于展示，不代替最终回执。";

type Binding = { key: string; root: string; relative: string; revision: number; writer: string | null; definition: TaskList };
type PlanRecord = { plan: Plan; revision: number; material_path?: string };
type Snapshot = { revision: number; seq: number; digest: string; changed_at?: string; error?: string; list: TaskList };
const caseKey = (test: { test_id: string; case_id: string }) => JSON.stringify([test.test_id, test.case_id]);
const encode = (value: TaskList) => Buffer.from(JSON.stringify(value, null, 2) + "\n");
const activePurposes = new Set(["implement", "execute", "executor_test", "functional_fix", "planner_takeover"]);
const terminal = new Set(["COMMITTED", "COMPLETED", "CANCELLED", "ARCHIVED"]);

export function taskListSnapshot(store: Store, w: Workflow) {
  const value = store.get<Snapshot>("task_list_snapshot", w.id);
  return value?.revision === w.plan_revision ? value : undefined;
}

export function taskListView(store: Store, w: Workflow) {
  const snapshot = taskListSnapshot(store, w);
  const binding = store.get<Binding>("task_list_binding", w.id);
  return snapshot && binding?.revision === w.plan_revision
    ? { path: resolve(binding.root, binding.relative), seq: snapshot.seq,
      updated_at: snapshot.changed_at, sync_error: snapshot.error, checks: snapshot.list.checks }
    : undefined;
}

export function taskListWritableDirectory(store: Store, w: Workflow, run: Run) {
  const binding = store.get<Binding>("task_list_binding", w.id);
  if (binding?.revision !== w.plan_revision || binding.writer !== run.id ||
      w.run_id !== run.id || !activePurposes.has(run.purpose ?? "implement")) return;
  return dirname(resolve(binding.root, binding.relative));
}

function save(store: Store, w: Workflow, list: TaskList, error?: string) {
  const last = taskListSnapshot(store, w);
  const digest = hash(JSON.stringify({ tasks: list.tasks, tests: list.tests, checks: list.checks }));
  if (last?.digest === digest && last.error === error) return;
  const snapshot = {
    revision: w.plan_revision, seq: (store.get<Snapshot>("task_list_snapshot", w.id)?.seq ?? 0) + 1,
    digest, changed_at: last?.digest === digest ? last.changed_at : now(), error, list,
  };
  store.transaction(() => {
    store.put("task_list_snapshot", w.id, w.id, snapshot);
    store.event(w.id, w.project_id, "TaskProgressUpdated", { progress_seq: snapshot.seq, sync_error: error }, w.run_id);
  });
}

export function initTaskList(store: Store, w: Workflow, record: PlanRecord, historical = false) {
  if (record.plan.task_model !== "native-v2" || !record.material_path) return;
  const previous = store.get<Binding>("task_list_binding", w.id);
  if (previous?.revision === record.revision) return previous;
  const project = store.get<Project>("project", w.project_id);
  const repo = project?.repositories.find(r => r.id === project.primary_repo_id) ?? project?.repositories[0];
  const root = previous?.root ?? projectDocsWorkspace(store, w.id)?.root ?? repo?.path ?? dirname(record.material_path);
  const relative = previous?.relative ?? `docs/plan/${w.id}/task-list.json`;
  const plan = record.plan;
  const definition: TaskList = {
    schema_version: 1, workflow_id: w.id, plan_revision: record.revision,
    plan_ref: record.material_path, writer_run_id: null,
    tasks: plan.tasks.map(t => ({
      id: t.id, title: t.title, module_id: t.module_id, repo_id: t.repo_id,
      description: plan.work_items?.find(i => i.id === t.id)?.description ?? t.implementation ?? t.title,
      depends_on: t.depends_on, test_ids: t.test_ids,
      completion_criteria: plan.work_items?.find(i => i.id === t.id)?.completion_criteria ?? (t.completion ? [t.completion] : []),
      status: historical ? "unreported" : "pending",
    })),
    tests: plan.tests.flatMap(t => {
      const item = plan.acceptance_items?.find(i => i.id === t.id);
      return t.expected_case_ids.map(case_id => ({
        test_id: t.id, case_id, task_ids: t.task_ids, layer: t.layer,
        scenario: item?.scenario ?? t.steps[0] ?? t.id, expected_outcome: item?.expected_outcome ?? t.assertions[0],
        status: historical ? "unreported" as const : "not_run" as const,
      }));
    }),
    checks: ["typecheck", "build"].map(kind => ({ id: kind, kind: kind as "typecheck" | "build", status: "not_run" })),
  };
  const raw = readMaterialFile(root, relative);
  if (!raw) publishMaterialFile(root, relative, encode(definition), randomUUID());
  else {
    const existing = TaskListSchema.safeParse(JSON.parse(raw.toString("utf8")));
    if (!existing.success || existing.data.workflow_id !== w.id ||
        (existing.data.plan_revision !== record.revision && existing.data.plan_revision !== previous?.revision))
      throw new Error("任务清单已存在，归属无法确认");
    if (existing.data.plan_revision !== record.revision)
      replaceMaterialFile(root, relative, raw, encode(definition), randomUUID());
  }
  const binding: Binding = { key: w.id, root, relative, revision: record.revision, writer: null, definition };
  store.put("task_list_binding", w.id, w.id, binding);
  save(store, { ...w, plan_revision: record.revision }, definition);
  return binding;
}

export function syncTaskList(store: Store, w: Workflow, finishingRun?: string) {
  const binding = store.get<Binding>("task_list_binding", w.id);
  const last = taskListSnapshot(store, w);
  if (!binding || binding.revision !== w.plan_revision || !last) return;
  const run = binding.writer ? store.get<Run>("run", binding.writer) : undefined;
  const writable = !!run && w.run_id === run.id && run.workflow_id === w.id &&
    run.plan_revision === w.plan_revision && (run.status === "running" || finishingRun === run.id) &&
    !store.get("run_stop", run.id);
  if (!writable) return;
  try {
    const raw = readMaterialFile(binding.root, binding.relative);
    if (!raw || raw.length > 4 * 1024 * 1024) throw new Error();
    const list = TaskListSchema.parse(JSON.parse(raw.toString("utf8")));
    if (list.workflow_id !== w.id || list.plan_revision !== w.plan_revision || list.writer_run_id !== binding.writer)
      throw new Error();
    const merge = <T extends { status: string }>(definitions: T[], rows: T[], key: (item: T) => string): T[] => {
      const byKey = new Map(rows.map(r => [key(r), r]));
      if (rows.length !== definitions.length || byKey.size !== definitions.length) throw new Error();
      return definitions.map(item => {
        const row = byKey.get(key(item));
        if (!row) throw new Error();
        // Only accept progress fields; approved definitions are pinned.
        const fields = ["status", "summary", "updated_at", "started_at", "completed_at", "finished_at", "attempt"];
        return { ...item, ...Object.fromEntries(fields.filter(f => f in row).map(f => [f, row[f as keyof T]])) };
      });
    };
    const d = binding.definition;
    save(store, w, {
      ...d, writer_run_id: list.writer_run_id, updated_at: list.updated_at,
      tasks: merge(d.tasks, list.tasks, row => row.id),
      tests: merge(d.tests, list.tests, caseKey),
      checks: merge(d.checks, list.checks, row => row.id),
    });
  } catch {
    save(store, w, last.list, "任务清单暂不可读取或格式无效，已保留上次进度。");
  }
}

export function prepareTaskList(store: Store, w: Workflow, run: Run, record: PlanRecord) {
  if (!activePurposes.has(run.purpose ?? "implement") || run.dispatch_context?.guidance_mode === "human_acceptance" ||
      run.workflow_id !== w.id || run.plan_revision !== w.plan_revision || w.run_id !== run.id ||
      store.get("run_stop", run.id)) return;
  const binding = initTaskList(store, w, record, true);
  if (!binding) return;
  if (binding.writer !== run.id) {
    const last = taskListSnapshot(store, w);
    if (!last) return;
    const raw = readMaterialFile(binding.root, binding.relative);
    const updated = encode({ ...last.list, writer_run_id: run.id });
    if (raw) replaceMaterialFile(binding.root, binding.relative, raw, updated, randomUUID());
    else publishMaterialFile(binding.root, binding.relative, updated, randomUUID());
    store.put("task_list_binding", w.id, w.id, { ...binding, writer: run.id });
    store.event(w.id, w.project_id, "TaskProgressWatch", {}, run.id);
  }
  return resolve(binding.root, binding.relative);
}

/** Update only one item. A concurrent writer can win the replace; reread it
 * before retrying so other independently reported items are preserved. */
export function updateTaskListEntry(file: string, runId: string, kind: string, id: string, status: string, summary?: string, caseId?: string) {
  if (basename(file) !== "task-list.json") throw new Error("需要任务清单文件 task-list.json");
  const root = dirname(resolve(file));
  for (let attempt = 0; attempt < 4; attempt++) {
    const raw = readMaterialFile(root, "task-list.json");
    if (!raw) throw new Error("任务清单不存在");
    const list = TaskListSchema.parse(JSON.parse(raw.toString("utf8")));
    if (list.writer_run_id !== runId) throw new Error("任务清单已交接给其他运行");
    const rows = kind === "task" ? list.tasks.filter(x => x.id === id) :
      kind === "check" ? list.checks.filter(x => x.id === id) :
      kind === "test" ? list.tests.filter(x => x.test_id === id && (!caseId || x.case_id === caseId)) : [];
    if (rows.length !== 1) throw new Error("未找到唯一的任务或测试编号");
    const row = rows[0]!;
    const time = now();
    if ((status === "running" || status === "in_progress") && row.status !== status) {
      row.started_at = time;
      if ("test_id" in row) row.attempt = (row.attempt ?? 0) + 1;
    }
    if ("test_id" in row) row.finished_at = ["passed", "failed", "blocked", "skipped"].includes(status) ? time : null;
    if ("completion_criteria" in row) row.completed_at = status === "completed" ? time : null;
    Object.assign(row, { status, summary, updated_at: time });
    const next = encode(TaskListSchema.parse({ ...list, updated_at: time }));
    try {
      replaceMaterialFile(root, "task-list.json", raw, next, randomUUID());
      return;
    } catch (error) {
      const current = readMaterialFile(root, "task-list.json");
      if (!current || current.equals(raw) || attempt === 3) throw error;
    }
  }
}

export function observeTaskLists(store: Store) {
  const watchers = new Map<string, { path: string; watcher?: FSWatcher; timer?: ReturnType<typeof setTimeout> }>();
  const drop = (key: string) => {
    const entry = watchers.get(key);
    if (entry?.timer) clearTimeout(entry.timer);
    entry?.watcher?.close();
    watchers.delete(key);
  };
  const refresh = () => {
    const active = new Set<string>();
    for (const binding of store.list<Binding>("task_list_binding")) {
      const w = store.get<Workflow>("workflow", binding.key);
      if (!w || terminal.has(w.state) || w.plan_revision !== binding.revision || w.run_id !== binding.writer || !binding.writer)
        continue;
      const run = store.get<Run>("run", binding.writer);
      if (run?.status !== "running") continue;
      active.add(w.id);
      const path = resolve(binding.root, binding.relative);
      if (watchers.get(w.id)?.path !== path) {
        drop(w.id);
        const entry: { path: string; watcher?: FSWatcher; timer?: ReturnType<typeof setTimeout> } = { path };
        watchers.set(w.id, entry);
        try {
          entry.watcher = watch(dirname(path), (_event, name) => {
            if (name && name.toLowerCase() !== "task-list.json") return;
            clearTimeout(entry.timer);
            entry.timer = setTimeout(() => {
              const current = store.get<Workflow>("workflow", w.id);
              if (current) syncTaskList(store, current);
            }, 150);
          });
          entry.watcher.on("error", () => drop(w.id));
        } catch { /* The periodic read covers unavailable file notifications. */ }
      }
      syncTaskList(store, w);
    }
    for (const key of watchers.keys()) if (!active.has(key)) drop(key);
  };
  const onEvent = (event: { type: string }) => {
    if (event.type === "TaskProgressWatch") refresh();
  };
  store.on("event", onEvent);
  const timer = setInterval(refresh, 2000);
  timer.unref();
  return () => {
    clearInterval(timer);
    store.off("event", onEvent);
    for (const key of watchers.keys()) drop(key);
  };
}
