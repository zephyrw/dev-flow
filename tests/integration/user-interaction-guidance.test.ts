import { afterEach, expect, it, vi } from "vitest";
import { Store } from "../../packages/store/src/store.js";
import { Engine } from "../../packages/core/src/engine.js";
import { ConfigSchema } from "../../packages/contracts/src/config.js";
import type { FeedbackMessage, Workflow } from "../../packages/contracts/src/index.js";
import { UserInteractionService } from "../../packages/core/src/user-interaction-service.js";
import { FeedbackService } from "../../packages/core/src/feedback-service.js";
import { saveWaitingContext } from "../../packages/core/src/waiting-context.js";
import { currentRunUserGuidance, invokePrompt } from "../../packages/runtime/src/profile-runtime.js";

const stores: Store[] = [];
afterEach(() => { vi.restoreAllMocks(); stores.splice(0).forEach(s => s.close()); });

function setup(kind: "action_required" | "question" = "action_required") {
  const store = new Store(":memory:"); stores.push(store);
  const engine = new Engine(store, ConfigSchema.parse({}));
  const service = new UserInteractionService(store);
  const workflow: Workflow = {
    id: "wf-interaction-guidance", project_id: "p1", title: "test", request: "original",
    complexity: "simple", workspace_mode: "existing_workspace", state: "WAITING_INPUT",
    stage: "executor_test", version: 1, plan_revision: 1, environment_revision: 0,
    run_id: "source-run", feedback: [], created_at: "2026-09-29", updated_at: "2026-09-29",
  };
  store.put("workflow", workflow.id, workflow.project_id, workflow);
  store.put("run", "source-run", workflow.id, {
    id: "source-run", workflow_id: workflow.id, plan_revision: 1, purpose: "executor_test",
    stage: "executor_test", status: "completed", conversation_id: "original-session",
  });
  const record = service.createInteraction({
    workflowId: workflow.id, sourceRunId: "source-run", sourcePlanRevision: 1,
    purpose: "execute", role: "executor", nativeSessionId: "original-session",
    rawInput: {
      kind, title: "请协助", message: "旧现场：需要 SSO 凭据", resume_note: "旧继续指令：注入 SSO 凭据",
      ...(kind === "question" ? { question: "选择哪种登录方式？", choices: [{ id: "local", label: "本地免密" }] } : {}),
    },
  });
  saveWaitingContext(store, workflow.id, {
    purpose: "execute", role: "executor", intent: "need_user", run_id: "source-run",
    conversation_id: "original-session", interaction_id: record.id,
  });
  const payload = { request_id: "response", source_run_id: "source-run", action: "confirm" as const };
  return { store, engine, service, workflow, record, payload };
}

it("carries a confirmation correction through the real resume and feedback cursor to the native prompt", async () => {
  const s = setup();
  const answer = "已经换成可用 token。\n不要注入 SSO 凭据；使用本地免密，如有问题修复。";
  const payload = { ...s.payload, answer };
  await s.service.respondInteraction(s.workflow.id, s.record.id, payload, s.engine);
  expect(s.engine.get(s.workflow.id)).toMatchObject({ state: "QUEUED", stage: "executor_test", plan_revision: 1 });
  const continuation = s.store.must<any>("run_continuation", s.workflow.id);
  expect(continuation).toMatchObject({ kind: "user_answer", source_run_id: "source-run", role: "executor", answer: expect.stringContaining(answer) });
  expect(continuation.answer).toContain("历史请求背景");
  expect(continuation.answer).not.toContain("旧继续指令");
  expect(continuation.answer.endsWith(answer)).toBe(true);
  expect(s.store.list("functional_issue", s.workflow.id)).toHaveLength(0);
  const messages = s.store.list<FeedbackMessage>("feedback_message", s.workflow.id);
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({ text: answer, status: "pending", kind: "execution" });
  const jobs = s.store.jobs().length;
  await s.service.respondInteraction(s.workflow.id, s.record.id, payload, s.engine);
  expect(s.store.jobs()).toHaveLength(jobs);
  expect(s.store.list("feedback_message", s.workflow.id)).toHaveLength(1);

  // Consume through the same feedback acknowledgement API used for an active
  // Run; no native CLI or account is involved in this isolated integration.
  const run = { id: "resumed-run", purpose: "executor_test" as const };
  s.store.put("run", run.id, s.workflow.id, { ...run, workflow_id: s.workflow.id, status: "running" });
  s.store.put("workflow", s.workflow.id, s.workflow.project_id, { ...s.engine.get(s.workflow.id), run_id: run.id });
  new FeedbackService(s.store).acknowledgeMessage(s.workflow.id, messages[0]!.message_id);
  const guidance = currentRunUserGuidance(s.store, s.workflow.id, run);
  expect(guidance?.messages.map(m => m.text)).toEqual([answer]);
  const prompt = invokePrompt(run.purpose, "HANDOFF.json", "schema.json", continuation, undefined, guidance);
  expect(prompt.startsWith("本轮用户指导")).toBe(true);
  expect(JSON.parse(prompt.split("\n")[1]!).messages[0].text).toBe(answer);
  expect(prompt).toContain("最新用户指导优先");
  expect(currentRunUserGuidance(s.store, s.workflow.id, { id: "later-run", purpose: "executor_test" })).toBeUndefined();
  expect(currentRunUserGuidance(s.store, s.workflow.id, { id: run.id, purpose: "aside" })).toBeUndefined();
});

it("preserves choices and multiline answers as one ordered user message", async () => {
  const s = setup("question");
  new FeedbackService(s.store).submitFeedback({ request_id: "prior", workflow_id: s.workflow.id, kind: "execution", text: "上一条指导" });
  await s.service.respondInteraction(s.workflow.id, s.record.id, {
    ...s.payload, action: "answer", choice_id: "local", answer: "第一行\n第二行",
  }, s.engine);
  const messages = s.store.list<FeedbackMessage>("feedback_message", s.workflow.id).sort((a, b) => a.seq - b.seq);
  expect(messages.map(m => m.seq)).toEqual([1, 2]);
  expect(messages[1]!.text).toBe("[选择项: 本地免密] 第一行\n第二行");
});

it("does not create guidance or dispatch a cancelled interaction", async () => {
  const s = setup();
  await s.service.respondInteraction(s.workflow.id, s.record.id, { ...s.payload, action: "cancel", answer: "不继续" }, s.engine);
  expect(s.store.list("feedback_message", s.workflow.id)).toHaveLength(0);
  expect(s.store.jobs()).toHaveLength(0);
  expect(s.engine.get(s.workflow.id).state).toBe("WAITING_INPUT");
});

it("rolls back guidance and the receipt if resuming the original role fails", async () => {
  const s = setup();
  vi.spyOn(s.engine, "resumeFromWaiting").mockImplementation(() => { throw new Error("resume failed"); });
  await expect(s.service.respondInteraction(s.workflow.id, s.record.id, { ...s.payload, answer: "继续" }, s.engine)).rejects.toThrow("resume failed");
  expect(s.store.list("feedback_message", s.workflow.id)).toHaveLength(0);
  expect(s.service.getInteraction(s.record.id)?.status).toBe("pending");
  expect(s.store.list("user_interaction_receipt", s.workflow.id)).toHaveLength(0);
});
