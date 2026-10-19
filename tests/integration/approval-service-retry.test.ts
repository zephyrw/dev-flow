import { expect, it, vi } from "vitest";
import { Engine } from "../../packages/core/src/engine.js";
import { bindProfile } from "../../packages/core/src/run-profile.js";
import { resumeModelWaits } from "../../packages/runtime/src/recovery.js";
import type { Run } from "../../packages/contracts/src/index.js";
import {
  APPROVAL_BUDGET_ENTITY, APPROVAL_FAILURE_ENTITY, APPROVAL_RETRY_DELAYS, APPROVAL_RETRY_ENTITY,
  ApprovalFailureObserver, approvalBudgetKey, type ApprovalServiceRetry,
} from "../../packages/core/src/approval-service-retry.js";
import { approvalFixture, approvalOutput, capacityResult, SESSION } from "../fixtures/approval-service.js";

it("retries the real commit need_user after read-only checks, waits 15s, and preserves role/session/frozen profile across restart", async () => {
  const s = approvalFixture();
  try {
    s.fail();
    s.accept({ type: "custom_tool_call", name: "exec", call_id: "check", input: "git status --short" });
    s.accept({ type: "custom_tool_call_output", call_id: "check", output: [{ type: "input_text", text: "Script completed" }] });
    // Native runtime marks the process completed before handing its result to Engine.
    s.store.put("run", s.run.id, s.w.id, { ...s.run, status: "completed", ended_at: new Date().toISOString() });
    const before = Date.now();
    await s.engine.receiveRoundResult(s.w.id, s.run.id, capacityResult);
    const retry = s.store.must<ApprovalServiceRetry>(APPROVAL_RETRY_ENTITY, s.w.id);
    expect(retry.retry_at).toBeGreaterThanOrEqual(before + 15000);
    expect(retry).toMatchObject({ attempt: 1, native_session_id: SESSION, run_id: s.run.id });
    expect(s.engine.get(s.w.id)).toMatchObject({ state: "BLOCKED", stage: "planner_commit" });
    expect(s.engine.summary(s.w.id).attention?.category).toBe("queue");
    expect(s.store.list("user_interaction", s.w.id)).toHaveLength(0);
    await s.engine.receiveRoundResult(s.w.id, s.run.id, capacityResult);
    expect(s.store.must<ApprovalServiceRetry>(APPROVAL_RETRY_ENTITY, s.w.id)).toEqual(retry);
    const restarted = new Engine(s.store, s.config);
    restarted.recover();
    const dispatch = vi.spyOn(restarted, "dispatch").mockResolvedValue(undefined);
    await resumeModelWaits(restarted, retry.retry_at - 1);
    expect(dispatch).not.toHaveBeenCalled();
    await resumeModelWaits(restarted, retry.retry_at);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(restarted.get(s.w.id)).toMatchObject({ state: "QUEUED", stage: "planner_commit" });
    expect(s.store.get("run_continuation", s.w.id)).toMatchObject({ source_run_id: s.run.id, conversation_id: SESSION, purpose: "execute", role: "planner" });
    expect(s.store.get("pending_model_retry", s.w.id)).toMatchObject({ retry_run_id: s.run.id,
      input_feedback: expect.stringContaining("不要回放整个脚本") });
    const rebound = bindProfile(s.store, s.config, s.w.id, "planner_commit", { retry_run_id: s.run.id });
    expect(rebound.profile).toEqual(s.run.profile);
    expect(rebound.frozen_invocation).toEqual(s.run.frozen_invocation);
    expect(s.store.get(APPROVAL_BUDGET_ENTITY, approvalBudgetKey(s.run))).toEqual({ count: 1 });
    await resumeModelWaits(restarted, retry.retry_at + 99999);
    expect(dispatch).toHaveBeenCalledOnce();
    // Replaying the already consumed source Run cannot reopen its automatic budget.
    s.store.put("workflow", s.w.id, s.w.project_id, { ...restarted.get(s.w.id), state: "EXECUTING" });
    await restarted.receiveRoundResult(s.w.id, s.run.id, capacityResult);
    expect(restarted.get(s.w.id).state).toBe("WAITING_INPUT");
    expect(s.store.get(APPROVAL_RETRY_ENTITY, s.w.id)).toBeUndefined();
    expect(s.store.get(APPROVAL_BUDGET_ENTITY, approvalBudgetKey(s.run))).toEqual({ count: 1 });
  } finally { await s.cleanup(); }
});

