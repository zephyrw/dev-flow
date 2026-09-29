import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setup, plan, project, repository } from "../helpers.js";
import * as planReview from "../../packages/core/src/plan-review.js";
import { objectHash } from "../../packages/core/src/util.js";
import { resumeApproved } from "../../packages/runtime/src/recovery.js";
import { ConversationService } from "../../packages/core/src/conversation-service.js";
import { ConversationControlService } from "../../packages/core/src/conversation-control.js";
import { ProfileRuntime, currentRunUserGuidance, invokePrompt } from "../../packages/runtime/src/profile-runtime.js";
import { FeedbackService } from "../../packages/core/src/feedback-service.js";
import { recordExecutionTestReport } from "../../packages/core/src/execution-test-progress.js";
import { roleBoundaryInstructionsFor } from "../../packages/core/src/role-boundaries.js";
import { unknownSubagentCapabilities, type Run, type Workflow } from "../../packages/contracts/src/index.js";

let s: ReturnType<typeof setup>;
const wid = "acceptance-guidance";
const text = "你本地启动前后端，我来验收，注意单独worktree用单独端口";
beforeEach(() => {
  s = setup();
  s.store.put("project", "p1", "p1", project(s.root));
  const time = new Date().toISOString();
  const w: Workflow = { id: wid, project_id: "p1", title: "acceptance", request: "original task", complexity: "simple",
    workspace_mode: "new_worktree", state: "HUMAN_PENDING", stage: "accept", plan_revision: 1, plan_hash: "approved",
    environment_revision: 0, quality_policy_version: 2, version: 1, feedback: [], created_at: time, updated_at: time };
  s.store.put("workflow", wid, "p1", w);
  const p = plan("project", "a".repeat(40)); p.task_model = "native-v2";
  s.store.put("plan", `${wid}-1`, wid, { revision: 1, hash: "approved", plan: p });
  vi.spyOn(s.engine, "dispatch").mockResolvedValue(undefined);
});
afterEach(() => { vi.restoreAllMocks(); s.store.close(); });
function run(purpose: Run["purpose"] = "functional_fix"): Run {
  return { id: "acceptance-run", workflow_id: wid, plan_revision: 1, adapter: "agy", purpose, protocol: "lightweight",
    ...(purpose === "functional_fix" ? { dispatch_context: { purpose, guidance_mode: "human_acceptance" as const } } : {}),
    quality_policy_version: 2, stage: purpose!, status: "completed", started_at: new Date().toISOString(),
    package_hash: "package", conversation_id: "existing-native-session" };
}
function materials(r = run()) {
  // These assertions cover first-stage material composition, not material
  // publication. Real process follow-up tests exercise the lazy path separately.
  const record = s.engine.plan(wid);
  const ready = vi.spyOn(planReview, "assertPlanMaterialReady").mockReturnValue({
    ...record, markdown: record.plan.markdown ?? "", path: "fixture-plan.md",
  } as any);
  try { return (new ProfileRuntime(s.engine, {} as any) as any).executeMaterials(s.engine.get(wid), r); }
  finally { ready.mockRestore(); }
}

async function prepareRealDispatch() {
  vi.mocked(s.engine.dispatch).mockRestore();
  const repo = await repository(s.root);
  const p = project(repo.repo);
  s.store.put("project", p.id, p.id, p);
  s.store.put("workflow", wid, p.id, { ...s.engine.get(wid), workspace_mode: "existing_workspace" });
  s.store.put("plan", `${wid}-1`, wid, { revision: 1, hash: "approved", plan: { ...plan(objectHash(p), repo.baseline), task_model: "native-v2" } });
  s.store.put("approval", `${wid}-1`, wid, { plan_hash: "approved" });
}

