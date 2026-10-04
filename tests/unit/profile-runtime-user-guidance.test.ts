import { afterEach, expect, it, vi } from "vitest";
import { Store } from "../../packages/store/src/store.js";
import type { FeedbackMessage, Run } from "../../packages/contracts/src/index.js";
import {
  currentRunUserGuidance,
  invokePrompt,
  ProfileRuntime,
} from "../../packages/runtime/src/profile-runtime.js";

const stores: Store[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.close()));

function fixture() {
  const store = new Store(":memory:");
  stores.push(store);
  const put = (seq: number, text: string, extra: Partial<FeedbackMessage> = {}) => {
    const message: FeedbackMessage = {
      message_id: `feedback-${seq}`,
      client_request_id: `request-${seq}`,
      workflow_id: "workflow",
      seq,
      kind: "execution",
      text,
      refs: [],
      attachment_ids: [],
      target_document_revision: 0,
      status: "acknowledged",
      ack_run: "current-run",
      created_at: "2026-09-28T07:57:26.000Z",
      ...extra,
    };
    store.put("feedback_message", message.message_id, "workflow", message);
    return message;
  };
  return { store, put };
}

it("selects only feedback assigned to this run, in message order, preserving references without changing acknowledgement", () => {
  const { store, put } = fixture();
  put(1, "旧建议刷新 Token", { ack_run: "previous-run" });
  const latest = put(4, "Token 已是最新，不要刷新", {
    refs: [{ ref_id: "file-ref", repo_id: "backend", relative_path: "src/Test.java", kind: "file", availability: "available" }],
    attachment_ids: ["attachment"],
  });
  put(3, "继续已有任务");
  put(5, "尚未分配的下一条指导", { status: "pending", ack_run: undefined });
  put(6, "其他工作流", { workflow_id: "other-workflow" });

  const guidance = currentRunUserGuidance(store, "workflow", { id: "current-run", purpose: "implement" });

  expect(guidance?.messages.map((message) => message.seq)).toEqual([3, 4]);
  expect(guidance?.messages[1]).toMatchObject({ text: latest.text, refs: latest.refs, attachment_ids: latest.attachment_ids });
  expect(guidance).not.toHaveProperty("instruction");
  expect(store.get("feedback_message", latest.message_id)).toEqual(latest);
  expect(currentRunUserGuidance(store, "workflow", { id: "next-run", purpose: "implement" })).toBeUndefined();
});

it.each(["planning", "quality_review", "implement"] as Run["purpose"][])(
  "sends only exact user guidance in the real %s follow-up prompt",
  (purpose) => {
    const { store, put } = fixture();
    put(1, "这个 Token 就是最新的，你不要去刷新 Token");
    const guidance = currentRunUserGuidance(store, "workflow", { id: "current-run", purpose });
    const prompt = invokePrompt(purpose!, "HANDOFF.json", "schema.json", {
      kind: "user_answer", source_run_id: "old-run", purpose: "execute", role: "executor", answer: "旧建议刷新 Token",
    }, "沿用原角色继续", guidance);

    expect(prompt).toBe("这个 Token 就是最新的，你不要去刷新 Token");
  },
);

it("does not inject formal guidance into aside even if a caller supplies it", () => {
  const { store, put } = fixture();
  put(1, "主任务指导");
  const guidance = currentRunUserGuidance(store, "workflow", { id: "current-run", purpose: "implement" });
  expect(currentRunUserGuidance(store, "workflow", { id: "current-run", purpose: "aside" })).toBeUndefined();
  expect(invokePrompt("aside", "HANDOFF.json", "schema.json", undefined, undefined, guidance))
    .toBe(invokePrompt("aside", "HANDOFF.json", "schema.json"));
});

it("keeps the existing prompt unchanged when this run has no newly assigned feedback", () => {
  const { store, put } = fixture();
  put(1, "已经在上一轮送达的指导", { ack_run: "previous-run" });
  const guidance = currentRunUserGuidance(store, "workflow", { id: "current-run", purpose: "implement" });
  expect(guidance).toBeUndefined();
  expect(invokePrompt("implement", "HANDOFF.json", "schema.json", undefined, undefined, guidance))
    .toBe(invokePrompt("implement", "HANDOFF.json", "schema.json"));
});

function resumedRun(id: string, sourceId?: string, extra: Partial<Run> = {}): Run {
  return { id, workflow_id: "workflow", plan_revision: 1, adapter: "agy", purpose: "functional_fix",
    stage: "functional_fix", status: "stopped", started_at: "2026-09-29T02:17:11.000Z", package_hash: "package",
    conversation_id: "original-session", invocation_fingerprint: "identity",
    ...(sourceId ? { continuation: { kind: "runtime_resume" as const, source_run_id: sourceId, purpose: "execute" as const,
      role: "executor" as const, conversation_id: "original-session" } } : {}), ...extra };
}