it("persists a three-retry budget across new Runs and then explains the exhausted wait", async () => {
  const s = approvalFixture();
  vi.spyOn(s.engine, "dispatch").mockResolvedValue(undefined);
  try {
    let run = s.run;
    for (let count = 0; count < 4; count++) {
      s.store.put("workflow", s.w.id, s.w.project_id, { ...s.engine.get(s.w.id), state: "EXECUTING", run_id: run.id });
      s.store.put("run", run.id, s.w.id, { ...run, status: "running" });
      const observer = new ApprovalFailureObserver(s.store, s.w.id, run.id);
      const record = (payload: Record<string, unknown>) => observer.accept({ type: "response_item", payload,
        timestamp: new Date().toISOString() }, SESSION);
      record({ type: "custom_tool_call", name: "exec", call_id: "call-1", input: "git add app.txt" });
      record(approvalOutput());
      s.store.put("run", run.id, s.w.id, { ...run, status: "completed" });
      const before = Date.now();
      await s.engine.receiveRoundResult(s.w.id, run.id, capacityResult);
      if (count === 3) break;
      const retry = s.store.must<ApprovalServiceRetry>(APPROVAL_RETRY_ENTITY, s.w.id);
      expect(retry.attempt).toBe(count + 1);
      expect(retry.retry_at).toBeGreaterThanOrEqual(before + APPROVAL_RETRY_DELAYS[count]!);
      await resumeModelWaits(s.engine, retry.retry_at);
      run = { ...run, id: `run-${count + 2}` };
    }
    expect(s.engine.get(s.w.id).state).toBe("WAITING_INPUT");
    expect(s.engine.get(s.w.id).blocker?.message).toContain("已自动重试 3 次");
    expect(s.store.get(APPROVAL_RETRY_ENTITY, s.w.id)).toBeUndefined();
    expect(s.store.get(APPROVAL_BUDGET_ENTITY, approvalBudgetKey(run))).toEqual({ count: 3 });
  } finally { await s.cleanup(); }
});

it.each(["no-fact", "other-question", "safety-denial", "same-action-succeeded"])("does not override human decisions or invent infrastructure failures: %s", async mode => {
  const s = approvalFixture();
  try {
    if (mode !== "no-fact") s.fail();
    if (mode === "safety-denial" || mode === "same-action-succeeded") {
      s.accept({ type: "custom_tool_call", name: "exec", call_id: "retry",
        input: "await tools.exec_command({cmd: 'git add app.txt'})" });
      s.accept(mode === "safety-denial" ? { ...approvalOutput("Safety review rejected this action"), call_id: "retry" }
        : { type: "custom_tool_call_output", call_id: "retry", output: [{ type: "input_text", text: "Script completed" }] });
    }
    await s.engine.receiveRoundResult(s.w.id, s.run.id, mode === "other-question"
      ? { status: "need_user", summary: "请决定是否删除数据库", user_interaction: { kind: "question", title: "删除确认", message: "需要决定", question: "是否删除？" } }
      : capacityResult);
    expect(s.engine.get(s.w.id).state).toBe("WAITING_INPUT");
    expect(s.store.get(APPROVAL_RETRY_ENTITY, s.w.id)).toBeUndefined();
  } finally { await s.cleanup(); }
});

it.each([true, false])("historical failed processes block recovery only until exit is confirmed: confirmed=%s", async confirmed => {
  const s = approvalFixture();
  const dispatch = vi.spyOn(s.engine, "dispatch").mockResolvedValue(undefined);
  try {
    s.fail();
    s.store.put("run", s.run.id, s.w.id, { ...s.run, status: "completed" });
    s.store.put("process_record", "historical-failed-process", s.w.id, {
      id: "historical-failed-process", status: "failed", confirmed,
    });
    await s.engine.receiveRoundResult(s.w.id, s.run.id, capacityResult);
    const retry = s.store.must<ApprovalServiceRetry>(APPROVAL_RETRY_ENTITY, s.w.id);
    await resumeModelWaits(s.engine, retry.retry_at);
    expect(dispatch).toHaveBeenCalledTimes(confirmed ? 1 : 0);
    expect(s.engine.get(s.w.id).state).toBe(confirmed ? "QUEUED" : "BLOCKED");
    expect(s.store.get(APPROVAL_BUDGET_ENTITY, approvalBudgetKey(s.run))).toEqual(confirmed ? { count: 1 } : undefined);
  } finally { await s.cleanup(); }
});

it.each(["pause", "new-run", "new-plan", "maintenance", "running-process"])("does not wake stale, stopped, maintained or unsettled work: %s", async mode => {
  const s = approvalFixture();
  const dispatch = vi.spyOn(s.engine, "dispatch").mockResolvedValue(undefined);
  try {
    s.fail();
    s.store.put("run", s.run.id, s.w.id, { ...s.run, status: "completed" });
    await s.engine.receiveRoundResult(s.w.id, s.run.id, capacityResult);
    const retry = s.store.must<ApprovalServiceRetry>(APPROVAL_RETRY_ENTITY, s.w.id);
    if (mode === "pause") await s.engine.stop(s.w.id, "local_console");
    if (mode === "new-run") s.store.put("workflow", s.w.id, s.w.project_id, { ...s.engine.get(s.w.id), run_id: "replacement" });
    if (mode === "new-plan") s.store.put("workflow", s.w.id, s.w.project_id, { ...s.engine.get(s.w.id), plan_revision: 2 });
    if (mode === "maintenance") s.engine.maintenanceBlocked = true;
    if (mode === "running-process") s.store.put("run", s.run.id, s.w.id, { ...s.run, status: "running" });
    await resumeModelWaits(s.engine, retry.retry_at);
    expect(dispatch).not.toHaveBeenCalled();
    expect(s.store.get(APPROVAL_BUDGET_ENTITY, approvalBudgetKey(s.run))).toBeUndefined();
    if (mode === "pause") {
      s.store.remove(APPROVAL_FAILURE_ENTITY, s.run.id);
      s.fail();
      await s.engine.receiveRoundResult(s.w.id, s.run.id, capacityResult);
      expect(s.engine.get(s.w.id).state).toBe("STOPPED");
      expect(s.store.get(APPROVAL_RETRY_ENTITY, s.w.id)).toBeUndefined();
    }
  } finally { await s.cleanup(); }
});