it.each([
  "你是否已经做过真实 OpenTabs 验证？请直接回答，没有做过就如实说明。",
  "启动前后端让我验收，使用独立端口并保持服务运行。",
  "把保存按钮的点击问题修好，并检查这次修改。",
])("ordinary guidance runs through feedback → dispatch → model completion without delivery: %s", async guidanceText => {
  await prepareRealDispatch();
  const observed: Run[] = [];
  s.store.put("workflow", wid, "p1", { ...s.engine.get(wid), snapshot_id: "prior-accepted-snapshot" });
  const priorProgress = { implementation_run_id: "prior-implementation", completion_run_id: "prior-implementation" };
  s.store.put("plan_check_review_intent", wid, wid, priorProgress);
  const profile = new ProfileRuntime(s.engine, {} as any);
  vi.spyOn(profile as any, "invoke").mockImplementation(async (_w: unknown, candidate: unknown, handoff: unknown) => {
    const r = candidate as Run; observed.push(r);
    expect(r.dispatch_context?.guidance_mode).toBe("human_acceptance");
    expect(currentRunUserGuidance(s.store, wid, r)?.messages[0]?.text).toBe(guidanceText);
    expect(handoff).not.toHaveProperty("test_result_targets");
    expect(handoff).not.toHaveProperty("functional_issues");
    expect(handoff).not.toHaveProperty("execution_order");
    return { status: "completed", summary: "本条指导的真实回复", notes: "本轮动作已说明" };
  });
  s.engine.runtime = { execute: (w, r, token) => profile.execute(w, r, token),
    review: async () => { throw new Error("Guidance must not start review"); },
    check: async () => { throw new Error("Guidance must not start all-plan tests"); },
    stop: async () => {}, close: async () => {} };
  const message = new FeedbackService(s.store).submitFeedback({ request_id: "real-guidance", workflow_id: wid, kind: "execution", text: guidanceText });
  s.engine.queueFormalFeedback(wid, message.message_id);
  await s.engine.dispatch();
  await s.engine.waitForIdle(wid);
  expect(observed).toHaveLength(1);
  expect(s.engine.get(wid)).toMatchObject({ state: "HUMAN_PENDING", stage: "accept", plan_hash: "approved", snapshot_id: "prior-accepted-snapshot" });
  expect(s.store.get("plan_check_review_intent", wid)).toEqual(priorProgress);
  expect(s.store.get<any>("execution_completion", observed[0]!.id).summary).toContain("本轮动作已说明");
  const events = s.store.events(wid, 0, 1000);
  expect(events.some(e => JSON.stringify(e.payload).includes('"VERIFYING"'))).toBe(false);
  expect(events.some(e => e.type === "DeliveryAccepted" || e.type === "FunctionalFixReadyForHuman")).toBe(false);
  expect(events.filter(e => e.type === "StateChanged").at(-1)?.payload)
    .toMatchObject({ to: "HUMAN_PENDING", guidance_mode: "human_acceptance" });
  for (const entity of ["delivery", "delivery_revision", "functional_issue", "review", "task_proof", "acceptance"])
    expect(s.store.list(entity, wid)).toHaveLength(0);
}, 45000);

