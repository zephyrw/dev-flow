import { describe, expect, it, vi } from "vitest";
import { setup, project, plan } from "../helpers.js";
import { objectHash } from "../../packages/core/src/util.js";
import { GitDeliveryCoordinator } from "../../packages/git/src/delivery-coordinator.js";
import { CliDispatchManager } from "../../packages/runtime/src/cli-dispatch.js";
import { FlowError, type Run, type Workflow } from "../../packages/contracts/src/index.js";
import { UserInteractionService } from "../../packages/core/src/user-interaction-service.js";
import { readBusinessProgress } from "../../packages/core/src/workflow-progress.js";
import {
  createQualityFlow,
  nextQualityAction,
} from "../../packages/core/src/quality-flow.js";

/**
 * G01–G06：规划提交与 Git 收尾的路由层契约。
 * 平台在策略 2 下派发 planner_commit，不调用 executeDelivery 生成第二次候选提交。
 */
describe("planner-commit 路由契约", () => {
  it("G01 最终复核通过后唯一下一动作是 planner_commit", () => {
    const flow = {
      ...createQualityFlow("wf"),
      phase: "after_human" as const,
      planner_repairs_only: true,
    };
    const r = nextQualityAction(
      { flow },
      { type: "quality_review", result: { verdict: "passed" } },
    );
    expect(r.action).toEqual({ kind: "planner_commit", phase: "after_human" });
  });

  it("G02 提交前工作区有其他人改动：路由仍只派发提交，不触发清理或重提", () => {
    const flow = {
      ...createQualityFlow("wf"),
      phase: "after_human" as const,
      planner_repairs_only: true,
    };
    // 说明材料（他人改动）不改变路由
    const r = nextQualityAction(
      { flow },
      {
        type: "executor_test_completed",
        result: {
          status: "completed",
          summary: "另有他人未暂存改动已保留",
          code_changed: false,
        },
      },
    );
    expect(r.action.kind).toBe("planner_commit");
  });

  it("G03 提交成功后进程断连重试：恢复仍是 planner_commit 用途", () => {
    const flow = {
      ...createQualityFlow("wf"),
      phase: "after_human" as const,
      planner_repairs_only: true,
    };
    const r = nextQualityAction(
      { flow },
      { type: "executor_test_completed", result: { status: "completed" } },
    );
    // 恢复按已保存 next action 继续；不会退回 implement
    expect(r.action.kind).toBe("planner_commit");
    expect(r.action.kind).not.toBe("quality_review");
  });

  it("G05 hook/冲突修复后执行测试完成 → 直接恢复规划提交，无复核", () => {
    const flow = {
      ...createQualityFlow("wf"),
      phase: "after_human" as const,
      planner_repairs_only: true,
    };
    let r = nextQualityAction({ flow }, { type: "planner_repair_completed" });
    expect(r.action.kind).toBe("executor_test");
    r = nextQualityAction(
      { flow: r.flow },
      {
        type: "executor_test_completed",
        result: { status: "completed", code_changed: true },
      },
    );
    expect(r.action.kind).toBe("planner_commit");
  });

  it("G06 清理失败不否认规划提交成功（路由已到提交终点）", () => {
    const flow = {
      ...createQualityFlow("wf"),
      phase: "after_human" as const,
      planner_repairs_only: true,
    };
    const r = nextQualityAction(
      { flow },
      { type: "quality_review", result: { verdict: "passed" } },
    );
    // 清理是 integrateCommittedDelivery 的收尾；路由层已到达终点动作
    expect(r.action.kind).toBe("planner_commit");
  });
});

