import { describe, expect, it } from "vitest";
import {
  createQualityFlow,
  nextQualityAction,
  usesQualityPolicyV2,
  type QualityFlowContext,
} from "../../packages/core/src/quality-flow.js";

function ctx(overrides: Partial<QualityFlowContext> = {}): QualityFlowContext {
  return {
    flow: createQualityFlow("wf1"),
    ...overrides,
  };
}

describe("quality-flow 策略 2 路由", () => {
  it("F01 开发、两次必要质量复核、人工均通过 → 直接规划提交", () => {
    let c = ctx();
    let r = nextQualityAction(c, { type: "implement_completed" });
    expect(r.action).toEqual({ kind: "quality_review", phase: "before_human" });
    c = { flow: r.flow };
    r = nextQualityAction(c, {
      type: "quality_review",
      result: { verdict: "passed" },
    });
    expect(r.action).toEqual({ kind: "human", phase: "before_human" });
    // 人工通过 → after_human 最终复核
    c = { flow: r.flow };
    r = nextQualityAction(c, { type: "human_functional_passed" });
    expect(r.flow.phase).toBe("after_human");
    expect(r.action).toEqual({ kind: "quality_review", phase: "after_human" });
    c = { flow: r.flow };
    r = nextQualityAction(c, {
      type: "quality_review",
      result: { verdict: "passed" },
    });
    expect(r.action).toEqual({ kind: "planner_commit", phase: "after_human" });
  });

  it("F02 首次质量问题，执行整改后复核通过 → 恰好一次执行质量整改", () => {
    let c = ctx();
    let r = nextQualityAction(c, { type: "implement_completed" });
    c = { flow: r.flow };
    r = nextQualityAction(c, {
      type: "quality_review",
      result: { verdict: "changes_required" },
    });
    expect(r.action).toEqual({ kind: "executor_repair", phase: "before_human" });
    c = { flow: r.flow };
    r = nextQualityAction(c, {
      type: "implement_completed",
      is_quality_repair: true,
    });
    expect(r.flow.executor_repair_completed).toBe(true);
    expect(r.action).toEqual({ kind: "quality_review", phase: "before_human" });
    c = { flow: r.flow };
    r = nextQualityAction(c, {
      type: "quality_review",
      result: { verdict: "passed" },
    });
    expect(r.action).toEqual({ kind: "human", phase: "before_human" });
  });

  it("F03 执行整改后第二次复核仍有问题 → 立即规划修复，无第二轮执行整改", () => {
    let c = ctx({
      flow: {
        ...createQualityFlow("wf1"),
        executor_repair_completed: true,
      },
    });
    const r = nextQualityAction(c, {
      type: "quality_review",
      result: { verdict: "changes_required" },
    });
    expect(r.flow.planner_repairs_only).toBe(true);
    expect(r.action).toEqual({ kind: "planner_repair", phase: "before_human" });
  });

  it("F04 第一次质量复核就通过 → 不设置假计数", () => {
    const r = nextQualityAction(ctx(), {
      type: "quality_review",
      result: { verdict: "passed" },
    });
    expect(r.flow.executor_repair_completed).toBe(false);
    expect(r.flow.planner_repairs_only).toBe(false);
    expect(r.action.kind).toBe("human");
  });

  it("F05 人工后第一次质量复核有问题 → 直接规划修复", () => {
    let c = ctx();
    let r = nextQualityAction(c, { type: "human_functional_passed" });
    c = { flow: r.flow };
    r = nextQualityAction(c, {
      type: "quality_review",
      result: { verdict: "changes_required" },
    });
    expect(r.flow.planner_repairs_only).toBe(true);
    expect(r.action).toEqual({ kind: "planner_repair", phase: "after_human" });
  });

  it("F06 规划修复完成 → executor_test", () => {
    let c = ctx({
      flow: { ...createQualityFlow("wf1"), planner_repairs_only: true },
    });
    const r = nextQualityAction(c, { type: "planner_repair_completed" });
    expect(r.action).toEqual({ kind: "executor_test", phase: "before_human" });
  });

  it("F07/F08 执行测试完成 → 人工前直接人工；不追加复核", () => {
    let c = ctx({
      flow: { ...createQualityFlow("wf1"), planner_repairs_only: true },
    });
    let r = nextQualityAction(c, { type: "planner_repair_completed" });
    c = { flow: r.flow };
    r = nextQualityAction(c, {
      type: "executor_test_completed",
      result: {
        status: "completed",
        code_changed: true,
        function_impact: "changed",
      },
    });
    expect(r.action).toEqual({ kind: "human", phase: "before_human" });
    expect(r.action.kind).not.toBe("quality_review");
  });

  it("F11 最终质量修复后的执行测试 → 直接 planner_commit", () => {
    let c = ctx({
      flow: {
        ...createQualityFlow("wf1"),
        phase: "after_human",
        planner_repairs_only: true,
      },
    });
    let r = nextQualityAction(c, { type: "planner_repair_completed" });
    c = { flow: r.flow };
    r = nextQualityAction(c, {
      type: "executor_test_completed",
      result: { status: "completed", code_changed: true },
    });
    expect(r.action).toEqual({ kind: "planner_commit", phase: "after_human" });
  });

  it("F12 历史 code_changed/function_impact 字段不改变路由", () => {
    const withFields = nextQualityAction(
      ctx({
        flow: {
          ...createQualityFlow("wf1"),
          phase: "after_human",
          planner_repairs_only: true,
        },
      }),
      {
        type: "executor_test_completed",
        result: {
          status: "completed",
          code_changed: true,
          function_impact: "uncertain",
        },
      },
    );
    const withoutFields = nextQualityAction(
      ctx({
        flow: {
          ...createQualityFlow("wf1"),
          phase: "after_human",
          planner_repairs_only: true,
        },
      }),
      { type: "executor_test_completed", result: { status: "completed" } },
    );
    expect(withFields.action).toEqual(withoutFields.action);
  });

  it("F10 人工反馈功能问题 → 执行修复", () => {
    const r = nextQualityAction(ctx(), { type: "human_functional_feedback" });
    expect(r.action).toEqual({ kind: "functional_fix", phase: "before_human" });
  });

  it("need_user 保留原用途等待", () => {
    const r = nextQualityAction(ctx(), {
      type: "quality_review",
      result: { verdict: "need_user" },
    });
    expect(r.action.kind).toBe("wait");
  });

  it("usesQualityPolicyV2 识别策略版本", () => {
    expect(usesQualityPolicyV2(2)).toBe(true);
    expect(usesQualityPolicyV2(1)).toBe(false);
    expect(usesQualityPolicyV2(undefined)).toBe(false);
  });
});
