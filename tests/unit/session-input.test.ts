import { afterEach, expect, it } from "vitest";
import { Store } from "../../packages/store/src/store.js";
import type { Run, FeedbackMessage } from "../../packages/contracts/src/index.js";
import { followupText, inputStageKey, isSessionFollowup, pendingRunMessages, runUserInputText, selectRunInputMessages } from "../../packages/core/src/session-input.js";

const stores: Store[] = [];
afterEach(() => stores.splice(0).forEach(store => store.close()));
function fixture() {
  const store = new Store(":memory:"); stores.push(store);
  const run: Run = { id: "current", workflow_id: "w", plan_revision: 1, purpose: "implement", adapter: "agy",
    status: "running", stage: "execute", started_at: "2026-09-29T08:00:00Z", package_hash: "p" };
  store.put("run", run.id, "w", run);
  const message: FeedbackMessage = { message_id: "m", client_request_id: "req", seq: 1, workflow_id: "w",
    kind: "execution", text: "  原文\r\n不要重读任务！\n", refs: [], attachment_ids: [], target_document_revision: 0,
    status: "acknowledged", ack_run: run.id, created_at: run.started_at };
  store.put("feedback_message", message.message_id, "w", message);
  return { store, run, message };
}
it("sends exact user text in the original session, including whitespace", () => {
  const {store, run, message} = fixture();
  store.put("run", "prior", "w", {...run, id: "prior", conversation_id: "native"});
  expect(isSessionFollowup(store, run, "native", [message])).toBe(true);
  expect(followupText(store, run, pendingRunMessages(store, "w", run))).toBe(message.text);
});
it("does not treat a first stage or a changed review phase as a continuation", () => {
  const {store, run} = fixture();
  expect(isSessionFollowup(store, run, undefined, [])).toBe(false);
  const prior = {...run, id: "prior", conversation_id: "native", purpose: "quality_review" as const,
    dispatch_context: {purpose: "quality_review" as const, review_phase: "before_human" as const}};
  store.put("run", prior.id, "w", prior);
  expect(isSessionFollowup(store, {...prior, id: "new", dispatch_context: {...prior.dispatch_context, review_phase: "after_human"}}, "native", [])).toBe(false);
  expect(isSessionFollowup(store, {...prior, id: "new", dispatch_context: {...prior.dispatch_context, review_phase: "after_human"}}, "native", [{kind: "execution"}])).toBe(false);
  expect(isSessionFollowup(store, {...prior, id: "new"}, "native", [])).toBe(true);
});
it("does not replay delivered guidance after a pause even if work is unfinished", () => {
  const {store, run, message} = fixture();
  store.put("session_input", run.id, "w", {run_id: run.id, conversation_id: "native", stage_key: inputStageKey(run),
    kind: "followup", state: "delivered", message_ids: [message.message_id]});
  const resumed = {...run, id: "resumed", continuation: {kind: "runtime_resume" as const, source_run_id: run.id,
    purpose: "execute" as const, role: "executor" as const}};
  expect(pendingRunMessages(store, "w", resumed)).toEqual([]);
  expect(followupText(store, resumed, [])).toBe("继续");
});
it("retries definitely unstarted input but stops on ambiguous delivery", () => {
  const {store, run, message} = fixture();
  const receipt = {run_id: run.id, kind: "followup", message_ids: [message.message_id], state: "prepared"};
  store.put("session_input", run.id, "w", receipt);
  expect(pendingRunMessages(store, "w", run)).toEqual([message]);
  store.put("session_input", run.id, "w", {...receipt, state: "started"});
  expect(() => pendingRunMessages(store, "w", run)).toThrow("投递结果尚未确认");
});
it("preserves legacy native session input without replaying it on upgrade", () => {
  const {store, run} = fixture();
  store.put("run", run.id, "w", {...run, conversation_id: "native", status: "stopped"});
  const resumed = {...run, id: "resumed", continuation: {kind: "runtime_resume" as const, source_run_id: run.id,
    purpose: "execute" as const, role: "executor" as const}};
  expect(pendingRunMessages(store, "w", resumed)).toEqual([]);
  expect(isSessionFollowup(store, resumed, "native", [])).toBe(true);
  expect(() => isSessionFollowup(store, resumed, undefined, [])).toThrow("原会话不可恢复");
});
it("sends an answer without the previous question, task or progress", () => {
  const {store, run} = fixture();
  const answer = "  使用原端口\n";
  const resumed = {...run, continuation: {kind: "user_answer" as const, source_run_id: "previous",
    purpose: "execute" as const, role: "executor" as const, answer, questions: ["端口？"]}};
  expect(followupText(store, resumed, [])).toBe(answer);
});

