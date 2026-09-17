import { describe, it, expect, afterEach } from "vitest";
import { setup } from "../helpers.js";
import { QualityCoordinator } from "../../packages/core/src/quality-coordinator.js";
import { QualityReviewResultSchema } from "../../packages/contracts/src/quality.js";
import { now } from "../../packages/core/src/util.js";
describe("质量关卡拒绝非法输入", () => {
  const opened: Array<ReturnType<typeof setup>> = [];
  afterEach(() => {
    for (const s of opened.splice(0)) s.store.close();
  });
  const fixture = () => {
    const s = setup();
    opened.push(s);
    s.store.put("workflow", "wf", "p", {
      id: "wf",
      project_id: "p",
      state: "REVIEWING",
      stage: "quality_before_human",
      plan_revision: 1,
      run_id: "run",
      version: 1,
    });
    return { s, q: new QualityCoordinator(s.store) };
  };
  const result = () => ({
    workflow_id: "wf",
    run_id: "run",
    phase: "before_human",
    cycle: 1,
    verdict: "passed",
    plan_revision: 1,
    reviewed_at: now(),
  });
  it("有缺陷不能声明 passed，也不能创建关卡或增加计数", () => {
    const { s, q } = fixture();
    const r = {
      ...result(),
      findings: [
        {
          finding_id: "F1",
          severity: "minor",
          evidence: "实际缺陷",
          impact: "错误",
          cause: "遗漏",
        },
      ],
    };
    expect(QualityReviewResultSchema.safeParse(r).success).toBe(false);
    expect(q.evaluateReviewResult("wf", r).action).toBe("retry_incomplete");
    expect(s.store.list("quality_gate")).toEqual([]);
  });
  it("缺少真实已结束的审查 Run 时拒绝放行", () => {
    const { q } = fixture();
    expect(q.evaluateReviewResult("wf", result()).message).toContain(
      "REVIEW_BINDING_INVALID",
    );
    expect(q.getGate("wf", "before_human")).toBeUndefined();
  });
  it("规划阶段不得提前审查", () => {
    const { s, q } = fixture();
    s.store.put("workflow", "wf", "p", {
      ...s.store.must<any>("workflow", "wf"),
      state: "PLANNING",
    });
    expect(q.evaluateReviewResult("wf", result()).action).toBe(
      "retry_incomplete",
    );
  });
  it("incomplete 不计失败，未达三次不能接管", () => {
    const { q } = fixture();
    expect(
      q.evaluateReviewResult("wf", { ...result(), verdict: "incomplete" })
        .rejectionCount,
    ).toBe(0);
    expect(() => q.startPlannerTakeover("wf")).toThrow();
  });
  it("两道关卡分别初始化，空证据不能通过", () => {
    const { q } = fixture();
    expect(q.getOrCreateGate("wf", "before_human").executor_rejections).toBe(0);
    expect(q.getOrCreateGate("wf", "after_human").executor_rejections).toBe(0);
    expect(() => q.assertPassed("wf", "after_human")).toThrow();
  });
});
