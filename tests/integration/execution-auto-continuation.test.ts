import { expect, it, vi } from "vitest";
import { join } from "node:path";
import { setup, project, plan } from "../helpers.js";
import type { FeedbackMessage, Run, Workflow } from "../../packages/contracts/src/index.js";
import { Engine } from "../../packages/core/src/engine.js";
import { Store } from "../../packages/store/src/store.js";
import { frozenInvocationFromProfile, resolveRoutingPreview } from "../../packages/core/src/run-profile.js";
import { readRunContinuation, readWaitingContext } from "../../packages/core/src/waiting-context.js";
import { UserInteractionService } from "../../packages/core/src/user-interaction-service.js";
import { removeDirWithBoundedRetry } from "../fixtures/isolation.js";

function fixture() {
  const s = setup(), time = new Date().toISOString();
  const w: Workflow = { id: "auto-continuation", project_id: "p1", title: "自动继续", request: "完成全部任务",
    complexity: "simple", workspace_mode: "existing_workspace", state: "QUEUED", stage: "execute",
    quality_policy_version: 2, version: 1, plan_revision: 1, plan_hash: "approved",
    environment_revision: 0, feedback: [], created_at: time, updated_at: time };
  s.store.put("project", w.project_id, w.project_id, project(s.root));
  s.store.put("workflow", w.id, w.project_id, w);
  s.store.put("plan", `${w.id}-1`, w.id, { revision: 1, hash: w.plan_hash,
    plan: { ...plan("project", "a".repeat(40)), task_model: "native-v2" } });
  return { ...s, w };
}
type Fixture = ReturnType<typeof fixture>;

function executing(s: Fixture, id: string, changes: Partial<Run> = {}): Run {
  const w = s.engine.get(s.w.id);
  const run: Run = { id, workflow_id: w.id, plan_revision: w.plan_revision,
    adapter: "agy", purpose: "implement", stage: "execute", protocol: "lightweight",
    routing_role: "executor", status: "running", started_at: new Date().toISOString(), package_hash: "fixture",
    logical_round_id: "logical-original", profile: { id: "original-model", revision: 1,
      adapterId: "agy", executableRef: "agy", modelSelection: "explicit", modelId: "gemini-original", options: {} },
    continuation: readRunContinuation(s.store, w.id), ...changes };
  run.frozen_invocation ??= frozenInvocationFromProfile(run.profile!, "profile-native");
  s.store.put("run", id, w.id, run);
  s.store.remove("run_continuation", w.id);
  s.store.remove("pending_model_retry", w.id);
  s.engine.transition(w.id, [w.state], "EXECUTING", run.stage, { run_id: id, blocker: undefined });
  return run;
}

async function cleanup(s: Fixture) {
  s.engine.runtime = undefined;
  s.store.close();
  await removeDirWithBoundedRetry(s.root);
}

const question = { kind: "question", title: "请选择测试账号", message: "测试需要指定真实账号",
  question: "使用哪个测试账号？", allow_free_text: true };

it("queues partial work once and retains the frozen model, stage and original session", async () => {
  const s = fixture();
  try {
    const run = executing(s, "partial", { conversation_id: "original-session", purpose: "executor_test", stage: "executor_test" });
    const result = { status: "incomplete", completed_items: ["T01"], unfinished_items: ["T02"], summary: "第一部分完成" };
    expect(await s.engine.receiveRoundResult(s.w.id, run.id, result)).toMatchObject({ status: "queued" });
    expect(s.engine.get(s.w.id)).toMatchObject({ state: "QUEUED", stage: "executor_test" });
    expect(readRunContinuation(s.store, s.w.id)).toMatchObject({ kind: "execution_continue",
      source_run_id: run.id, conversation_id: "original-session", role: "executor" });
    expect(s.store.get("execution_auto_continuation", run.id)).toMatchObject({ mode: "continue", completed_items: ["T01"], no_progress_count: 0 });
    const preview = resolveRoutingPreview(s.store, s.config, s.w.id, { purpose: "executor_test", retry_run_id: run.id });
    expect(preview.profile).toEqual(run.profile);
    expect(preview.frozen_invocation).toEqual(run.frozen_invocation);
    expect(preview.logical_round_id).toBe(run.logical_round_id);
    expect(s.store.get("execution_completion", run.id)).toBeUndefined();
    expect(s.store.list("user_interaction", s.w.id)).toHaveLength(0);
    const version = s.engine.get(s.w.id).version, events = s.store.events(s.w.id).length;
    await s.engine.receiveRoundResult(s.w.id, run.id, result);
    expect(s.engine.get(s.w.id).version).toBe(version);
    expect(s.store.events(s.w.id)).toHaveLength(events);
    expect(s.store.list("execution_auto_continuation", s.w.id)).toHaveLength(1);
  } finally { await cleanup(s); }
});