it("does not replay old native-session guidance through repeated pauses", () => {
  const { store, put } = fixture();
  const source = resumedRun("source"), paused = resumedRun("paused", source.id), current = resumedRun("current-run", paused.id);
  paused.continuation!.conversation_id = "cnv-source-projection";
  current.continuation!.conversation_id = "cnv-paused-projection";
  for (const run of [source, paused, current]) store.put("run", run.id, "workflow", run);
  const original = put(1, "启动前后端。先回答有没有做过 OpenTabs 验收？", { ack_run: source.id });
  put(2, "端口独立且保留服务", { ack_run: paused.id });
  put(3, "逐项回答");
  put(1, original.text, { message_id: "duplicate-record", ack_run: source.id });
  put(4, "无关历史", { ack_run: "unrelated" });
  const result = currentRunUserGuidance(store, "workflow", current);
  expect(result?.messages.map(m => m.seq)).toEqual([3]);
  expect(invokePrompt("functional_fix", "HANDOFF.json", "schema.json", undefined, undefined, result)).toBe("逐项回答");
  expect(store.get("feedback_message", original.message_id)).toEqual(original);
});

it.each(["completed", "completion_record", "aside", "workflow", "plan", "role", "user_answer"])(
  "does not replay guidance across a %s boundary", boundary => {
    const { store, put } = fixture();
    const source = resumedRun("source"), current = resumedRun("current-run", source.id);
    if (boundary === "completed") source.status = "completed";
    if (boundary === "completion_record") store.put("execution_completion", source.id, "workflow", { intent: "completed" });
    if (boundary === "aside") source.purpose = "aside";
    if (boundary === "workflow") source.workflow_id = "other";
    if (boundary === "plan") source.plan_revision = 2;
    if (boundary === "role") source.routing_role = "planner";
    if (boundary === "user_answer") current.continuation!.kind = "user_answer";
    for (const run of [source, current]) store.put("run", run.id, run.workflow_id, run);
    put(1, "旧指导", { ack_run: source.id });
    expect(currentRunUserGuidance(store, "workflow", current)).toBeUndefined();
    expect(currentRunUserGuidance(store, "workflow", { ...current, purpose: "aside" })).toBeUndefined();
  },
);

it("does not silently replay delivered guidance when a model or account binding changes", () => {
  const { store, put } = fixture();
  const source = resumedRun("source"), current = resumedRun("current-run", source.id, {
    adapter: "codex", conversation_id: "new-native-session", invocation_fingerprint: "new-account-and-model",
  });
  for (const run of [source, current]) store.put("run", run.id, "workflow", run);
  put(1, "请先回答 OpenTabs 是否做过，再启动服务", { ack_run: source.id });
  expect(currentRunUserGuidance(store, "workflow", current)).toBeUndefined();
});

it.each(["executor_test", "planner_commit"] as const)("retains native %s context without replaying guidance", purpose => {
  const { store, put } = fixture();
  const role = purpose === "planner_commit" ? "planner" : "executor";
  const source = resumedRun("source", undefined, { purpose, routing_role: role });
  const current = resumedRun("current-run", source.id, { purpose, routing_role: role });
  current.continuation!.role = role;
  for (const run of [source, current]) store.put("run", run.id, "workflow", run);
  put(1, "保留已有结果，按这条原文继续当前工作", { ack_run: source.id });
  expect(currentRunUserGuidance(store, "workflow", current)).toBeUndefined();
  store.put("run", source.id, "workflow", { ...source, purpose: "implement" });
  expect(currentRunUserGuidance(store, "workflow", current)).toBeUndefined();
  store.put("run", source.id, "workflow", { ...source, routing_role: role === "planner" ? "executor" : "planner" });
  expect(currentRunUserGuidance(store, "workflow", current)).toBeUndefined();
});

it("stops before an intermediate completed resume so older already-handled guidance is not replayed", () => {
  const { store, put } = fixture();
  const source = resumedRun("source"), completed = resumedRun("completed-resume", source.id, { status: "completed" });
  const current = resumedRun("current-run", completed.id);
  for (const run of [source, completed, current]) store.put("run", run.id, "workflow", run);
  put(1, "此前已落实", { ack_run: source.id });
  put(2, "只保留新的指导");
  expect(currentRunUserGuidance(store, "workflow", current)?.messages.map(m => m.seq)).toEqual([2]);
});

it("records a plain successful guidance reply without asking the model to invent task completion fields", async () => {
  const {store} = fixture();
  const run = resumedRun("current-run", undefined, {purpose: "executor_test", status: "running"});
  store.put("run", run.id, "workflow", run);
  store.put("session_input", run.id, "workflow", {run_id: run.id, user_input: true, state: "delivered",
    kind: "followup", message_ids: ["message"]});
  const workflow = {id: "workflow", run_id: run.id, state: "EXECUTING", plan_revision: 1, plan_hash: "approved"};
  const receiveRoundResult = vi.fn();
  const runtime = new ProfileRuntime({store, get: () => workflow, receiveRoundResult} as any, {} as any);
  (runtime as any).invoke = vi.fn(async () => ({summary: "刚才模型核验超时，已有工作已保留。"}));
  await runtime.execute(workflow as any, run, "token");
  expect(receiveRoundResult).toHaveBeenCalledWith("workflow", run.id, expect.objectContaining({
    status: "completed", summary: "刚才模型核验超时，已有工作已保留。"}));
});