it("delivers assigned guidance even when the new stage has never received its task materials", () => {
  const {store, run, message} = fixture();
  const testing = {...run, purpose: "executor_test" as const, stage: "executor_test"};
  expect(isSessionFollowup(store, testing, undefined, [message])).toBe(false);
  expect(runUserInputText(store, testing, [message])).toBe(message.text);
  expect(runUserInputText(store, testing, [])).toBeUndefined();
});

it("sends one guidance at a time and returns the other messages to the queue unchanged", () => {
  const {store, run, message} = fixture();
  const second = {...message, message_id: "second", seq: 2, text: "  额外操作\r\n"};
  store.put("feedback_message", second.message_id, "w", second);
  const selected = selectRunInputMessages(store, "w", run);
  expect(selected).toEqual([message]);
  expect(followupText(store, run, [message, second])).toBe(message.text);
  expect(store.get("feedback_message", second.message_id)).toEqual({...second, status: "pending", ack_run: undefined});
});

it("retains unstarted acknowledged guidance for a retry after admission failed before creating a receipt", () => {
  const {store, run, message} = fixture();
  store.put("run", run.id, "w", {...run, status: "failed"});
  const retry = {...run, id: "retry", continuation: {kind: "runtime_resume" as const,
    source_run_id: run.id, purpose: "execute" as const, role: "executor" as const}};
  expect(pendingRunMessages(store, "w", retry)).toEqual([message]);
  expect(runUserInputText(store, retry, pendingRunMessages(store, "w", retry))).toBe(message.text);
});

it("uses confirmed admission rejection to recover historical guidance despite a frozen conversation ID", () => {
  const {store, run, message} = fixture();
  store.put("run", run.id, "w", {...run, status: "failed", conversation_id: "original-session"});
  const retry = {...run, id: "retry", continuation: {kind: "runtime_resume" as const,
    source_run_id: run.id, purpose: "execute" as const, role: "executor" as const}};
  expect(pendingRunMessages(store, "w", retry)).toEqual([]); // Ambiguous legacy input stays protected.
  store.event("w", "project", "AgyAccountAdmissionFailed", {code: "target_model_unavailable"}, run.id);
  expect(pendingRunMessages(store, "w", retry)).toEqual([message]);
  store.put("session_input", run.id, "w", {run_id: run.id, kind: "followup", message_ids: [message.message_id], state: "started"});
  expect(() => pendingRunMessages(store, "w", retry)).toThrow("投递结果尚未确认");
  store.put("session_input", run.id, "w", {run_id: run.id, kind: "followup", message_ids: [message.message_id], state: "delivered"});
  expect(pendingRunMessages(store, "w", retry)).toEqual([]);
});

it("retains rejected child guidance when native recovery binds the last started parent", () => {
  const {store, run, message} = fixture();
  const parent = {...run, id: "started-parent", status: "stopped" as const, conversation_id: "native"};
  const continuation = {kind: "runtime_resume" as const, source_run_id: parent.id,
    purpose: "execute" as const, role: "executor" as const};
  const rejected = {...run, status: "failed" as const, conversation_id: "native", continuation};
  const retry = {...run, id: "retry", continuation};
  for (const r of [parent, rejected]) store.put("run", r.id, "w", r);
  expect(pendingRunMessages(store, "w", retry)).toEqual([]);
  store.event("w", "project", "AgyAccountAdmissionFailed", {code: "target_model_unavailable"}, rejected.id);
  expect(pendingRunMessages(store, "w", retry)).toEqual([message]);
  expect(pendingRunMessages(store, "w", {...retry, plan_revision: 2})).toEqual([]);
  expect(pendingRunMessages(store, "w", {...retry, purpose: "executor_test"})).toEqual([]);
  store.put("session_input", rejected.id, "w", {run_id: rejected.id, kind: "followup",
    message_ids: [message.message_id], state: "delivered"});
  expect(pendingRunMessages(store, "w", retry)).toEqual([]);
});

it("does not mistake a raw guidance reply for initialization of a new automatic role stage", () => {
  const {store, run, message} = fixture();
  const guided = {...run, purpose: "executor_test" as const, stage: "executor_test", conversation_id: "native"};
  store.put("run", guided.id, "w", guided);
  store.put("session_input", guided.id, "w", {run_id: guided.id, conversation_id: "native",
    stage_key: inputStageKey(guided), kind: "followup", state: "delivered", user_input: true, message_ids: [message.message_id]});
  const automatic = {...guided, id: "automatic", continuation: {kind: "runtime_resume" as const,
    source_run_id: guided.id, purpose: "execute" as const, role: "executor" as const}};
  expect(isSessionFollowup(store, automatic, "native", [])).toBe(false);
  const initialized = {...guided, id: "initial-stage"};
  store.put("run", initialized.id, "w", initialized);
  store.put("session_input", initialized.id, "w", {run_id: initialized.id, conversation_id: "native",
    stage_key: inputStageKey(initialized), kind: "stage_start", state: "delivered", message_ids: []});
  expect(isSessionFollowup(store, automatic, "native", [])).toBe(true);
});
