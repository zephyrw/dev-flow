import { existsSync, readFileSync } from "node:fs";
import type { Engine } from "./engine.js";
import type { Principal } from "./auth.js";
import {
  requireCondition,
  type Evidence,
  type Plan,
  type Workflow,
  type Workspace,
} from "../../contracts/src/index.js";
import { safePath } from "../../workspace/src/files.js";
import { hash, now } from "./util.js";

export function latestEvidence(
  evidence: Evidence[],
  test: string,
  w: Workflow,
) {
  return evidence
    .filter(
      (e) =>
        e.test_id === test &&
        (!e.plan_revision || e.plan_revision === w.plan_revision),
    )
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .at(-1);
}
export function currentEvidence(e: Evidence | undefined, w: Workflow) {
  return (
    !!e &&
    !!w.snapshot_id &&
    e.status !== "stale" &&
    e.snapshot_id === w.snapshot_id &&
    e.environment_revision === w.environment_revision &&
    (!e.plan_revision || e.plan_revision === w.plan_revision)
  );
}
export function testProgress(
  plan: Plan | null,
  evidence: Evidence[],
  w: Workflow,
) {
  const cases = (plan?.tests ?? []).flatMap((test) => {
    const e = latestEvidence(evidence, test.id, w),
      valid = currentEvidence(e, w);
    return test.expected_case_ids.map((id) => {
      const actual = e?.cases?.find((c) => c.id === id);
      const status = !e
        ? "not_run"
        : !valid
          ? "stale"
          : (actual?.status ??
            (e.status === "passed" && e.case_ids.includes(id)
              ? "passed"
              : "missing"));
      return {
        id,
        test_id: test.id,
        layer: test.layer,
        task_ids: test.task_ids,
        status,
        evidence_id: e?.id,
      };
    });
  });
  return {
    total: cases.length,
    passed: cases.filter((c) => c.status === "passed").length,
    failed: cases.filter((c) => c.status === "failed").length,
    stale: cases.filter((c) => c.status === "stale").length,
    cases,
  };
}
function taskInfo(engine: Engine, key: string, taskId: string) {
  const w = engine.get(key),
    plan = engine.plan(key).plan,
    task = plan.tasks.find((t) => t.id === taskId);
  requireCondition(
    plan.task_model === "leaf-v1" && task,
    "LEAF_TASK_REQUIRED",
    "此工具需要已批准细项计划中的任务编号",
  );
  const workspace = engine.store
    .list<Workspace>("workspace", key)
    .find((ws) => !task.repo_id || ws.repo_id === task.repo_id);
  requireCondition(workspace, "WORKSPACE_MISSING", "任务仓库未绑定");
  return { w, plan, task, workspace };
}
export function taskProofValid(engine: Engine, key: string, taskId: string) {
  if (!engine.store.list<Workspace>("workspace", key).length) return false;
  const { w, task, workspace } = taskInfo(engine, key, taskId);
  const proof = engine.store.get<any>(
    "task_proof",
    `${key}-${w.plan_revision}-${taskId}`,
  );
  if (!proof || proof.stale) return false;
  try {
    return task.paths.every((p) => {
      const path = safePath(workspace.root, p);
      return (
        proof.hashes[p] === (existsSync(path) ? hash(readFileSync(path)) : null)
      );
    });
  } catch {
    return false;
  }
}
export function startTask(
  engine: Engine,
  principal: Principal,
  key: string,
  taskId: string,
  summary?: string,
) {
  engine.worker(principal, key, true);
  const { w, task } = taskInfo(engine, key, taskId);
  requireCondition(
    task.depends_on.every((id) => taskProofValid(engine, key, id)),
    "TASK_DEPENDENCY_INCOMPLETE",
    "前置细项尚未完成核验",
  );
  const previous = engine.store.get<any>("task_activity", key);
  // Switching back to repair a prerequisite must remain possible after a
  // failed check invalidates the current task. Switching never completes it.
  const activity = {
    task_id: taskId,
    title: task.title,
    module_id: task.module_id,
    run_id: principal.run_id,
    plan_revision: w.plan_revision,
    started_at:
      previous?.task_id === taskId &&
      previous.run_id === principal.run_id &&
      previous.plan_revision === w.plan_revision
        ? previous.started_at
        : now(),
    updated_at: now(),
    summary: summary ?? task.title,
  };
  engine.store.put("task_activity", key, key, activity);
  engine.store.event(
    key,
    w.project_id,
    "TaskStarted",
    activity,
    principal.run_id,
  );
  return activity;
}
export function recordTaskProof(
  engine: Engine,
  principal: Principal,
  key: string,
  taskId: string,
) {
  const { w, task, workspace } = taskInfo(engine, key, taskId);
  const active = engine.store.get<any>("task_activity", key);
  requireCondition(
    active?.task_id === taskId && active?.run_id === principal.run_id,
    "TASK_NOT_STARTED",
    "先调用 devflow_start_task 开始这个细项",
  );
  const hashes: Record<string, string | null> = {};
  for (const p of task.paths) {
    const path = safePath(workspace.root, p);
    hashes[p] = existsSync(path) ? hash(readFileSync(path)) : null;
  }
  for (const check of task.completion_checks!) {
    const path = safePath(workspace.root, check.path);
    requireCondition(
      existsSync(path) && readFileSync(path, "utf8").includes(check.contains),
      "COMPLETION_CHECK_FAILED",
      `细项完成检查未通过：${check.path}`,
    );
  }
  const proof = {
    task_id: taskId,
    hashes,
    checks: task.completion_checks,
    completed_at: now(),
    run_id: principal.run_id,
    stale: false,
  };
  engine.store.put(
    "task_proof",
    `${key}-${w.plan_revision}-${taskId}`,
    key,
    proof,
  );
  engine.store.event(
    key,
    w.project_id,
    "TaskCompleted",
    { task_id: taskId, title: task.title, module_id: task.module_id },
    principal.run_id,
  );
}
export function invalidateTaskProofs(
  engine: Engine,
  key: string,
  paths?: string[],
  repo?: string,
) {
  const w = engine.get(key);
  if (!w.plan_revision) return;
  const plan = engine.plan(key).plan;
  if (plan.task_model !== "leaf-v1") return;
  const impacted = new Set(
    plan.tasks
      .filter(
        (t) =>
          !paths ||
          ((!repo || !t.repo_id || t.repo_id === repo) &&
            t.paths.some((p) => paths.includes(p))),
      )
      .map((t) => t.id),
  );
  let size = -1;
  while (size !== impacted.size) {
    size = impacted.size;
    for (const t of plan.tasks)
      if (t.depends_on.some((id) => impacted.has(id))) impacted.add(t.id);
  }
  for (const id of impacted) {
    const k = `${key}-${w.plan_revision}-${id}`,
      proof = engine.store.get<any>("task_proof", k);
    if (proof)
      engine.store.put("task_proof", k, key, { ...proof, stale: true });
  }
}
