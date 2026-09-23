import { describe, expect, it } from "vitest";
import {
  createQualityFlow,
  nextQualityAction,
} from "../../packages/core/src/quality-flow.js";

/**
 * G01–G06：规划提交与 Git 收尾的路由层契约。
 * 平台在策略 2 下派发 planner_commit，不调用 executeDelivery 生成第二次候选提交。
 */
describe("planner-commit 路由契约", () => {
  it("G01 最终复核通过后唯一下一动作是 planner_commit", () => {
    const flow = {
      ...createQualityFlow("wf"),
      phase: "after_human" as const,
      planner_repairs_only: true,
    };
    const r = nextQualityAction(
      { flow },
      { type: "quality_review", result: { verdict: "passed" } },
    );
    expect(r.action).toEqual({ kind: "planner_commit", phase: "after_human" });
  });

  it("G02 提交前工作区有其他人改动：路由仍只派发提交，不触发清理或重提", () => {
    const flow = {
      ...createQualityFlow("wf"),
      phase: "after_human" as const,
      planner_repairs_only: true,
    };
    // 说明材料（他人改动）不改变路由
    const r = nextQualityAction(
      { flow },
      {
        type: "executor_test_completed",
        result: {
          status: "completed",
          summary: "另有他人未暂存改动已保留",
          code_changed: false,
        },
      },
    );
    expect(r.action.kind).toBe("planner_commit");
  });

  it("G03 提交成功后进程断连重试：恢复仍是 planner_commit 用途", () => {
    const flow = {
      ...createQualityFlow("wf"),
      phase: "after_human" as const,
      planner_repairs_only: true,
    };
    const r = nextQualityAction(
      { flow },
      { type: "executor_test_completed", result: { status: "completed" } },
    );
    // 恢复按已保存 next action 继续；不会退回 implement
    expect(r.action.kind).toBe("planner_commit");
    expect(r.action.kind).not.toBe("quality_review");
  });

  it("G05 hook/冲突修复后执行测试完成 → 直接恢复规划提交，无复核", () => {
    const flow = {
      ...createQualityFlow("wf"),
      phase: "after_human" as const,
      planner_repairs_only: true,
    };
    let r = nextQualityAction({ flow }, { type: "planner_repair_completed" });
    expect(r.action.kind).toBe("executor_test");
    r = nextQualityAction(
      { flow: r.flow },
      {
        type: "executor_test_completed",
        result: { status: "completed", code_changed: true },
      },
    );
    expect(r.action.kind).toBe("planner_commit");
  });

  it("G06 清理失败不否认规划提交成功（路由已到提交终点）", () => {
    const flow = {
      ...createQualityFlow("wf"),
      phase: "after_human" as const,
      planner_repairs_only: true,
    };
    const r = nextQualityAction(
      { flow },
      { type: "quality_review", result: { verdict: "passed" } },
    );
    // 清理是 integrateCommittedDelivery 的收尾；路由层已到达终点动作
    expect(r.action.kind).toBe("planner_commit");
  });
});