function commitRecoveryFixture(purpose = "planner_commit", state: Workflow["state"] = "EXECUTING") {
  const s = setup();
  const p = project(s.root), time = new Date().toISOString();
  const workflow: Workflow = { id: "commit-recovery", project_id: p.id, title: "final commit", request: "finish approved delivery",
    complexity: "simple", workspace_mode: "new_worktree", quality_policy_version: 2,
    state, stage: purpose, version: 1, plan_revision: 1, plan_hash: "approved", run_id: "current-run",
    environment_revision: 0, snapshot_id: "tested-snapshot", feedback: [], created_at: time, updated_at: time };
  const run = { id: workflow.run_id!, workflow_id: workflow.id, plan_revision: 1, purpose,
    routing_role: purpose === "executor_test" || purpose === "implement" ? "executor" : "planner",
    stage: purpose, status: "running", logical_round_id: "same-round", conversation_id: "same-session",
    assignment_id: "same-assignment", dispatch_context: { purpose, review_phase: "after_human", source_run_id: "tested-run",
      logical_round_id: "same-round", assignment_id: "same-assignment" } } as Run;
  s.store.put("project", p.id, p.id, p);
  s.store.put("workflow", workflow.id, p.id, workflow);
  s.store.put("run", run.id, workflow.id, run);
  s.store.put("plan", workflow.id + "-1", workflow.id, { revision: 1, hash: workflow.plan_hash,
    plan: { ...plan(objectHash(p), "a".repeat(40)), task_model: "native-v2" } });
  s.store.put("quality_flow", workflow.id, workflow.id, { ...createQualityFlow(workflow.id), phase: "after_human", planner_repairs_only: true });
  s.store.put("acceptance", workflow.id, workflow.id, { accepted: true, snapshot_id: workflow.snapshot_id });
  s.store.put("evidence", "tested", workflow.id, { id: "tested", status: "passed", snapshot_id: workflow.snapshot_id });
  return { ...s, workflow, run };
}

