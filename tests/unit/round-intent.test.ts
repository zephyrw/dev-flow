import { describe, it, expect } from "vitest";
import {
  normalizeExecutionIntent,
  normalizeDeliveredRound,
  normalizeReviewIntent,
  applyContinuationMaterials,
  applyPlanningHandoffMaterials,
  selectConversationToResume,
  INTENT_CLARIFICATION_INSTRUCTION,
} from "../../packages/core/src/round-intent.js";
import type {
  PlanningHandoff,
  RunContinuation,
} from "../../packages/contracts/src/tr-handoff.js";

describe("执行与审查意图归一化", () => {
  it("识别完成、规划澄清、用户输入，未知状态不默认完成", () => {
    expect(normalizeExecutionIntent({ status: "completed" }).intent).toBe(
      "completed",
    );
    expect(normalizeExecutionIntent({ status: "need_planner" }).intent).toBe(
      "need_planner",
    );
    expect(normalizeExecutionIntent({ status: "need_user" }).intent).toBe(
      "need_user",
    );
    expect(normalizeExecutionIntent({ status: "weird" }).intent).toBe("unclear");
    expect(normalizeExecutionIntent("not-json").intent).toBe("unclear");
    expect(normalizeExecutionIntent({ summary: "稍后补充" }).intent).toBe(
      "unclear",
    );
  });
  it("外层求助或规划冲突优先于嵌套 delivery，附件仍可从内层补充", () => {
    const needUser = normalizeDeliveredRound({
      status: "need_user",
      delivery: { summary: "已完成部分实现" },
    });
    expect(needUser.intent).toBe("need_user");
    expect(needUser.summary).toBe("已完成部分实现");
    expect(
      normalizeDeliveredRound({
        status: "need_planner",
        delivery: {
          summary: "已完成部分实现",
          implementations: [{ path: "src/a.ts" }],
        },
      }).intent,
    ).toBe("need_planner");
  });
  it("空 implementations/test_executions 不能推断完成", () => {
    expect(
      normalizeDeliveredRound({
        implementations: [],
        test_executions: [],
      }).intent,
    ).toBe("unclear");
    expect(
      normalizeDeliveredRound({
        delivery: { implementations: [], test_executions: [] },
      }).intent,
    ).toBe("unclear");
    expect(
      normalizeDeliveredRound(
        { implementations: [], test_executions: [] },
        { deliverySubmit: true },
      ).intent,
    ).toBe("unclear");
  });
  it("无 status 的真实实现清单仅在交付提交入口视为完成", () => {
    const work = { implementations: [{ task_id: "T1", path: "src/a.ts" }] };
    expect(normalizeDeliveredRound(work).intent).toBe("unclear");
    expect(
      normalizeDeliveredRound(work, { deliverySubmit: true }).intent,
    ).toBe("completed");
    expect(
      normalizeDeliveredRound({
        status: "need_user",
        implementations: [{ task_id: "T1", path: "src/a.ts" }],
      }).intent,
    ).toBe("need_user");
    expect(
      normalizeDeliveredRound(
        {
          status: "need_user",
          implementations: [{ task_id: "T1", path: "src/a.ts" }],
        },
        { deliverySubmit: true },
      ).intent,
    ).toBe("need_user");
  });
  it("审查只有明确修改意图才算需要整改", () => {
    expect(normalizeReviewIntent({ verdict: "passed" }).intent).toBe("passed");
    expect(normalizeReviewIntent({ verdict: "pass" }).intent).toBe("passed");
    expect(normalizeReviewIntent({ verdict: "quality_pass" }).intent).toBe(
      "passed",
    );
    expect(normalizeReviewIntent({ status: "passed" }).intent).toBe("passed");
    expect(
      normalizeReviewIntent({ quality: { verdict: "passed" } }).intent,
    ).toBe("passed");
    expect(normalizeReviewIntent({ verdict: "changes_required" }).intent).toBe(
      "changes_required",
    );
    expect(normalizeReviewIntent({ verdict: "findings" }).intent).toBe(
      "changes_required",
    );
    expect(
      normalizeReviewIntent({
        verdict: "pass",
        findings: [
          {
            disposition: "confirmed",
            relation_to_change: "introduced",
          },
        ],
      }).intent,
    ).toBe("changes_required");
    expect(normalizeReviewIntent({ verdict: "need_user" }).intent).toBe(
      "need_user",
    );
    expect(
      normalizeReviewIntent({
        verdict: "passed",
        unresolved_questions: ["接口默认值选哪个？"],
      }).intent,
    ).toBe("need_user");
    expect(normalizeReviewIntent({ summary: "稍后补充结论" }).intent).toBe(
      "unclear",
    );
  });
  it("外层 unclear 独占意图，不读内层 completed", () => {
    const result = normalizeDeliveredRound({
      status: "unclear",
      delivery: { status: "completed", implementations: [{ path: "a.ts" }] },
    });
    expect(result.intent).toBe("unclear");
    expect(result.intent_source).toBe("outer");
    expect(result.provided_intent_field).toBe(true);
  });
  it("外层未知值不读内层完成", () => {
    const result = normalizeDeliveredRound({
      status: "weird",
      delivery: { status: "completed" },
    });
    expect(result.intent).toBe("unclear");
    expect(result.intent_source).toBe("outer");
    expect(result.status).toBe("weird");
  });
  it("deliverySubmit 不能把显式 unclear 提升为 completed", () => {
    expect(
      normalizeDeliveredRound(
        {
          status: "unclear",
          implementations: [{ task_id: "T1", path: "src/a.ts" }],
        },
        { deliverySubmit: true },
      ),
    ).toMatchObject({ intent: "unclear", intent_source: "outer" });
    expect(
      normalizeDeliveredRound(
        {
          status: "unknown-status",
          implementations: [{ task_id: "T1", path: "src/a.ts" }],
        },
        { deliverySubmit: true },
      ).intent,
    ).toBe("unclear");
  });
  it("无显式意图且非空 implementations 仅在 deliverySubmit 时视为完成", () => {
    const work = { implementations: [{ task_id: "T1", path: "src/a.ts" }] };
    expect(normalizeDeliveredRound(work)).toMatchObject({
      intent: "unclear",
      intent_source: "missing",
      provided_intent_field: false,
    });
    expect(
      normalizeDeliveredRound(work, { deliverySubmit: true }),
    ).toMatchObject({
      intent: "completed",
      intent_source: "legacy_submit",
    });
  });
  it("空数组在 deliverySubmit 时仍不推断完成", () => {
    expect(
      normalizeDeliveredRound(
        { implementations: [], test_executions: [] },
        { deliverySubmit: true },
      ),
    ).toMatchObject({ intent: "unclear", intent_source: "missing" });
  });
  it("外层 completed 与求助各自保持语义，附件不改意图", () => {
    expect(
      normalizeDeliveredRound({
        status: "completed",
        delivery: { status: "need_user" },
      }),
    ).toMatchObject({ intent: "completed", intent_source: "outer" });
    expect(normalizeExecutionIntent({ status: "need_user" }).intent_source).toBe(
      "outer",
    );
    expect(
      normalizeExecutionIntent({
        delivery: { status: "need_planner", summary: "设计冲突" },
      }),
    ).toMatchObject({
      intent: "need_planner",
      intent_source: "nested",
      summary: "设计冲突",
    });
  });
  it("不明意图续接只发送补问指令和原文，不附带完整开发任务", () => {
    const continuation: RunContinuation = {
      kind: "intent_clarification",
      source_run_id: "run-1",
      purpose: "execute",
      role: "executor",
      conversation_id: "conv-1",
      original_text: "本轮已改完一半",
    };
    const materials = applyContinuationMaterials(
      {
        instructions: "严格按原始正式计划完成全部开发任务及测试代码",
        execution_order: ["开发", "测试"],
        plan: { title: "正式计划" },
        completion_instruction: "完成后交代码审查",
      },
      continuation,
    );
    expect(materials.instructions).toBe(INTENT_CLARIFICATION_INSTRUCTION);
    expect(materials.original_text).toBe("本轮已改完一半");
    expect(materials).not.toHaveProperty("execution_order");
    expect(materials).not.toHaveProperty("plan");
    expect(String(materials.instructions)).not.toContain("全部开发");
  });
  it("用户回答与原问题一起进入原执行上下文", () => {
    const continuation: RunContinuation = {
      kind: "user_answer",
      source_run_id: "run-1",
      purpose: "review",
      role: "planner",
      conversation_id: "rev-1",
      questions: ["接口默认值选哪个？"],
      answer: "使用 API_BASE",
    };
    const materials = applyContinuationMaterials(
      {
        instructions: "完整审查代码质量",
        plan: { title: "正式计划" },
      },
      continuation,
    );
    expect(materials.instructions).toBe("完整审查代码质量");
    expect(materials.questions).toEqual(["接口默认值选哪个？"]);
    expect(materials.answer).toBe("使用 API_BASE");
    expect(materials.plan).toEqual({ title: "正式计划" });
  });
  it("规划交接把求助正文和源执行背景加入规划输入", () => {
    const handoff: PlanningHandoff = {
      handoff_id: "h1",
      source_run_id: "exec-1",
      source_role: "executor",
      source_conversation_id: "exec-session",
      plan_revision: 2,
      original_text: "模块边界和计划不一致",
      summary: "需要澄清模块拆分",
      notes: "现有接口不能删",
      questions: ["B 模块是否独立？"],
      target_role: "planner",
      status: "pending",
    };
    const materials = applyPlanningHandoffMaterials(
      {
        instructions: "你是规划模型",
        current_plan: { revision: 2 },
      },
      handoff,
    );
    expect(materials.original_text).toBe("模块边界和计划不一致");
    expect(materials.summary).toBe("需要澄清模块拆分");
    expect(materials.notes).toBe("现有接口不能删");
    expect(materials.questions).toEqual(["B 模块是否独立？"]);
    expect(materials.current_plan).toEqual({ revision: 2 });
    expect(materials.source_execution).toMatchObject({
      run_id: "exec-1",
      conversation_id: "exec-session",
    });
  });
  it("规划续接只用规划会话，独立审查无 continuation 时开新会话", () => {
    expect(
      selectConversationToResume({
        purpose: "planning",
        continuation: { conversation_id: "exec-session" },
        planningSession: { id: "plan-session" },
        defaultSession: { id: "exec-session" },
      }),
    ).toEqual({ id: "plan-session" });
    expect(
      selectConversationToResume({
        purpose: "quality_review",
        defaultSession: { id: "old-review" },
      }),
    ).toBeUndefined();
    expect(
      selectConversationToResume({
        purpose: "quality_review",
        continuation: { conversation_id: "review-session" },
      }),
    ).toEqual({ id: "review-session" });
    expect(
      selectConversationToResume({
        purpose: "implement",
        defaultSession: { id: "exec-session" },
      }),
    ).toEqual({ id: "exec-session" });
  });
});
