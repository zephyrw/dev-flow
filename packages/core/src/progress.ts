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
import { assertMeaningfulTestFiles } from "./test-quality.js";

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
/** Progress includes checks run during development. Final delivery still uses
 * currentEvidence and verifies every report against the frozen snapshot. */
export function progressEvidence(e: Evidence | undefined, w: Workflow) {
  return (
    !!e &&
    !!e.snapshot_id &&
    e.status !== "stale" &&
    (e.phase === "development" ||
      !w.snapshot_id ||
      e.snapshot_id === w.snapshot_id) &&
    (!e.plan_revision || e.plan_revision === w.plan_revision) &&
    (e.layer === "unit" || e.environment_revision === w.environment_revision)
  );
}
export function testProgress(
  plan: Plan | null,
  evidence: Evidence[],
  w: Workflow,
) {
  const cases = (plan?.tests ?? []).flatMap((test) => {
    const e = latestEvidence(evidence, test.id, w),
      valid = progressEvidence(e, w);
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
        last_status: actual?.status,
        phase: e?.phase,
        evidence_id: e?.id,
      };
    });
  });
  return {
    total: cases.length,
    passed: cases.filter((c) => c.status === "passed").length,
    failed: cases.filter((c) => c.status === "failed").length,
    stale: cases.filter((c) => c.status === "stale").length,
    previously_passed: cases.filter(
      (c) => c.status === "stale" && c.last_status === "passed",
    ).length,
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
export interface TaskProofMemo {
  ownValid?: Map<string, boolean>;
  completed?: Map<string, boolean>;
  fileHashes?: Map<string, string | null>;
  proofs?: Map<string, any>;
  workspaces?: Workspace[];
  plan?: Plan;
  w?: Workflow;
}

export function taskProofValid(
  engine: Engine,
  key: string,
  taskId: string,
  ownOnly = false,
  visiting = new Set<string>(),
  memo?: TaskProofMemo,
): boolean {
  memo ??= {};
  memo.ownValid ??= new Map<string, boolean>();
  memo.completed ??= new Map<string, boolean>();
  memo.fileHashes ??= new Map<string, string | null>();

  if (ownOnly && memo.ownValid.has(taskId)) {
    return memo.ownValid.get(taskId)!;
  }
  if (!ownOnly && memo.completed.has(taskId)) {
    return memo.completed.get(taskId)!;
  }

  memo.workspaces ??= engine.store.list<Workspace>("workspace", key);
  if (!memo.workspaces.length) return false;

  memo.w ??= engine.get(key);
  const w = memo.w;
  memo.plan ??= engine.plan(key).plan;
  const plan = memo.plan;
  const task = plan.tasks.find((t) => t.id === taskId);
  if (!task || plan.task_model !== "leaf-v1") return false;

  const workspace = memo.workspaces.find(
    (ws) => !task.repo_id || ws.repo_id === task.repo_id,
  );
  if (!workspace) return false;

  let proof: any;
  if (memo.proofs?.has(taskId)) {
    proof = memo.proofs.get(taskId);
  } else {
    proof = engine.store.get<any>(
      "task_proof",
      `${key}-${w.plan_revision}-${taskId}`,
    );
  }
  if (!proof || proof.stale) {
    memo.ownValid.set(taskId, false);
    memo.completed.set(taskId, false);
    return false;
  }

  if (!memo.ownValid.has(taskId)) {
    let selfValid = true;
    try {
      for (const p of task.paths) {
        let fileHash: string | null | undefined;
        const path = safePath(workspace.root, p);
        if (memo.fileHashes.has(path)) {
          fileHash = memo.fileHashes.get(path);
        } else {
          fileHash = existsSync(path) ? hash(readFileSync(path)) : null;
          memo.fileHashes.set(path, fileHash);
        }
        if (proof.hashes[p] !== fileHash) {
          selfValid = false;
          break;
        }
      }
    } catch {
      selfValid = false;
    }
    memo.ownValid.set(taskId, selfValid);
  }

  const isOwnValid = memo.ownValid.get(taskId)!;
  if (ownOnly) return isOwnValid;
  if (!isOwnValid) {
    memo.completed.set(taskId, false);
    return false;
  }

  if (visiting.has(taskId)) return false;
  const ancestors = new Set(visiting).add(taskId);
  const allDepsValid = task.depends_on.every((id) =>
    taskProofValid(engine, key, id, false, ancestors, memo),
  );
  memo.completed.set(taskId, allDepsValid);
  return allDepsValid;
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
  assertMeaningfulTestFiles(workspace.root, task.paths);
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
  const prior = engine.store.get<any>(
    "task_proof",
    `${key}-${w.plan_revision}-${taskId}`,
  );
  if (
    prior &&
    !prior.stale &&
    task.paths.every((p) => prior.hashes[p] === hashes[p])
  )
    return false;
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
  return true;
}

/** Recover legacy records invalidated by a shared test failure. Exact source
 * hashes and current completion checks must still match; no test is promoted. */
export function reconcileImplementationProofs(engine: Engine, key: string) {
  const w = engine.get(key),
    plan = engine.plan(key).plan;
  if (plan.task_model !== "leaf-v1") return;
  const workspaces = engine.store.list<Workspace>("workspace", key);
  const contents = new Map<string, Buffer | null>();
  const read = (root: string, path: string) => {
    const file = safePath(root, path);
    if (!contents.has(file))
      contents.set(file, existsSync(file) ? readFileSync(file) : null);
    return contents.get(file)!;
  };
  const restored: string[] = [];
  for (const task of plan.tasks) {
    const id = `${key}-${w.plan_revision}-${task.id}`;
    const proof = engine.store.get<any>("task_proof", id);
    const ws = workspaces.find(
      (ws) => !task.repo_id || ws.repo_id === task.repo_id,
    );
    if (!proof?.stale || !ws) continue;
    if (
      !task.paths.every((path) => {
        const bytes = read(ws.root, path);
        return proof.hashes[path] === (bytes === null ? null : hash(bytes));
      }) ||
      !task.completion_checks?.every((check) =>
        read(ws.root, check.path)?.toString("utf8").includes(check.contains),
      )
    )
      continue;
    engine.store.put("task_proof", id, key, {
      ...proof,
      stale: false,
      stale_reason: undefined,
    });
    restored.push(task.id);
  }
  if (restored.length)
    engine.store.event(
      key,
      w.project_id,
      "ImplementationReconciled",
      {
        task_ids: restored,
        message: `已核对并保留 ${restored.length} 项未变化的实现，测试状态单独记录。`,
      },
      w.run_id,
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
  // Preserve unchanged downstream implementation. Its readiness depends on
  // prerequisites dynamically; repairing a prerequisite must not require
  // re-submitting every unchanged task. Test evidence is invalidated separately.
  for (const id of impacted) {
    const k = `${key}-${w.plan_revision}-${id}`,
      proof = engine.store.get<any>("task_proof", k);
    if (proof)
      engine.store.put("task_proof", k, key, {
        ...proof,
        stale: true,
        stale_reason: paths
          ? "本任务文件已修改，需要重新核验实现"
          : "检查未通过，需要重新核验实现",
      });
  }
}
