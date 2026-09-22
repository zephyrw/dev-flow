import { describe, it, expect, afterEach, vi } from "vitest";
import { setup } from "../helpers.js";
import { QualityCoordinator } from "../../packages/core/src/quality-coordinator.js";
import { QualityReviewResultSchema } from "../../packages/contracts/src/quality.js";
import { now } from "../../packages/core/src/util.js";
import { getDefaultTemplate } from "../../packages/core/src/templates/default-template.js";
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
  it("有缺陷仍可解析；缺少有效审查 Run 时不创建关卡", () => {
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
    expect(QualityReviewResultSchema.safeParse(r).success).toBe(true);
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

  it("旧版三次拒绝计数缺少真实整改记录时不能接管", () => {
    const { s, q } = fixture();
    s.store.put("quality_gate", q.getGateKey("wf", "before_human"), "wf", {
      ...q.getOrCreateGate("wf", "before_human"),
      executor_rejections: 3,
      takeover: true,
      status: "rejected",
    });
    expect(q.canTakeOver("wf", "before_human")).toBe(false);
    expect(() => q.startPlannerTakeover("wf")).toThrow();
    expect(getDefaultTemplate().quality.first_failed_delivery_counts).toBe(
      undefined,
    );
    expect(getDefaultTemplate().quality_policy_version).toBe(2);
  });

  it("完整通过清除连续失败与接管归属，重复结果保持幂等", () => {
    const { s, q } = fixture();
    const gate = q.getOrCreateGate("wf", "before_human");
    s.store.put("quality_gate", q.getGateKey("wf", "before_human"), "wf", {
      ...gate,
      executor_rejections: 2,
      failed_repair_review_ids: ["old-1", "old-2"],
      status: "rejected",
    });
    s.store.put("repair_assignment", "wf", "wf", {
      planner: false,
      phase: "before_human",
    });
    s.store.put("run", "run", "wf", {
      id: "run",
      workflow_id: "wf",
      plan_revision: 1,
      stage: "quality_before_human",
      status: "completed",
      exit_code: 0,
    });
    vi.spyOn(q, "fingerprint").mockReturnValue({
      plan_hash: "plan",
      run_id: "run",
      context: "context",
    });
    const input = { ...result(), feedback_cursor: 0 };
    const decision = q.evaluateReviewResult("wf", input);
    expect(decision.action).toBe("pass");
    expect(q.evaluateReviewResult("wf", input)).toEqual(decision);
    expect(q.getGate("wf", "before_human")).toMatchObject({
      executor_rejections: 0,
      failed_repair_review_ids: [],
      takeover: false,
      status: "passed",
    });
    expect(s.store.get("repair_assignment", "wf")).toBeUndefined();
  });

  it("缺省 reviewed_at 重投同一结论保持幂等", () => {
    const { s, q } = fixture();
    s.store.put("run", "run", "wf", {
      id: "run",
      workflow_id: "wf",
      plan_revision: 1,
      stage: "quality_before_human",
      status: "completed",
      exit_code: 0,
    });
    vi.spyOn(q, "fingerprint").mockReturnValue({
      plan_hash: "plan",
      run_id: "run",
      context: "context",
    });
    const first = q.evaluateReviewResult("wf", {
      workflow_id: "wf",
      run_id: "run",
      phase: "before_human",
      cycle: 1,
      verdict: "passed",
      plan_revision: 1,
    });
    const second = q.evaluateReviewResult("wf", {
      workflow_id: "wf",
      run_id: "run",
      phase: "before_human",
      cycle: 1,
      verdict: "passed",
      plan_revision: 1,
    });
    expect(first.action).toBe("pass");
    expect(second).toEqual(first);
  });

  it("整改计数只关联当前 assignment 指定的实现运行", () => {
    const { s, q } = fixture();
    const gate = q.getOrCreateGate("wf", "before_human");
    s.store.put("quality_gate", q.getGateKey("wf", "before_human"), "wf", {
      ...gate,
      executor_rejections: 0,
      failed_repair_review_ids: [],
      current_review_id: "old-review",
      status: "rejected",
    });
    s.store.put("repair_assignment", "wf", "wf", {
      assignment_id: "asg-1",
      planner: false,
      phase: "before_human",
      source: "quality_review",
      source_review_id: "old-review",
      plan_revision: 1,
      repair_run_id: "repair-run",
    });
    s.store.put("quality_review", "old-review", "wf", {
      workflow_id: "wf",
      phase: "before_human",
      verdict: "changes_required",
    });
    s.store.put("run", "initial-implementation", "wf", {
      id: "initial-implementation",
      workflow_id: "wf",
      plan_revision: 1,
      purpose: "implement",
      status: "completed",
      exit_code: 0,
      started_at: "2026-09-18T00:00:00.000Z",
    });
    s.store.put("run", "repair-run", "wf", {
      id: "repair-run",
      workflow_id: "wf",
      plan_revision: 1,
      purpose: "implement",
      status: "completed",
      exit_code: 0,
      started_at: "2026-09-18T01:00:00.000Z",
    });
    s.store.put("run", "run", "wf", {
      id: "run",
      workflow_id: "wf",
      plan_revision: 1,
      stage: "quality_before_human",
      status: "completed",
      exit_code: 0,
    });
    const counted = q.evaluateReviewResult("wf", {
      ...result(),
      verdict: "changes_required",
      findings: [
        {
          finding_id: "F1",
          evidence: "仍有问题",
          impact: "错误",
          cause: "遗漏",
        },
      ],
    });
    expect(counted.rejectionCount).toBe(1);
    expect(counted.action).toBe("repair_by_executor");
  });

  it("省略 cycle 的同一拒绝结果重投保持幂等", () => {
    const { s, q } = fixture();
    const gate = q.getOrCreateGate("wf", "before_human");
    s.store.put("quality_gate", q.getGateKey("wf", "before_human"), "wf", {
      ...gate,
      executor_rejections: 0,
      failed_repair_review_ids: [],
      current_review_id: "old-review",
      status: "rejected",
    });
    s.store.put("repair_assignment", "wf", "wf", {
      assignment_id: "asg-1",
      planner: false,
      phase: "before_human",
      source: "quality_review",
      source_review_id: "old-review",
      plan_revision: 1,
      repair_run_id: "repair-run",
    });
    s.store.put("quality_review", "old-review", "wf", {
      workflow_id: "wf",
      phase: "before_human",
      verdict: "changes_required",
    });
    s.store.put("run", "repair-run", "wf", {
      id: "repair-run",
      workflow_id: "wf",
      plan_revision: 1,
      purpose: "implement",
      status: "completed",
      exit_code: 0,
    });
    s.store.put("run", "run", "wf", {
      id: "run",
      workflow_id: "wf",
      plan_revision: 1,
      stage: "quality_before_human",
      status: "completed",
      exit_code: 0,
    });
    const input = {
      workflow_id: "wf",
      run_id: "run",
      phase: "before_human",
      verdict: "changes_required",
      plan_revision: 1,
      findings: [
        {
          finding_id: "F1",
          evidence: "仍有问题",
          impact: "错误",
          cause: "遗漏",
        },
      ],
    };
    const first = q.evaluateReviewResult("wf", input);
    const second = q.evaluateReviewResult("wf", input);
    expect(first.action).toBe("repair_by_executor");
    expect(second).toEqual(first);
    expect(q.getGate("wf", "before_human")?.executor_rejections).toBe(1);
  });

  it("同 finding_id 但问题正文不同视为冲突", () => {
    const { s, q } = fixture();
    s.store.put("run", "run", "wf", {
      id: "run",
      workflow_id: "wf",
      plan_revision: 1,
      stage: "quality_before_human",
      status: "completed",
      exit_code: 0,
    });
    const first = q.evaluateReviewResult("wf", {
      ...result(),
      verdict: "changes_required",
      findings: [
        {
          finding_id: "F1",
          evidence: "证据A",
          impact: "错误",
          cause: "遗漏",
        },
      ],
    });
    const second = q.evaluateReviewResult("wf", {
      ...result(),
      verdict: "changes_required",
      findings: [
        {
          finding_id: "F1",
          evidence: "证据B",
          impact: "错误",
          cause: "遗漏",
        },
      ],
    });
    expect(first.action).toBe("repair_by_executor");
    expect(second.message).toContain("IDEMPOTENCY_CONFLICT");
  });

  it("失败尝试后的成功完成事件计入一次整改", () => {
    const { s, q } = fixture();
    const gate = q.getOrCreateGate("wf", "before_human");
    s.store.put("quality_gate", q.getGateKey("wf", "before_human"), "wf", {
      ...gate,
      executor_rejections: 0,
      failed_repair_review_ids: [],
      current_review_id: "old-review",
      status: "rejected",
    });
    s.store.put("repair_assignment", "wf", "wf", {
      assignment_id: "asg-1",
      planner: false,
      phase: "before_human",
      source: "quality_review",
      source_review_id: "old-review",
      plan_revision: 1,
      repair_run_id: "failed-run",
    });
    s.store.put("quality_review", "old-review", "wf", {
      workflow_id: "wf",
      phase: "before_human",
      verdict: "changes_required",
    });
    s.store.put("run", "failed-run", "wf", {
      id: "failed-run",
      workflow_id: "wf",
      plan_revision: 1,
      purpose: "implement",
      status: "failed",
      exit_code: 1,
    });
    s.store.put("run", "retry-run", "wf", {
      id: "retry-run",
      workflow_id: "wf",
      plan_revision: 1,
      purpose: "implement",
      status: "completed",
      exit_code: 0,
    });
    s.store.put("run", "run", "wf", {
      id: "run",
      workflow_id: "wf",
      plan_revision: 1,
      stage: "quality_before_human",
      status: "completed",
      exit_code: 0,
    });
    s.store.put("execution_completion", "retry-run", "wf", {
      run_id: "retry-run",
      workflow_id: "wf",
      intent: "completed",
      assignment_id: "asg-1",
      recorded_at: now(),
    });
    const counted = q.evaluateReviewResult("wf", {
      ...result(),
      verdict: "changes_required",
      findings: [
        {
          finding_id: "F1",
          evidence: "仍有问题",
          impact: "错误",
          cause: "遗漏",
        },
      ],
    });
    expect(counted.rejectionCount).toBe(1);
    expect(counted.action).toBe("repair_by_executor");
  });

  it("省略 cycle 的通过结果重投保持幂等", () => {
    const { s, q } = fixture();
    s.store.put("run", "run", "wf", {
      id: "run",
      workflow_id: "wf",
      plan_revision: 1,
      stage: "quality_before_human",
      status: "completed",
      exit_code: 0,
    });
    vi.spyOn(q, "fingerprint").mockReturnValue({
      plan_hash: "plan",
      run_id: "run",
      context: "context",
    });
    const input = {
      workflow_id: "wf",
      run_id: "run",
      phase: "before_human",
      verdict: "passed",
      plan_revision: 1,
    };
    const first = q.evaluateReviewResult("wf", input);
    const second = q.evaluateReviewResult("wf", input);
    expect(first.action).toBe("pass");
    expect(second).toEqual(first);
  });

  it("缺省 cycle 复用首次 canonical，不读取变化后的当前 gate", () => {
    const { s, q } = fixture();
    s.store.put("run", "run", "wf", {
      id: "run",
      workflow_id: "wf",
      plan_revision: 1,
      stage: "quality_before_human",
      status: "completed",
      exit_code: 0,
    });
    const input = {
      workflow_id: "wf",
      run_id: "run",
      phase: "before_human",
      verdict: "changes_required",
      plan_revision: 1,
      findings: [
        {
          finding_id: "F1",
          evidence: "仍有问题",
          impact: "错误",
          cause: "遗漏",
        },
      ],
    };
    const first = q.evaluateReviewResult("wf", input);
    expect(first.action).toBe("repair_by_executor");
    const gate = q.getGate("wf", "before_human");
    expect(gate?.cycle).toBe(2);
    s.store.put("quality_gate", q.getGateKey("wf", "before_human"), "wf", {
      ...gate!,
      cycle: 9,
    });
    const replay = q.prepareQualityTransfer("wf", input);
    expect(replay.decision).toEqual(first);
    expect(replay.cycle).toBe(1);
    expect(replay.next_assignment_id).toBe(
      s.store.get<any>("repair_assignment", "wf")?.assignment_id,
    );
    expect(q.evaluateReviewResult("wf", input)).toEqual(first);
    expect(q.getGate("wf", "before_human")?.executor_rejections).toBe(0);
  });

  it("prepare 不写库，事务中断后 apply 全部回滚", () => {
    const { s, q } = fixture();
    s.store.put("run", "run", "wf", {
      id: "run",
      workflow_id: "wf",
      plan_revision: 1,
      stage: "quality_before_human",
      status: "completed",
      exit_code: 0,
    });
    const transfer = q.prepareQualityTransfer("wf", {
      ...result(),
      verdict: "changes_required",
      findings: [
        {
          finding_id: "F1",
          evidence: "仍有问题",
          impact: "错误",
          cause: "遗漏",
        },
      ],
    });
    expect(transfer.write).toBe("full");
    expect(q.getGate("wf", "before_human")).toBeUndefined();
    expect(s.store.get("repair_assignment", "wf")).toBeUndefined();
    expect(s.store.get("quality_eval_dedup", "wf:run")).toBeUndefined();
    expect(() =>
      s.store.transaction(() => {
        q.applyQualityTransfer(transfer);
        throw new Error("interrupt");
      }),
    ).toThrow("interrupt");
    expect(q.getGate("wf", "before_human")).toBeUndefined();
    expect(s.store.get("repair_assignment", "wf")).toBeUndefined();
    expect(s.store.get("quality_review", "run")).toBeUndefined();
  });

  it("apply 同事务写入 gate 与 assignment，幂等重投不双计不改派发", () => {
    const { s, q } = fixture();
    s.store.put("run", "run", "wf", {
      id: "run",
      workflow_id: "wf",
      plan_revision: 1,
      stage: "quality_before_human",
      status: "completed",
      exit_code: 0,
    });
    const transfer = q.prepareQualityTransfer("wf", {
      ...result(),
      verdict: "changes_required",
      findings: [
        {
          finding_id: "F1",
          evidence: "仍有问题",
          impact: "错误",
          cause: "遗漏",
        },
      ],
    });
    s.store.transaction(() => q.applyQualityTransfer(transfer));
    expect(q.getGate("wf", "before_human")?.current_review_id).toBe("run");
    expect(s.store.get<any>("repair_assignment", "wf")).toMatchObject({
      assignment_id: transfer.next_assignment_id,
      source_review_id: "run",
      planner: false,
    });
    const replay = q.prepareQualityTransfer("wf", {
      ...result(),
      verdict: "changes_required",
      findings: [
        {
          finding_id: "F1",
          evidence: "仍有问题",
          impact: "错误",
          cause: "遗漏",
        },
      ],
    });
    expect(replay.write).toBe("none");
    expect(replay.next_assignment_id).toBe(transfer.next_assignment_id);
    s.store.transaction(() => q.applyQualityTransfer(replay));
    expect(q.getGate("wf", "before_human")?.executor_rejections).toBe(0);
    expect(s.store.list("repair_assignment", "wf")).toHaveLength(1);
  });

  it("人工前与人工后两阶段计数互不影响", () => {
    const { s, q } = fixture();
    s.store.put("run", "run", "wf", {
      id: "run",
      workflow_id: "wf",
      plan_revision: 1,
      stage: "quality_before_human",
      status: "completed",
      exit_code: 0,
    });
    q.evaluateReviewResult("wf", {
      ...result(),
      verdict: "changes_required",
      findings: [
        {
          finding_id: "F1",
          evidence: "人工前问题",
          impact: "错误",
          cause: "遗漏",
        },
      ],
    });
    s.store.put("workflow", "wf", "p", {
      ...s.store.must<any>("workflow", "wf"),
      run_id: "after-run",
    });
    s.store.put("plan_check_review_intent", "wf", "wf", {
      phase: "after_human",
    });
    s.store.put("run", "after-run", "wf", {
      id: "after-run",
      workflow_id: "wf",
      plan_revision: 1,
      stage: "review",
      status: "completed",
      exit_code: 0,
    });
    q.evaluateReviewResult("wf", {
      workflow_id: "wf",
      run_id: "after-run",
      phase: "after_human",
      cycle: 1,
      verdict: "changes_required",
      plan_revision: 1,
      findings: [
        {
          finding_id: "F2",
          evidence: "人工后问题",
          impact: "错误",
          cause: "遗漏",
        },
      ],
    });
    expect(q.getGate("wf", "before_human")?.executor_rejections).toBe(0);
    expect(q.getGate("wf", "after_human")?.executor_rejections).toBe(0);
    expect(q.getGate("wf", "before_human")?.current_review_id).toBe("run");
    expect(q.getGate("wf", "after_human")?.current_review_id).toBe("after-run");
  });

  it("半写入只按首次决定补齐一次派发，不重评不重新计数", () => {
    const { s, q } = fixture();
    s.store.put("run", "run", "wf", {
      id: "run",
      workflow_id: "wf",
      plan_revision: 1,
      stage: "quality_before_human",
      status: "completed",
      exit_code: 0,
    });
    const input = {
      ...result(),
      verdict: "changes_required",
      findings: [
        {
          finding_id: "F1",
          evidence: "仍有问题",
          impact: "错误",
          cause: "遗漏",
        },
      ],
    };
    const first = q.prepareQualityTransfer("wf", input);
    s.store.transaction(() => q.applyQualityTransfer(first));
    s.store.put("quality_gate", q.getGateKey("wf", "before_human"), "wf", {
      ...q.getGate("wf", "before_human")!,
      executor_rejections: 0,
      failed_repair_review_ids: [],
      takeover: false,
    });
    s.store.remove("repair_assignment", "wf");
    s.store.put("quality_eval_dedup", "wf:run", "wf", {
      ...s.store.must<any>("quality_eval_dedup", "wf:run"),
      assignment_applied: false,
    });
    const recovered = q.recoverQualityDispatch("wf", "before_human");
    expect(recovered?.write).toBe("backfill");
    expect(recovered?.decision.action).toBe("repair_by_executor");
    expect(recovered?.next_assignment_id).toBe(first.next_assignment_id);
    s.store.transaction(() => q.applyQualityTransfer(recovered!));
    expect(q.getGate("wf", "before_human")?.executor_rejections).toBe(0);
    expect(s.store.get<any>("repair_assignment", "wf")?.assignment_id).toBe(
      first.next_assignment_id,
    );
    const again = q.recoverQualityDispatch("wf", "before_human");
    expect(again?.write).toBe("none");
    expect(q.evaluateReviewResult("wf", input).action).toBe(
      "repair_by_executor",
    );
    expect(q.getGate("wf", "before_human")?.executor_rejections).toBe(0);
  });
});
