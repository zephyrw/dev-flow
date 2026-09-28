import { afterEach, expect, it } from "vitest";
import { Store } from "../../packages/store/src/store.js";
import type { FeedbackMessage, Run } from "../../packages/contracts/src/index.js";
import {
  currentRunUserGuidance,
  invokePrompt,
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
  expect(guidance?.instruction).toContain("送达不代表你已执行或遵从");
  expect(store.get("feedback_message", latest.message_id)).toEqual(latest);
  expect(currentRunUserGuidance(store, "workflow", { id: "next-run", purpose: "implement" })).toBeUndefined();
});

it.each(["planning", "quality_review", "implement"] as Run["purpose"][])(
  "places new user guidance first in the real %s prompt while retaining role and final-output boundaries",
  (purpose) => {
    const { store, put } = fixture();
    put(1, "这个 Token 就是最新的，你不要去刷新 Token");
    const guidance = currentRunUserGuidance(store, "workflow", { id: "current-run", purpose });
    const prompt = invokePrompt(purpose!, "HANDOFF.json", "schema.json", {
      kind: "user_answer", source_run_id: "old-run", purpose: "execute", role: "executor", answer: "旧建议刷新 Token",
    }, "沿用原角色继续", guidance);

    expect(prompt.startsWith("本轮用户指导")).toBe(true);
    expect(prompt).toContain("这个 Token 就是最新的，你不要去刷新 Token");
    expect(prompt).toContain("先用简短公开进度回复");
    expect(prompt).toContain("已完成且未受影响的工作不重做");
    expect(prompt).toContain("指导不自动改变角色或扩大授权");
    expect(prompt).toContain("schema.json");
    expect(prompt).toContain("沿用原角色继续");
    if (purpose === "quality_review") expect(prompt).toContain("不要求遍历测试报告");
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
