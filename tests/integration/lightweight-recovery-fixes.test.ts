import { expect, it, vi } from "vitest";
import { fixture, cleanup, runtime, until } from "../fixtures/native-flow.js";
import { resumeApproved } from "../../packages/runtime/src/recovery.js";
import { FlowError, type Run, type MergeConflictRequest } from "../../packages/contracts/src/index.js";
import { GitDeliveryCoordinator } from "../../packages/git/src/delivery-coordinator.js";
import { saveRunContinuation, saveWaitingContext, readRunContinuation, readWaitingContext } from "../../packages/core/src/waiting-context.js";

type Fixture = Awaited<ReturnType<typeof fixture>>;
function putRun(s: Fixture, patch: Partial<Run> = {}) {
  const w = s.engine.get(s.w.id);
  const run: Run = {
    id: "current", workflow_id: w.id, plan_revision: w.plan_revision,
    adapter: "codex", purpose: "quality_review", stage: "quality_before_human",
    status: "completed", exit_code: 0, protocol: "lightweight",
    started_at: new Date().toISOString(), package_hash: "fixture", ...patch,
  };
  s.store.put("run", run.id, w.id, run);
  s.store.put("workflow", w.id, w.project_id, { ...w, run_id: run.id });
  return run;
}

it.each(["completed", "paused", "finishing"])("人工检查反馈进入开发，已通过审查不会被恢复（%s）", async (mode) => {
  const s = await fixture();
  try {
    putRun(s, { status: mode === "finishing" ? "running" : "completed" });
    const w = s.engine.get(s.w.id);
    s.engine.transition(w.id, [w.state], "HUMAN_PENDING", "human_acceptance");
    if (mode !== "completed") await s.engine.stop(w.id);
    const next = s.engine.feedback(w.id, "提交按钮缺少禁用状态", "within_plan");
    expect(next.state).toBe("QUEUED");
    expect(next.stage).toBe("execute");
    expect(next.feedback).toContain("提交按钮缺少禁用状态");
  } finally { await cleanup(s); }
});

it("新范围与新计划清除待续接的旧审查，历史运行仍保留", async () => {
  const s = await fixture();
  try {
    const old = putRun(s, { status: "waiting" });
    const continuation = { kind: "intent_clarification" as const, purpose: "review" as const,
      role: "planner" as const, source_run_id: old.id, original_text: "旧审查补问" };
    saveRunContinuation(s.store, s.w.id, s.w.id, continuation);
    saveWaitingContext(s.store, s.w.id, { purpose: "review", role: "planner", run_id: old.id, intent: "unclear" });
    await s.engine.stop(s.w.id);
    s.engine.feedback(s.w.id, "新增另外一个模块", "new_scope");
    expect(readRunContinuation(s.store, s.w.id)).toBeUndefined();
    expect(readWaitingContext(s.store, s.w.id)).toBeUndefined();
    expect(s.store.get("run", old.id)).toBeDefined();
    saveRunContinuation(s.store, s.w.id, s.w.id, continuation);
    const current = s.engine.get(s.w.id);
    s.engine.submitPlan(s.w.id, s.engine.plan(s.w.id).plan, current.version, "replacement");
    expect(readRunContinuation(s.store, s.w.id)).toBeUndefined();
  } finally { await cleanup(s); }
});

it.each(["intent_clarification", "user_answer"] as const)("执行 %s 失败后人工恢复保留原补问语义", async (kind) => {
  const s = await fixture();
  try {
    const continuation = { kind, purpose: "execute" as const, role: "executor" as const,
      source_run_id: "source", conversation_id: "same-session", questions: ["配置名？"],
      original_text: "补充结果", answer: "API_BASE" };
    putRun(s, { purpose: "implement", stage: "execute", status: "failed", continuation });
    const w = s.engine.get(s.w.id);
    s.engine.transition(w.id, [w.state], "BLOCKED", "blocked");
    resumeApproved(s.engine, w.id);
    expect(s.engine.get(w.id).state).toBe("QUEUED");
    expect(readRunContinuation(s.store, w.id)).toEqual(continuation);
  } finally { await cleanup(s); }
});

it("网络自动重试保留已绑定的执行补问上下文", async () => {
  const s = await fixture();
  try {
    const continuation = { kind: "intent_clarification" as const, purpose: "execute" as const,
      role: "executor" as const, source_run_id: "source", original_text: "仅补充结果" };
    saveRunContinuation(s.store, s.w.id, s.w.id, continuation);
    const seen: Run[] = [];
    s.engine.runtime = runtime(s, async (run) => {
      seen.push(run);
      if (seen.length === 1) throw new FlowError("MODEL_CONNECTION_FAILED", "connection reset");
      await s.engine.receiveRoundResult(s.w.id, run.id, { status: "need_user", summary: "等待确认" });
    });
    await until(s, ["WAITING_INPUT"], 180000);
    expect(seen).toHaveLength(2);
    expect(seen[1]?.continuation).toEqual(continuation);
  } finally { await cleanup(s); }
});