it.each(["recover", "new-guidance"] as const)("acceptance guidance keeps mode and unfinished message after stop and %s", async resumeKind => {
  await prepareRealDispatch();
  const observed: Run[] = [];
  let release!: () => void;
  const paused = new Promise<void>(resolve => { release = resolve; });
  const conversations = new ConversationService(s.store);
  conversations.setCapabilities(wid, { ...unknownSubagentCapabilities(), resume: "native", stop: "native" });
  const controls = new ConversationControlService(s.store, conversations, {
    stopConversation: async () => ({ accepted: true, confirmation: "exited" }),
  });
  s.engine.pauseTree = (key, input) => controls.pauseTree(key, input);
  s.engine.runtime = {
    execute: async (_w, r) => {
      observed.push(r);
      if (observed.length === 1) {
        s.store.put("run", r.id, wid, { ...r, conversation_id: "same-native-session" });
        conversations.applyEvent({ project_id: "p1", workflow_id: wid, run_id: r.id, adapter_id: r.adapter,
          scope: "execution", lineage_id: "main", purpose: r.purpose!, root_native_id: "same-native-session" }, {
          source_id: "fixture", source_seq: "1", kind: "discovered", root_native_id: "same-native-session", session_native_id: "same-native-session",
          payload: { title: "Main task", status: "running" },
        });
        await paused; return;
      }
      expect(r.dispatch_context?.guidance_mode).toBe("human_acceptance");
      expect(currentRunUserGuidance(s.store, wid, r)?.messages[0]?.text)
        .toBe(resumeKind === "new-guidance" ? "继续，并把访问地址给我" : undefined);
      await s.engine.receiveRoundResult(wid, r.id, { status: "completed", summary: "服务已检查可用并保留供验收" });
    }, review: async () => { throw new Error("Unexpected review"); }, check: async () => { throw new Error("Unexpected check"); },
    stop: async () => { release(); return { status: "confirmed_not_started" }; }, close: async () => {},
  };
  try {
    const message = new FeedbackService(s.store).submitFeedback({ request_id: "pause-guidance", workflow_id: wid, kind: "execution", text });
    s.engine.queueFormalFeedback(wid, message.message_id);
    await s.engine.dispatch();
    await expect.poll(() => observed.length, { timeout: 15000 }).toBe(1);
    await s.engine.stop(wid);
    await s.engine.waitForIdle(wid);
    if (resumeKind === "recover") resumeApproved(s.engine, wid);
    else {
      const followup = new FeedbackService(s.store).submitFeedback({ request_id: "resume-guidance", workflow_id: wid, kind: "execution", text: "继续，并把访问地址给我" });
      s.engine.queueFormalFeedback(wid, followup.message_id);
    }
    await s.engine.dispatch();
    await s.engine.waitForIdle(wid);
    expect(observed).toHaveLength(2);
    expect(s.engine.get(wid)).toMatchObject({ state: "HUMAN_PENDING", stage: "accept" });
    expect(s.store.list("delivery", wid)).toHaveLength(0);
  } finally { release(); await s.engine.waitForIdle(wid); }
}, 45000);

it("queues the original instruction in the existing acceptance lane without erasing test progress", () => {
  const prior = { ...run("executor_test"), id: "prior-test" };
  recordExecutionTestReport(s.store, s.engine.get(wid), prior, { test_results: [{ test_id: "UT01", case_id: "UT01", status: "passed" }] });
  const report = s.store.get("execution_test_report", prior.id);
  const message = new FeedbackService(s.store).submitFeedback({ request_id: "user-guidance", workflow_id: wid, kind: "execution", text });
  s.engine.queueFormalFeedback(wid, message.message_id);
  expect(s.engine.get(wid)).toMatchObject({ state: "QUEUED", stage: "acceptance_guidance", feedback: [text], plan_revision: 1, plan_hash: "approved" });
  expect(s.store.jobs().filter(job => job.workflow_id === wid && job.kind === "dispatch_run").map(job => JSON.parse(job.data))).toEqual([
    { purpose: "functional_fix", guidance_mode: "human_acceptance" },
  ]);
  expect(s.store.get("execution_test_report", prior.id)).toEqual(report);
  expect(s.store.list("functional_issue", wid)).toHaveLength(0);
  expect(s.store.list("acceptance", wid)).toHaveLength(0);
});

it("explicit functional feedback retains its existing repair dispatch", () => {
  const message = new FeedbackService(s.store).submitFeedback({ request_id: "explicit-functional", workflow_id: wid, kind: "functional", text: "确认这是一个功能缺陷" });
  s.engine.queueFormalFeedback(wid, message.message_id);
  expect(s.engine.get(wid).stage).toBe("functional_fix");
  expect(s.store.jobs().filter(job => job.kind === "dispatch_run").map(job => JSON.parse(job.data)))
    .toEqual([{ purpose: "functional_fix", repair_kind: "functional" }]);
});