it.each([
  { status: "incomplete", workflow_id: "another-workflow" },
  { status: "incomplete", run_id: "another-run" },
  { status: "completed", unfinished_items: ["T02"], workflow_id: "another-workflow" },
  { summary: "第一部分完成", delivery: { workflow_id: "another-workflow" } },
  { status: "incomplete", delivery: { run_id: "another-run" } },
])("rejects foreign result ownership before scheduling automatic execution or clarification: %j", async result => {
  const s = fixture();
  try {
    const run = executing(s, "owned-result", { conversation_id: "original-session" });
    await expect(s.engine.receiveRoundResult(s.w.id, run.id, result))
      .rejects.toMatchObject({ code: "ROUND_RESULT_IDENTITY_MISMATCH" });
    expect(s.engine.get(s.w.id).state).toBe("EXECUTING");
    expect(s.store.list("execution_auto_continuation", s.w.id)).toHaveLength(0);
    expect(readRunContinuation(s.store, s.w.id)).toBeUndefined();
    expect(s.store.get("pending_model_retry", s.w.id)).toBeUndefined();
  } finally { await cleanup(s); }
});

it("accepts an echoed source run only when it belongs to the same workflow and native conversation", async () => {
  const s = fixture();
  try {
    const prior = executing(s, "same-session-source", { conversation_id: "original-session", status: "completed" });
    const run = executing(s, "same-session-followup", { conversation_id: "original-session" });
    await expect(s.engine.receiveRoundResult(s.w.id, run.id, {
      status: "incomplete", run_id: prior.id, delivery: { run_id: prior.id }, completed_items: ["T01"],
    })).resolves.toMatchObject({ status: "queued" });
    expect(readRunContinuation(s.store, s.w.id)?.source_run_id).toBe(run.id);
  } finally { await cleanup(s); }
});

it.each([{ summary: "阶段总结：已读前两章" }, { status: "need_user", summary: "阶段总结：完成部分" },
  { status: "completed", unfinished_items: ["T02"] }])("checks an incomplete or unclear summary without opening a popup: %j", async result => {
  const s = fixture();
  try {
    const run = executing(s, "summary");
    await s.engine.receiveRoundResult(s.w.id, run.id, result);
    expect(s.engine.get(s.w.id).state).toBe("QUEUED");
    expect(readRunContinuation(s.store, s.w.id)).toMatchObject({ kind: "execution_check", source_run_id: run.id });
    expect(s.store.list("user_interaction", s.w.id)).toHaveLength(0);
    const check = executing(s, "check");
    await s.engine.receiveRoundResult(s.w.id, check.id, { summary: "仍然只有总结" });
    expect(s.engine.get(s.w.id).state).toBe("WAITING_INPUT");
    expect(new UserInteractionService(s.store).getCurrentInteraction(s.w.id)?.request.title).toBe("自动续执行需要处理意见");
    expect(s.store.get("execution_auto_continuation", check.id)).toBeUndefined();
  } finally { await cleanup(s); }
});