function conflict(s: Fixture) {
  const run = putRun(s, { purpose: "merge_conflict", stage: "merge_conflict_resolution", status: "running" });
  const w = s.engine.get(s.w.id);
  s.engine.transition(w.id, [w.state], "EXECUTING", "merge_conflict_resolution");
  const request: MergeConflictRequest = {
    id: "conflict", workflow_id: w.id, repo_id: "main", run_id: run.id,
    plan_revision: w.plan_revision, plan_hash: w.plan_hash!, candidate_commit: "candidate",
    source_commit: "source", worktree_root: s.repo, common_dir: s.repo,
    conflict_paths: ["app.txt"], status: "running", created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
  s.store.put("merge_conflict_request", request.id, w.id, request);
  return { run, request, receipt: { request_id: request.id, workflow_id: w.id, run_id: run.id,
    candidate_commit: "candidate", source_commit: "source", status: "resolved" as const, resolved_paths: ["app.txt"] } };
}

it.each(["during", "after"])("冲突停止%s收到迟到错误不会覆盖暂停", async (when) => {
  const s = await fixture();
  try {
    const { run, request } = conflict(s);
    s.engine.runtime = runtime(s);
    s.engine.runtime.stop = async () => {
      if (when === "during") s.engine.handleMergeConflictError(s.w.id, run.id, request.id, new Error("late exit"));
    };
    await s.engine.stop(s.w.id);
    if (when === "after") s.engine.handleMergeConflictError(s.w.id, run.id, request.id, new FlowError("RUN_REVOKED", "stopped"));
    expect(s.engine.get(s.w.id).state).toBe("STOPPED");
    expect(s.store.must<Run>("run", run.id).status).not.toBe("failed");
  } finally { await cleanup(s); }
});

it.each(["stopped", "replaced"])("冲突成功回执在%s后不能进入 Git 写入", async (mode) => {
  const s = await fixture();
  const apply = vi.spyOn(GitDeliveryCoordinator.prototype, "handleConflictResolution");
  try {
    const { run, request, receipt } = conflict(s);
    if (mode === "stopped") await s.engine.stop(s.w.id);
    else putRun(s, { id: "replacement", purpose: "implement", stage: "execute", status: "running" });
    await s.engine.handleMergeConflictResult(s.w.id, run.id, request.id, receipt);
    expect(apply).not.toHaveBeenCalled();
    expect(s.engine.get(s.w.id).state).toBe(mode === "stopped" ? "STOPPED" : "EXECUTING");
  } finally { apply.mockRestore(); await cleanup(s); }
});


it("暂停必须等待冲突提交回调收尾后才允许新运行恢复", async () => {
  const s = await fixture();
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const finishing = new Promise<void>((resolve) => { release = resolve; });
  let recorded = false;
  const apply = vi.spyOn(GitDeliveryCoordinator.prototype, "handleConflictResolution").mockImplementation(async () => {
    entered();
    await finishing;
    recorded = true;
    return { newHead: "recorded-commit" };
  });
  try {
    const { run, request, receipt } = conflict(s);
    s.engine.runtime = { ...runtime(s), resolveMergeConflict: async () => receipt } as any;
    s.store.enqueue(s.w.id, "dispatch_run", { purpose: "merge_conflict", request_id: request.id, run_id: run.id });
    await (s.engine as any).consumeOutbox();
    await started;
    const stop = s.engine.stop(s.w.id);
    await Promise.resolve();
    expect(s.engine.get(s.w.id).state).toBe("STOPPING");
    expect(recorded).toBe(false);
    release();
    await stop;
    expect(recorded).toBe(true);
    expect(s.engine.get(s.w.id).state).toBe("STOPPED");
    expect(s.store.get("queue", s.w.id)).toBeUndefined();
  } finally { release(); apply.mockRestore(); await cleanup(s); }
});


it("控制器在审查进程完成但尚未应用结论时恢复仍进入审查", async () => {
  const s = await fixture();
  try {
    putRun(s, { status: "completed" });
    const w = s.engine.get(s.w.id);
    s.engine.transition(w.id, [w.state], "RECOVERY_REQUIRED", "quality_before_human");
    const next = resumeApproved(s.engine, w.id);
    expect(next.state).toBe("REVIEW_QUEUED");
    expect(next.stage).toBe("quality_before_human");
  } finally { await cleanup(s); }
});
