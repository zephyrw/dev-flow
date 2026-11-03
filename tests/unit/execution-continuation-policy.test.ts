import { describe, expect, it } from "vitest";
import { normalizeDeliveredRound } from "../../packages/core/src/round-intent.js";
import { extractRoundOutput } from "../../packages/runtime/src/round-output.js";
import {
  executionContinuationDecision,
  executionProgressItems,
  hasExecutionUserRequest,
} from "../../packages/core/src/execution-continuation-policy.js";

const decide = (value: unknown) => executionContinuationDecision(normalizeDeliveredRound(value));

describe("execution continuation policy", () => {
  it("recognizes a partial result without treating it as completion", () => {
    const value = { status: "incomplete", completed_items: ["T01"], unfinished_items: ["T02"] };
    expect(normalizeDeliveredRound(value).intent).toBe("incomplete");
    expect(decide(value)).toBe("continue");
    expect(decide({ delivery: value })).toBe("continue");
    const extracted = extractRoundOutput({ kind: "execution", replyText: JSON.stringify(value) });
    expect(extracted).toMatchObject({ kind: "resolved", value });
  });

  it("clarifies a summary or an unspecified request without assuming work can continue", () => {
    expect(decide({ summary: "完成第一部分" })).toBe("clarify");
    expect(decide({ status: "need_user", summary: "执行进展报告", notes: "完成前两个章节" })).toBe("clarify");
    expect(decide({ status: "need_user", user_interaction: { broken: true } })).toBe("clarify");
    expect(decide({ status: "unknown-status" })).toBe("clarify");
  });

  it.each([
    { kind: "action_required", title: "登录测试账号", message: "请在测试页面登录后继续", target: { url: "http://localhost/login" } },
    { kind: "question", title: "选择保留方案", message: "两种方案行为不同", question: "保留哪个行为？" },
    { kind: "question", question: "是否允许删除数据？", choices: "malformed" },
    { kind: "action_required", message: "请批准实际工具权限请求", target: "malformed" },
  ])("preserves a concrete user request even if optional fields are malformed: %j", user_interaction => {
    const value = { status: "need_user", user_interaction };
    expect(hasExecutionUserRequest(value)).toBe(true);
    expect(decide(value)).toBeUndefined();
    expect(decide({ status: "incomplete", user_interaction })).toBeUndefined();
    expect(decide({ delivery: value })).toBeUndefined();
  });

  it("preserves explicit questions in either result envelope", () => {
    expect(decide({ status: "need_user", unresolved_questions: ["请确认业务默认值"] })).toBeUndefined();
    expect(decide({ status: "incomplete", delivery: { unresolved_questions: ["是否授权此操作？"] } })).toBeUndefined();
    expect(decide({ status: "need_user", unresolved_questions: [null, " "] })).toBe("clarify");
  });

  it("preserves a concrete request when a completion claim explicitly leaves work unfinished", () => {
    const user_interaction = { kind: "question", title: "确认操作", message: "需要用户决定", question: "是否允许该操作？" };
    expect(decide({ status: "completed", unfinished_items: ["T02"], user_interaction })).toBeUndefined();
    expect(decide({ status: "completed", delivery: { unfinished_items: ["T02"], user_interaction } })).toBeUndefined();
    expect(decide({ status: "completed", unfinished_items: ["T02"], unresolved_questions: ["是否继续？"] })).toBeUndefined();
  });

  it("keeps normal completion and planner handoff, but checks unfinished completion claims", () => {
    expect(decide({ status: "completed", unfinished_items: [] })).toBeUndefined();
    expect(decide({ status: "need_planner", summary: "需要调整接口设计" })).toBeUndefined();
    expect(decide({ status: "completed", unfinished_items: ["T02"] })).toBe("clarify");
    expect(decide({ status: "completed", delivery: { unfinished_items: [{ id: "T02" }] } })).toBe("clarify");
    // Existing completed results may carry an old interaction from conversation history.
    expect(decide({ status: "completed", user_interaction: {
      kind: "question", title: "旧问题", message: "已处理", question: "旧问题？",
    } })).toBeUndefined();
  });

  it("does not auto-route conflicting states, including direct submissions without parser metadata", () => {
    expect(decide({ status: "completed", delivery: { status: "need_user" } })).toBeUndefined();
    expect(decide({ status: "incomplete", verdict: "completed" })).toBeUndefined();
    expect(decide({ status: "unknown", delivery: { status: "completed" } })).toBeUndefined();
    const result = normalizeDeliveredRound({ status: "unclear", summary: "冲突原文" });
    expect(executionContinuationDecision(result, { kind: "ambiguous", reason: "状态冲突" })).toBeUndefined();
    expect(executionContinuationDecision(result, { kind: "ambiguous", reason: "run_id 不匹配" })).toBeUndefined();
  });

  it("uses stable completed identifiers across outer/nested results without counting prose changes", () => {
    expect(executionProgressItems({ completed_items: ["T02", { id: "T01", summary: "新说明" }, null, " ", { task_id: "T03" }],
      delivery: { completed_items: ["T02", { id: "T04" }, { summary: "完成工作" }] } }))
      .toEqual(["T01", "T02", "T03", "T04"]);
    expect(executionProgressItems({ summary: "修改了摘要", completed_items: "T01", delivery: [] })).toEqual([]);
  });
});