it("hands the exact instruction to the same session and allows setup completion without all-plan retesting", () => {
  const r = run();
  const message = new FeedbackService(s.store).submitFeedback({ request_id: "user-guidance", workflow_id: wid, kind: "execution", text });
  s.store.put("feedback_message", message.message_id, wid, { ...message, status: "acknowledged", ack_run: r.id });
  const handoff = materials(r);
  const prompt = invokePrompt("functional_fix", "HANDOFF.json", "schema.json", undefined, undefined, currentRunUserGuidance(s.store, wid, r));
  expect(prompt).toContain(text);
  expect(handoff.run.conversation_id).toBe("existing-native-session");
  expect(handoff.feedback[0].text).toBe(text);
  expect(handoff.instructions).toContain("先响应本轮指导原文");
  expect(handoff.instructions).toContain("实际地址与端口并保留服务");
  expect(handoff.instructions).toContain("完成受影响的必要测试");
  expect(handoff.completion_instruction).toContain("不要求重新完成整份计划");
  expect(handoff.completion_instruction).not.toContain("必要测试未完成不得声明completed");
  expect(handoff.execution_order).toBeUndefined();
  expect(handoff.skill_resources_usage).toContain("仅启动验收服务不触发整套开发");
});

it("returns a completed setup request to human acceptance without approving or launching a review", async () => {
  const r = run(); s.store.put("run", r.id, wid, r);
  s.store.put("workflow", wid, "p1", { ...s.engine.get(wid), state: "EXECUTING", stage: "functional_fix", run_id: r.id });
  await s.engine.receiveRoundResult(wid, r.id, { status: "completed", summary: "前后端已启动，访问 http://127.0.0.1:18080，服务保留供验收" });
  expect(s.engine.get(wid)).toMatchObject({ state: "HUMAN_PENDING", stage: "accept", run_id: r.id });
  expect(s.store.get("acceptance", wid)).toBeUndefined();
  expect(s.store.must<Run>("run", r.id).conversation_id).toBe("existing-native-session");
  expect(s.store.list("review", wid)).toHaveLength(0);
});

it("preserves mixed questions and browser testing requests instead of reducing them to server setup", () => {
  const r = run();
  const mixed = "启动前后端。之前做过 OpenTabs 真实浏览器测试吗？没做就补做，授权报错也要修复。";
  const message = new FeedbackService(s.store).submitFeedback({ request_id: "mixed-guidance", workflow_id: wid, kind: "execution", text: mixed });
  s.store.put("feedback_message", message.message_id, wid, { ...message, status: "acknowledged", ack_run: r.id });
  const guidance = currentRunUserGuidance(s.store, wid, r);
  const handoff = materials(r);
  expect(guidance?.messages[0]?.text).toBe(mixed);
  expect(invokePrompt("functional_fix", "HANDOFF.json", "schema.json", undefined, undefined, guidance)).toContain(mixed);
  expect(guidance).not.toHaveProperty("instruction");
  expect(invokePrompt("functional_fix", "HANDOFF.json", "schema.json", undefined, undefined, guidance)).toBe(mixed);
  expect(handoff.instructions).toContain("不能用 E2E 结果替代");
  expect(handoff.skill_resources_usage).toContain("落实明确要求的测试");
  expect(handoff.completion_instruction).toContain("不能用启动成功代替问题回答");
});

it.each(["implement", "executor_test"] as const)("keeps required testing and hands a usable acceptance entry from %s", purpose => {
  const handoff = materials(run(purpose));
  expect(handoff.completion_instruction).toContain("必要测试未完成不得声明completed");
  expect(handoff.completion_instruction).toContain("独立且未占用的端口");
  expect(handoff.completion_instruction).toContain("真实 URL");
  expect(roleBoundaryInstructionsFor("quality_review")).toContain("只做代码质量复核");
});

it("keeps later pending instructions in the acceptance lane instead of restarting implementation", async () => {
  const r = run(); s.store.put("run", r.id, wid, r);
  s.store.put("workflow", wid, "p1", { ...s.engine.get(wid), state: "EXECUTING", stage: "functional_fix", run_id: r.id });
  const followup = "后端端口改用18081，并给我新的访问地址";
  new FeedbackService(s.store).submitFeedback({ request_id: "followup", workflow_id: wid, kind: "execution", text: followup });
  await s.engine.receiveRoundResult(wid, r.id, { status: "completed", summary: "服务已启动" });
  expect(s.engine.get(wid)).toMatchObject({ state: "QUEUED", stage: "acceptance_guidance", feedback: [followup] });
  expect(s.store.jobs().filter(job => job.kind === "dispatch_run").map(job => JSON.parse(job.data).purpose)).toEqual(["functional_fix"]);
});