it.each([
  { status: "need_user", user_interaction: question },
  { status: "incomplete", delivery: { status: "incomplete", user_interaction: question } },
  { status: "need_user", user_interaction: { kind: "action_required", title: "请登录", message: "请在浏览器登录测试环境后继续" } },
])("preserves actual user decisions and actions: %j", async result => {
  const s = fixture();
  try {
    const run = executing(s, "ask");
    expect(await s.engine.receiveRoundResult(s.w.id, run.id, result)).toMatchObject({ status: "need_user" });
    expect(s.engine.get(s.w.id).state).toBe("WAITING_INPUT");
    expect(new UserInteractionService(s.store).getCurrentInteraction(s.w.id)?.request.message)
      .toBe(result.user_interaction?.message ?? result.delivery!.user_interaction.message);
    expect(s.store.list("execution_auto_continuation", s.w.id)).toHaveLength(0);
    expect(readWaitingContext(s.store, s.w.id)?.intent).toBe("need_user");
  } finally { await cleanup(s); }
});

it("stops after three consecutive rounds without a newly completed item", async () => {
  const s = fixture();
  try {
    for (let index = 1; index <= 3; index++) {
      const run = executing(s, `no-progress-${index}`);
      await s.engine.receiveRoundResult(s.w.id, run.id, { status: "incomplete", summary: `换一种说法 ${index}` });
      expect(s.engine.get(s.w.id).state).toBe(index === 3 ? "WAITING_INPUT" : "QUEUED");
      if (index < 3) expect(s.store.get("execution_auto_continuation", run.id)).toMatchObject({ no_progress_count: index });
    }
    expect(new UserInteractionService(s.store).getCurrentInteraction(s.w.id)?.request.message).toContain("连续三轮");
  } finally { await cleanup(s); }
});

it.each([
  { status: "completed", unfinished_items: ["T02"], user_interaction: question },
  { status: "completed", delivery: { unfinished_items: ["T02"], user_interaction: question } },
])("waits for the declared user request instead of clarifying a contradictory completion: %j", async result => {
  const s = fixture();
  try {
    const run = executing(s, "contradictory-request", { conversation_id: "original-session" });
    await expect(s.engine.receiveRoundResult(s.w.id, run.id, result)).resolves.toMatchObject({ status: "need_user" });
    expect(s.engine.get(s.w.id).state).toBe("WAITING_INPUT");
    const interaction = new UserInteractionService(s.store).getCurrentInteraction(s.w.id);
    expect(interaction).toMatchObject({ status: "pending", request: { question: question.question } });
    expect(interaction?.response).toBeUndefined();
    expect(s.store.list("execution_auto_continuation", s.w.id)).toHaveLength(0);
    expect(s.store.get("execution_completion", run.id)).toBeUndefined();
    await s.engine.dispatch();
    expect(s.store.list("run", s.w.id)).toHaveLength(1);
  } finally { await cleanup(s); }
});

it("does not consume the execution stall budget while only clarifying a result", async () => {
  const s = fixture();
  try {
    const first = executing(s, "unclear-first");
    await s.engine.receiveRoundResult(s.w.id, first.id, { summary: "第一轮总结" });
    expect(s.store.get("execution_auto_continuation", first.id)).toMatchObject({ no_progress_count: 1, mode: "clarify" });
    const clarification = executing(s, "clarification-only");
    expect(clarification.continuation?.kind).toBe("execution_check");
    await s.engine.receiveRoundResult(s.w.id, clarification.id, { status: "incomplete", unfinished_items: ["T01"] });
    expect(s.store.get("execution_auto_continuation", clarification.id)).toMatchObject({ no_progress_count: 1, mode: "continue" });
    const nextExecution = executing(s, "actual-execution");
    await s.engine.receiveRoundResult(s.w.id, nextExecution.id, { status: "incomplete" });
    expect(s.store.get("execution_auto_continuation", nextExecution.id)).toMatchObject({ no_progress_count: 2 });
    expect(s.engine.get(s.w.id).state).toBe("QUEUED");
  } finally { await cleanup(s); }
});

