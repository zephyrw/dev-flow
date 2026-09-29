import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setup, plan, project } from "../helpers.js";
import { ProfileRuntime, currentRunUserGuidance, invokePrompt } from "../../packages/runtime/src/profile-runtime.js";
import { FeedbackService } from "../../packages/core/src/feedback-service.js";
import { recordExecutionTestReport } from "../../packages/core/src/execution-test-progress.js";
import { roleBoundaryInstructionsFor } from "../../packages/core/src/role-boundaries.js";
import type { Run, Workflow } from "../../packages/contracts/src/index.js";

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
    quality_policy_version: 2, stage: purpose!, status: "completed", started_at: new Date().toISOString(),
    package_hash: "package", conversation_id: "existing-native-session" };
}
function materials(r = run()) {
  return (new ProfileRuntime(s.engine, {} as any) as any).executeMaterials(s.engine.get(wid), r);
}

it("queues the original instruction in the existing acceptance lane without erasing test progress", () => {
  const prior = { ...run("executor_test"), id: "prior-test" };
  recordExecutionTestReport(s.store, s.engine.get(wid), prior, { test_results: [{ test_id: "UT01", case_id: "UT01", status: "passed" }] });
  const report = s.store.get("execution_test_report", prior.id);
  const message = new FeedbackService(s.store).submitFeedback({ request_id: "user-guidance", workflow_id: wid, kind: "execution", text });
  s.engine.queueFormalFeedback(wid, message.message_id);
  expect(s.engine.get(wid)).toMatchObject({ state: "QUEUED", stage: "functional_fix", feedback: [text], plan_revision: 1, plan_hash: "approved" });
  expect(s.store.jobs().filter(job => job.workflow_id === wid && job.kind === "dispatch_run").map(job => JSON.parse(job.data))).toEqual([
    { purpose: "functional_fix", repair_kind: "functional" },
  ]);
  expect(s.store.get("execution_test_report", prior.id)).toEqual(report);
  expect(s.store.list("functional_issue", wid)).toHaveLength(0);
  expect(s.store.list("acceptance", wid)).toHaveLength(0);
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
  expect(guidance?.instruction).toContain("问题、操作要求和约束");
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
  expect(s.engine.get(wid)).toMatchObject({ state: "QUEUED", stage: "functional_fix", feedback: [followup] });
  expect(s.store.jobs().filter(job => job.kind === "dispatch_run").map(job => JSON.parse(job.data).purpose)).toEqual(["functional_fix"]);
});