describe("planner commit recovery through Engine", () => {
  it.each(["WORKSPACE_MISSING", "WORKSPACE_BUSY", "EACCES", "INTERNAL_FAILURE"])("integration exception %s is handed to the planner", async code => {
    const s = commitRecoveryFixture();
    const integrate = vi.spyOn(GitDeliveryCoordinator.prototype, "integrateCommittedDelivery").mockRejectedValue(new FlowError(code, "模拟提交问题"));
    try {
      await (s.engine as any).completePlannerCommit(s.workflow.id, s.run.id, {});
      expect(s.engine.get(s.workflow.id)).toMatchObject({ state: "QUEUED", stage: "planner_commit" });
      expect(s.store.get<any>("planner_integration_repair", s.workflow.id).instructions).toContain(code);
      expect(s.store.get<any>("planner_integration_repair", s.workflow.id).instructions).toContain("user_interaction");
    } finally { integrate.mockRestore(); s.store.close(); }
  });

  it("repeated integration failure asks the user instead of looping and the answer resumes commit", async () => {
    const s = commitRecoveryFixture();
    const dispatch = vi.spyOn(s.engine, "dispatch").mockResolvedValue(undefined);
    const integrate = vi.spyOn(GitDeliveryCoordinator.prototype, "integrateCommittedDelivery").mockRejectedValue(new FlowError("EACCES", "权限不足"));
    try {
      await (s.engine as any).completePlannerCommit(s.workflow.id, s.run.id, {});
      const next = (id: string) => {
        s.store.put("run", id, s.workflow.id, { ...s.run, id, conversation_id: undefined, status: "completed", protocol: "lightweight" });
        s.engine.transition(s.workflow.id, [s.engine.get(s.workflow.id).state], "EXECUTING", "planner_commit", { run_id: id });
      };
      next("repair-run");
      await (s.engine as any).completePlannerCommit(s.workflow.id, "repair-run", {});
      expect(s.store.get<any>("planner_integration_repair", s.workflow.id).requires_user).toBe(true);
      next("question-run");
      await s.engine.receiveRoundResult(s.workflow.id, "question-run", { status: "completed", summary: "仍需要用户开放目录权限" });
      expect(s.engine.get(s.workflow.id)).toMatchObject({ state: "WAITING_INPUT", stage: "planner_commit" });
      expect(s.store.get("execution_completion", "question-run")).toBeUndefined();
      const service = new UserInteractionService(s.store);
      const interaction = service.getCurrentInteraction(s.workflow.id)!;
      expect(interaction.request.title).toBe("提交合并需要协助");
      await service.respondInteraction(s.workflow.id, interaction.id, { request_id: "permission-fixed", source_run_id: "question-run",
        action: "answer", answer: "权限已恢复，继续" }, s.engine);
      expect(s.engine.get(s.workflow.id)).toMatchObject({ state: "QUEUED", stage: "planner_commit" });
      expect(s.store.get<any>("planner_integration_repair", s.workflow.id).requires_user).toBe(false);
      expect(s.store.get("acceptance", s.workflow.id)).toMatchObject({ accepted: true });
    } finally { integrate.mockRestore(); dispatch.mockRestore(); s.store.close(); }
  });

  it.each(["need_planner", "failed"])("commit model status %s becomes a user popup within commit", async status => {
    const s = commitRecoveryFixture();
    try {
      await s.engine.receiveRoundResult(s.workflow.id, s.run.id, { status, summary: "需要确认保留哪种业务行为" });
      expect(s.engine.get(s.workflow.id)).toMatchObject({ state: "WAITING_INPUT", stage: "planner_commit" });
      expect(new UserInteractionService(s.store).getCurrentInteraction(s.workflow.id)?.role).toBe("planner");
    } finally { s.store.close(); }
  });
  it("conflict decision creates a popup request and the answer resumes the same commit role", async () => {
    const s = commitRecoveryFixture();
    const dispatch = vi.spyOn(s.engine, "dispatch").mockResolvedValue(undefined);
    try {
      s.store.put("run", s.run.id, s.workflow.id, { ...s.run, protocol: "lightweight", status: "completed" });
      s.store.put("conversation_node", "same-session", s.workflow.id, { id: "same-session", root_id: "same-session",
        workflow_id: s.workflow.id, current_attempt_id: "commit-attempt", kind: "root", role: "planner" });
      s.store.put("conversation_attempt", "commit-attempt", s.workflow.id, { id: "commit-attempt", conversation_id: "same-session",
        workflow_id: s.workflow.id, run_id: s.run.id, generation: 1 });
      const repair = { source_run_id: "previous-commit", instructions: "处理固定提交冲突",
        targets: [{ repo_id: "main", source_commit: "a".repeat(40), candidate_commit: "b".repeat(40) }] };
      s.store.put("planner_integration_repair", s.workflow.id, s.workflow.id, repair);
      await s.engine.receiveRoundResult(s.workflow.id, s.run.id, { status: "need_user", summary: "两方配置需求互斥，请确认",
        user_interaction: { kind: "question", title: "确认冲突处理方式", message: "选择兼容模式会保留两方入口",
          question: "是否保留两方入口？", choices: [{ id: "both", label: "保留两方入口" }], allow_free_text: true } });
      expect(s.engine.get(s.workflow.id)).toMatchObject({ state: "WAITING_INPUT", stage: "planner_commit" });
      expect(readBusinessProgress(s.store, s.engine.get(s.workflow.id)).index).toBe(7);
      const service = new UserInteractionService(s.store);
      const interaction = service.getCurrentInteraction(s.workflow.id)!;
      expect(interaction).toMatchObject({ status: "pending", role: "planner", request: { kind: "question", title: "确认冲突处理方式" } });
      await service.respondInteraction(s.workflow.id, interaction.id, {
        request_id: "conflict-answer", source_run_id: s.run.id, action: "answer", answer: "保留两方入口",
      }, s.engine);
      expect(s.engine.get(s.workflow.id)).toMatchObject({ state: "QUEUED", stage: "planner_commit" });
      expect(s.store.get("pending_dispatch_purpose", s.workflow.id)).toMatchObject({ purpose: "planner_commit" });
      expect(s.store.get("run_continuation", s.workflow.id)).toMatchObject({ source_run_id: s.run.id,
        answer: expect.stringContaining("保留两方入口") });
      expect(s.store.get("planner_integration_repair", s.workflow.id)).toEqual(repair);
      expect(s.store.get("acceptance", s.workflow.id)).toMatchObject({ accepted: true });
      expect(s.store.get("evidence", "tested")).toMatchObject({ status: "passed" });
    } finally { dispatch.mockRestore(); s.store.close(); }
  });
  it.each(["planner_commit", "executor_test", "planner_takeover"])("local-console stop and feedback retain %s and its frozen context", async purpose => {
    const s = commitRecoveryFixture(purpose);
    try {
      await s.engine.stop(s.workflow.id, "local_console");
      expect(s.engine.get(s.workflow.id).state).toBe("STOPPED");
      const next = s.engine.feedback(s.workflow.id, "继续当前轮次，保留已完成工作", "within_plan");
      await s.engine.consumeOutbox();
      expect(next).toMatchObject({ state: "QUEUED", stage: purpose, snapshot_id: "tested-snapshot" });
      expect(s.store.get("pending_dispatch_purpose", s.workflow.id)).toMatchObject(s.run.dispatch_context!);
      expect(s.store.get("run", s.run.id)).toMatchObject({ conversation_id: "same-session", logical_round_id: "same-round" });
      expect(s.store.get("run_continuation", s.workflow.id)).toMatchObject({ kind: "runtime_resume", source_run_id: s.run.id, conversation_id: "same-session" });
      expect(s.store.get("acceptance", s.workflow.id)).toMatchObject({ accepted: true });
      expect(s.store.get("evidence", "tested")).toMatchObject({ status: "passed" });
      expect(new CliDispatchManager(s.store).getDispatchControl(s.workflow.id).reasons).toEqual([]);
    } finally { s.store.close(); }
  });

  it("preserves a queued commit context when its previous completed Run belongs to another role", async () => {
    const s = commitRecoveryFixture("executor_test", "QUEUED");
    try {
      s.store.put("workflow", s.workflow.id, s.workflow.project_id, { ...s.workflow, stage: "planner_commit" });
      s.store.put("run", s.run.id, s.workflow.id, { ...s.run, status: "completed" });
      const context = { purpose: "planner_commit", source_run_id: s.run.id, review_phase: "after_human",
        logical_round_id: "commit-round", assignment_id: "commit-assignment", repair_batch_id: "existing-batch" };
      s.store.put("pending_dispatch_purpose", s.workflow.id, s.workflow.id, context);
      await s.engine.stop(s.workflow.id, "local_console");
      s.engine.feedback(s.workflow.id, "仅继续最后提交", "within_plan");
      await s.engine.consumeOutbox();
      expect(s.engine.get(s.workflow.id)).toMatchObject({ state: "QUEUED", stage: "planner_commit", snapshot_id: "tested-snapshot" });
      expect(s.store.get("pending_dispatch_purpose", s.workflow.id)).toEqual(context);
    } finally { s.store.close(); }
  });

  it("does not use a historical commit handoff to reroute ordinary implementation feedback", async () => {
    const s = commitRecoveryFixture("implement");
    try {
      s.store.put("planner_commit_handoff", s.workflow.id, s.workflow.id, { run_id: "historical-commit" });
      await s.engine.stop(s.workflow.id, "local_console");
      s.engine.feedback(s.workflow.id, "继续本轮开发", "within_plan");
      await s.engine.consumeOutbox();
      expect(s.engine.get(s.workflow.id)).toMatchObject({ state: "QUEUED", stage: "execute" });
      expect(s.store.get("pending_dispatch_purpose", s.workflow.id)).toMatchObject({ purpose: "implement" });
    } finally { s.store.close(); }
  });

  it("keeps clean divergence in planner_commit instead of starting repair and testing", async () => {
    const s = commitRecoveryFixture();
    const integrate = vi.spyOn(GitDeliveryCoordinator.prototype, "integrateCommittedDelivery").mockImplementation(async () => {
      s.engine.transition(s.workflow.id, ["COMMITTING"], "COMMIT_PARTIAL", "commit_recovery");
      return { integrations: [], repairInstructions: "自动解决固定提交的冲突并完成提交",
        repairTargets: [{ repo_id: "main", source_commit: "a".repeat(40), candidate_commit: "b".repeat(40) }] };
    });
    try {
      await (s.engine as any).completePlannerCommit(s.workflow.id, s.run.id, { repositories: [{ repo_id: "main", commit: "b".repeat(40) }] });
      await s.engine.consumeOutbox();
      expect(s.engine.get(s.workflow.id)).toMatchObject({ state: "QUEUED", stage: "planner_commit", snapshot_id: "tested-snapshot" });
      expect(s.store.get("pending_dispatch_purpose", s.workflow.id)).toMatchObject({ purpose: "planner_commit", source_run_id: s.run.id });
      expect(s.store.get("planner_integration_repair", s.workflow.id)).toMatchObject({ source_run_id: s.run.id,
        targets: [{ repo_id: "main", source_commit: "a".repeat(40), candidate_commit: "b".repeat(40) }] });
      expect(s.store.get("repair_assignment", s.workflow.id)).toBeUndefined();
      expect(s.store.get("evidence", "tested")).toMatchObject({ status: "passed" });
    } finally { integrate.mockRestore(); s.store.close(); }
  });

  it("requeues a new final commit from a stopped misrouted Run without replacing the original handoff or tested work", async () => {
    const s = commitRecoveryFixture("implement", "STOPPED");
    const dispatch = vi.spyOn(s.engine, "dispatch").mockResolvedValue(undefined);
    try {
      const source = { ...s.run, id: "original-commit", purpose: "planner_commit", status: "completed" };
      const handoff = { run_id: source.id, repositories: [{ repo_id: "main", commit: "c".repeat(40) }] };
      s.store.put("run", source.id, s.workflow.id, source);
      s.store.put("run", s.run.id, s.workflow.id, { ...s.run, status: "stopped" });
      s.store.put("planner_commit_handoff", s.workflow.id, s.workflow.id, handoff);
      s.store.put("planner_integration_repair", s.workflow.id, s.workflow.id, { source_run_id: source.id, instructions: "原整合状态" });
      s.store.put("pending_dispatch_purpose", s.workflow.id, s.workflow.id, { purpose: "implement" });
      new CliDispatchManager(s.store).addControlReason(s.workflow.id, { reason: "workflow_pause", created_at: new Date().toISOString() });
      await s.engine.retryCommit(s.workflow.id);
      await s.engine.consumeOutbox();
      expect(s.engine.get(s.workflow.id)).toMatchObject({ state: "QUEUED", stage: "planner_commit", snapshot_id: "tested-snapshot" });
      expect(s.store.get("pending_dispatch_purpose", s.workflow.id)).toMatchObject({ purpose: "planner_commit", source_run_id: source.id, review_phase: "after_human" });
      expect(s.store.get("planner_commit_handoff", s.workflow.id)).toEqual(handoff);
      expect(s.store.get("planner_integration_repair", s.workflow.id)).toMatchObject({ instructions: expect.stringContaining("不据此重开开发、全量测试或代码复核") });
      expect(s.store.get("evidence", "tested")).toMatchObject({ status: "passed" });
      expect(s.store.get("acceptance", s.workflow.id)).toMatchObject({ accepted: true });
      expect(new CliDispatchManager(s.store).getDispatchControl(s.workflow.id).reasons).toEqual([]);
      expect(dispatch).toHaveBeenCalledOnce();
    } finally { dispatch.mockRestore(); s.store.close(); }
  });

  it.each(["missing-link", "different-plan", "before-human"])("refuses a stopped final commit retry with %s", async invalid => {
    const s = commitRecoveryFixture("implement", "STOPPED");
    const dispatch = vi.spyOn(s.engine, "dispatch").mockResolvedValue(undefined);
    try {
      const source = { ...s.run, id: "original-commit", purpose: "planner_commit", status: "completed",
        plan_revision: invalid === "different-plan" ? 2 : 1 };
      s.store.put("run", source.id, s.workflow.id, source);
      s.store.put("run", s.run.id, s.workflow.id, { ...s.run, status: "stopped" });
      s.store.put("planner_commit_handoff", s.workflow.id, s.workflow.id, { run_id: source.id });
      if (invalid !== "missing-link") s.store.put("planner_integration_repair", s.workflow.id, s.workflow.id, { source_run_id: source.id });
      if (invalid === "before-human") s.store.put("quality_flow", s.workflow.id, s.workflow.id, createQualityFlow(s.workflow.id));
      await expect(s.engine.retryCommit(s.workflow.id)).rejects.toMatchObject({ code: "COMMIT_CONTEXT_MISSING" });
      expect(s.engine.get(s.workflow.id).state).toBe("STOPPED");
      expect(s.store.get("pending_dispatch_purpose", s.workflow.id)).toBeUndefined();
      expect(dispatch).not.toHaveBeenCalled();
    } finally { dispatch.mockRestore(); s.store.close(); }
  });
});