it("waits for the source process exit while ignoring an unrelated running acceptance service", async () => {
  const s = fixture();
  try {
    const source = executing(s, "process-source");
    await s.engine.receiveRoundResult(s.w.id, source.id, { status: "incomplete" });
    s.store.put("process_record", source.id, s.w.id, { status: "exited", confirmed: false });
    s.store.put("process_record", "acceptance-service", s.w.id, { status: "running", confirmed: false });
    // Observe admission to the existing run launcher without starting a CLI.
    const launch = vi.spyOn(s.engine as unknown as { run(...args: unknown[]): Promise<void> }, "run").mockResolvedValue();
    s.engine.runtime = { execute: vi.fn(), review: vi.fn(), stop: vi.fn(), close: vi.fn(), check: vi.fn() };
    await s.engine.dispatch();
    expect(launch).not.toHaveBeenCalled();
    expect(s.store.get("queue_wait", s.w.id)).toMatchObject({ owners: [source.id], message: "等待上一轮模型进程退出后继续剩余任务" });
    s.store.put("process_record", source.id, s.w.id, { status: "exited", confirmed: true });
    await s.engine.dispatch();
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch.mock.calls[0]?.[0]).toBe(s.w.id);
    expect(s.store.get("process_record", "acceptance-service")).toMatchObject({ status: "running" });
    launch.mockRestore();
  } finally { await cleanup(s); }
});

it("finishes the resumed test stage and reaches human acceptance without another continuation", async () => {
  const s = fixture();
  try {
    s.store.put("quality_flow", s.w.id, s.w.id, { workflow_id: s.w.id, phase: "before_human",
      executor_repair_completed: true, planner_repairs_only: true });
    const partial = executing(s, "partial-test", { purpose: "executor_test", stage: "executor_test",
      dispatch_context: { purpose: "executor_test", review_phase: "before_human" } });
    await s.engine.receiveRoundResult(s.w.id, partial.id, { status: "incomplete", completed_items: ["UT01"], unfinished_items: ["IT01"] });
    const finished = executing(s, "finished-test", { purpose: "executor_test", stage: "executor_test",
      status: "completed", exit_code: 0, dispatch_context: { purpose: "executor_test", review_phase: "before_human" } });
    await s.engine.receiveRoundResult(s.w.id, finished.id, { status: "completed", summary: "当前阶段全部完成", unfinished_items: [] });
    expect(s.engine.get(s.w.id).state).toBe("HUMAN_PENDING");
    expect(s.store.get("execution_completion", finished.id)).toMatchObject({ intent: "completed" });
    expect(s.store.get("execution_auto_continuation", finished.id)).toBeUndefined();
    expect(s.store.list("user_interaction", s.w.id)).toHaveLength(0);
  } finally { await cleanup(s); }
});

it("resets the stall count for new identifiers and continues longer than three rounds", async () => {
  const s = fixture();
  try {
    for (let index = 1; index <= 6; index++) {
      const run = executing(s, `progress-${index}`);
      const completed_items = index <= 2 ? [] : [`T${index}`];
      await s.engine.receiveRoundResult(s.w.id, run.id, { status: "incomplete", completed_items, unfinished_items: ["remaining"] });
      expect(s.engine.get(s.w.id).state).toBe("QUEUED");
      expect(s.store.get("execution_auto_continuation", run.id)).toMatchObject({ no_progress_count: index <= 2 ? index : 0 });
    }
    expect(s.store.get("execution_auto_continuation", "progress-6")).toMatchObject({ completed_items: ["T3", "T4", "T5", "T6"] });
    expect(s.store.list("user_interaction", s.w.id)).toHaveLength(0);
  } finally { await cleanup(s); }
});

