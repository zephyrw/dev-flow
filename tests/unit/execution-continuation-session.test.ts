import { afterEach, expect, it } from "vitest";
import { Store } from "../../packages/store/src/store.js";
import { ExecutorRoundOutputSchema, type Run, type Workflow } from "../../packages/contracts/src/index.js";
import type { RunContinuation } from "../../packages/contracts/src/tr-handoff.js";
import { applyContinuationMaterials, asRunContinuation, continuationSessionRequired } from "../../packages/core/src/round-intent.js";
import { currentContinuation } from "../../packages/core/src/waiting-context.js";
import { followupText, isSessionFollowup, runUserInputText } from "../../packages/core/src/session-input.js";
import { EXECUTION_CLARIFY_INSTRUCTION, EXECUTION_CONTINUE_INSTRUCTION } from "../../packages/core/src/execution-continuation-policy.js";
import { readableLogs, userFacingLogs } from "../../packages/presentation/src/activity.js";

const stores: Store[] = [];
afterEach(() => stores.splice(0).forEach(store => store.close()));
function fixture(kind: "execution_continue" | "execution_check") {
  const store = new Store(":memory:"); stores.push(store);
  const source: Run = { id: "source", workflow_id: "wf", plan_revision: 1, purpose: "implement", adapter: "agy",
    status: "completed", exit_code: 0, stage: "execute", started_at: "2026-11-03T00:00:00Z", package_hash: "pkg" };
  const continuation: RunContinuation = { kind, source_run_id: source.id, purpose: "execute", role: "executor",
    original_text: "已完成 T01，T02 尚未完成", answer: kind === "execution_check" ? EXECUTION_CLARIFY_INSTRUCTION : EXECUTION_CONTINUE_INSTRUCTION };
  const run: Run = { ...source, id: "next", status: "running", exit_code: undefined, continuation };
  store.put("run", source.id, "wf", source);
  store.put("workflow", "wf", "project", { id: "wf", run_id: source.id, state: "QUEUED", plan_revision: 1 } as Workflow);
  store.put("execution_auto_continuation", source.id, "wf", { workflow_id: "wf", source_run_id: source.id,
    mode: kind === "execution_check" ? "clarify" : "continue" });
  return { store, source, run, continuation };
}

it.each(["execution_continue", "execution_check"] as const)("sends %s as system continuation without inventing a user answer", kind => {
  const { store, run, continuation } = fixture(kind);
  expect(asRunContinuation(continuation)).toEqual(continuation);
  expect(continuationSessionRequired("implement", continuation)).toBe(true);
  expect(isSessionFollowup(store, run, "original-native-session", [])).toBe(true);
  expect(followupText(store, run, [])).toBe(continuation.answer);
  expect(runUserInputText(store, run, [])).toBeUndefined();
  const userMessage = { text: "先暂停并回答问题" };
  expect(followupText(store, run, [userMessage])).toBe(userMessage.text);
  expect(runUserInputText(store, run, [userMessage])).toBe(userMessage.text);
});

it("keeps automatic clarification limited to the previous result", () => {
  const { continuation } = fixture("execution_check");
  const result = applyContinuationMaterials({ instructions: "开发全部任务", plan: { title: "原计划" }, execution_order: ["开发", "测试"] }, continuation);
  expect(result).toMatchObject({ instructions: EXECUTION_CLARIFY_INSTRUCTION, original_text: continuation.original_text });
  expect(result).not.toHaveProperty("plan");
  expect(result).not.toHaveProperty("execution_order");
  expect(result).not.toHaveProperty("answer");
});

it("does not recreate a native session for automatic continuation when its original session is unavailable", () => {
  const { store, run, source } = fixture("execution_continue");
  store.put("run", source.id, "wf", { ...source, conversation_id: "original-native-session" });
  expect(() => isSessionFollowup(store, run, undefined, [])).toThrow("原会话不可恢复");
});

it.each(["execution_continue", "execution_check"] as const)("admits ended %s sources only with their own persisted receipt", kind => {
  const { store, source, continuation } = fixture(kind);
  expect(currentContinuation(store, "wf", continuation)).toEqual(continuation);
  store.put("execution_auto_continuation", source.id, "wf", { workflow_id: "other", source_run_id: source.id,
    mode: kind === "execution_check" ? "clarify" : "continue" });
  expect(currentContinuation(store, "wf", continuation)).toBeUndefined();
  store.remove("execution_auto_continuation", source.id);
  expect(currentContinuation(store, "wf", continuation)).toBeUndefined();
});

it.each(["run_stop", "execution_completion", "run_continuation_superseded"])("never revives an automatic continuation after %s", entity => {
  const { store, source, continuation } = fixture("execution_continue");
  store.put(entity, source.id, "wf", { workflow_id: "wf", run_id: source.id });
  expect(currentContinuation(store, "wf", continuation)).toBeUndefined();
});

it("accepts incomplete output and original-plan progress in the provider generation schema", () => {
  expect(ExecutorRoundOutputSchema.parse({ status: "incomplete", completed_items: ["T01"],
    unfinished_items: [{ id: "T02", reason: "下一批继续" }] })).toMatchObject({ status: "incomplete", completed_items: ["T01"] });
});

it("shows automatic continuation as workflow activity without a user speaker or interaction", () => {
  const events = [
    { mode: "continue", message: "本轮完成了部分任务，正在继续剩余任务。" },
    { mode: "clarify", message: "正在核对剩余任务和停止原因。" },
  ].map((payload, i) => ({ workflow_id: "wf", run_id: "source", event_seq: i + 1,
    created_at: "2026-11-03T00:00:00Z", type: "ExecutionContinuationScheduled", payload }));
  const logs = userFacingLogs(readableLogs(events, "wf"));
  expect(logs.map(row => row.title)).toEqual(["正在继续剩余任务", "正在核对剩余任务和停止原因"]);
  expect(logs.map(row => row.text)).toEqual(events.map(event => event.payload.message));
  expect(logs.every(row => row.speaker !== "user" && !row.interactionId)).toBe(true);
});