it("retains the continuation and its stall budget across a controller reload", async () => {
  let s = fixture();
  try {
    const first = executing(s, "before-reload");
    await s.engine.receiveRoundResult(s.w.id, first.id, { status: "incomplete" });
    const second = executing(s, "before-reload-2");
    await s.engine.receiveRoundResult(s.w.id, second.id, { status: "incomplete" });
    s.store.close();
    const store = new Store(join(s.config.storage_root, "devflow.sqlite"));
    s = { ...s, store, engine: new Engine(store, s.config) };
    expect(readRunContinuation(store, s.w.id)?.source_run_id).toBe(second.id);
    const third = executing(s, "after-reload");
    await s.engine.receiveRoundResult(s.w.id, third.id, { status: "incomplete" });
    expect(s.engine.get(s.w.id).state).toBe("WAITING_INPUT");
    expect(new UserInteractionService(store).getCurrentInteraction(s.w.id)?.request.message).toContain("连续三轮");
  } finally { await cleanup(s); }
});

it("does not revive a user-stopped run when its partial result arrives late", async () => {
  const s = fixture();
  try {
    const run = executing(s, "stopped");
    await s.engine.stop(s.w.id);
    expect(await s.engine.receiveRoundResult(s.w.id, run.id, { status: "incomplete" })).toMatchObject({ status: "ignored" });
    expect(s.engine.get(s.w.id).state).toBe("STOPPED");
    expect(s.store.list("execution_auto_continuation", s.w.id)).toHaveLength(0);
    expect(s.store.list("user_interaction", s.w.id)).toHaveLength(0);
  } finally { await cleanup(s); }
});

it("queues pending user guidance before an automatic continuation", async () => {
  const s = fixture();
  try {
    const run = executing(s, "with-user-input");
    const feedback: FeedbackMessage = { message_id: "new-input", client_request_id: "new-input", seq: 1,
      workflow_id: s.w.id, kind: "execution", text: "先检查新的需求说明", refs: [], attachment_ids: [],
      target_document_revision: 0, status: "pending", created_at: new Date().toISOString() };
    s.store.put("feedback_message", feedback.message_id, s.w.id, feedback);
    await s.engine.receiveRoundResult(s.w.id, run.id, { status: "incomplete" });
    expect(s.engine.get(s.w.id).state).toBe("QUEUED");
    expect(s.store.list("execution_auto_continuation", s.w.id)).toHaveLength(0);
    expect(readRunContinuation(s.store, s.w.id)).toBeUndefined();
    expect(s.store.get("feedback_message", feedback.message_id)).toMatchObject({ status: "pending", text: feedback.text });
  } finally { await cleanup(s); }
});

it.each(["planner_commit", "functional_fix"] as const)("does not automatically continue the unrelated %s role", async purpose => {
  const s = fixture();
  try {
    const run = executing(s, purpose, { purpose, stage: purpose, routing_role: purpose === "planner_commit" ? "planner" : "executor" });
    await s.engine.receiveRoundResult(s.w.id, run.id, { summary: "本轮说明" });
    expect(s.engine.get(s.w.id).state).toBe("WAITING_INPUT");
    expect(s.store.list("execution_auto_continuation", s.w.id)).toHaveLength(0);
  } finally { await cleanup(s); }
});

it("keeps an unclear review on the existing human clarification route", async () => {
  const s = fixture();
  try {
    const run = executing(s, "review", { purpose: "quality_review", stage: "quality_before_human", routing_role: "planner" });
    s.engine.transition(s.w.id, ["EXECUTING"], "REVIEWING", run.stage);
    await s.engine.receiveReview(s.w.id, { summary: "本轮审查说明" });
    expect(s.engine.get(s.w.id).state).toBe("WAITING_INPUT");
    expect(readWaitingContext(s.store, s.w.id)?.purpose).toBe("review");
    expect(s.store.list("execution_auto_continuation", s.w.id)).toHaveLength(0);
  } finally { await cleanup(s); }
});
