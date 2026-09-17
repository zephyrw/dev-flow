import { describe, it, expect } from "vitest";
import {
  fixture,
  runtime,
  until,
  cleanup,
  passReview,
  type Fixture,
} from "../fixtures/native-flow.js";
import { proof } from "../helpers.js";
import { hash, now } from "../../packages/core/src/util.js";
import type { Workflow, Run } from "../../packages/contracts/src/index.js";
import { reviewContractContext } from "../../packages/runtime/src/review-materials.js";
import { workflowAttention } from "../../packages/core/src/attention.js";
function failReview(s: Fixture, w: Workflow, run: Run) {
  const phase =
    w.stage === "quality_before_human" ? "before_human" : "after_human";
  const body =
    (s.engine.plan(s.w.id).plan.markdown ?? "") +
    "\n## R1\n核对 app.txt 为 after 并运行原始单元测试，保留换行及其他文件。不得另建计划。\n";
  const repair = structuredClone(s.engine.plan(w.id).plan);
  repair.markdown = body;
  return {
    ...passReview(w),
    verdict: "findings",
    repair_plan: repair,
    repair_document: body,
    findings: [
      {
        id: "F1",
        severity: "P2",
        repo_id: "main",
        path: "app.txt",
        line: 1,
        trigger: "复核文本输出",
        evidence: "受控质量检查未满足",
        consequence: "输出不符",
        relation_to_change: "in_scope",
        disposition: "confirmed",
        reason: "测试夹具强制拒绝，验证正式整改后的调度",
      },
    ],
    quality: {
      workflow_id: w.id,
      run_id: run.id,
      phase,
      cycle: s.engine.quality.getOrCreateGate(w.id, phase).cycle,
      verdict: "changes_required",
      function_impact: "none",
      plan_revision: w.plan_revision,
      feedback_cursor: 0,
      reviewed_at: now(),
      findings: [
        {
          finding_id: "F1",
          severity: "major",
          repo_id: "main",
          evidence_locations: ["app.txt:1"],
          evidence: "文本质量检查失败",
          impact: "不满足计划",
          cause: "遗漏核验",
          verification_type: "statically_confirmed",
        },
      ],
      repair_plan: [
        {
          repair_item_id: "R1",
          finding_ids: ["F1"],
          design_section: "R1",
          evidence_locations: ["app.txt:1"],
          reproduction: "读取 app.txt",
          expected_actual: "期望完整匹配",
          root_cause: "遗漏核验",
          allowed_changes: [
            {
              repo_id: "main",
              path: "app.txt",
              symbol: "content",
              action: "modify",
              purpose: "满足原计划",
            },
          ],
          forbidden_changes: ["其他文件"],
          preserved_behaviors: ["保留换行"],
          implementation_steps: [
            {
              sequence: 1,
              depends_on: [],
              action: "核对文本",
              input: "app.txt",
              output: "after 加换行",
              algorithm: "完整匹配",
              pre_conditions: "原计划已批准",
              post_conditions: "内容符合",
              interfaces: "无接口变化",
              state_and_transaction_rules: "单文件原子写",
              idempotency_and_recovery: "重复执行结果一致",
            },
          ],
          acceptance_cases: [
            {
              case_id: "UT01",
              layer: "unit",
              fixtures: "app.txt",
              steps: ["运行原始文本检查"],
              expected_assertions: ["after 加换行"],
              pre_fix_failure: "不匹配",
            },
          ],
          regression_cases: ["其余文件保持不变"],
          regression_impact_rationale: "局部纯文本变更",
          completion_evidence: ["真实原始报告"],
          stop_conditions: ["范围冲突即停止"],
          function_impact: "none",
          function_impact_explanation: "实现既有计划，无新增行为",
          document_revision: w.plan_revision + 1,
          document_hash: hash(body),
          document_anchor: "#r1",
        },
      ],
    },
  };
}
describe("质量审查生产调度闭环", { timeout: 1500000 }, () => {
  it("审查材料缺失由规划模型补全，首次完整发现问题仍不计整改失败", async () => {
    const s = await fixture();
    const base = runtime(s);
    let reviews = 0;
    s.engine.runtime = {
      ...base,
      async review(w, r) {
        reviews++;
        const context = reviewContractContext(s.engine, w, r);
        expect(context.run_id).toBe(r.id);
        if (reviews === 1)
          return {
            ...failReview(s, w, r),
            verdict: "incomplete",
            quality: null,
            unresolved_questions: ["缺少整改合同资料"],
          };
        if (reviews <= 3) {
          expect(context.completion?.attempts[0]?.review).toMatchObject({
            findings: [{ id: "F1" }],
          });
          expect(workflowAttention(s.engine, w.id)?.message).toContain(
            "无需你编写",
          );
          expect(
            s.engine.quality.getGate(w.id, "before_human")?.executor_rejections,
          ).toBe(0);
          if (reviews === 2) return passReview(w); // Dropping F1 must not evade review.
          return failReview(s, w, r);
        }
        expect(context.completion).toBeNull(); // The new repair plan has fresh input.
        return passReview(w);
      },
    };
    try {
      await until(s, ["HUMAN_PENDING", "BLOCKED", "REPAIR_PLAN_PENDING"]);
      expect(s.engine.get(s.w.id).blocker).toBeUndefined();
      expect(s.engine.get(s.w.id).state).toBe("HUMAN_PENDING");
      expect(reviews).toBe(4);
      expect(s.engine.get(s.w.id).plan_revision).toBe(2);
      expect(s.engine.quality.getGate(s.w.id, "before_human")).toMatchObject({
        executor_rejections: 0,
        takeover: false,
      });
      expect(s.store.list("acceptance", s.w.id)).toHaveLength(0);
    } finally {
      await cleanup(s);
    }
  });

  it("畸形整改最多自动补全两次，保留原交付，人工重试仍回到人工前复核", async () => {
    const s = await fixture();
    const base = runtime(s);
    let reviews = 0;
    s.engine.runtime = {
      ...base,
      async review(w, r) {
        reviews++;
        reviewContractContext(s.engine, w, r);
        const malformed: any = failReview(s, w, r);
        delete malformed.quality.repair_plan[0].root_cause;
        if (reviews === 1) malformed.findings = [null];
        return malformed;
      },
    };
    try {
      await until(s, ["BLOCKED", "HUMAN_PENDING"]);
      expect(reviews).toBe(3);
      expect(s.engine.get(s.w.id).blocker?.code).toBe(
        "REVIEW_COMPLETION_EXHAUSTED",
      );
      expect(
        s.engine.quality.getGate(s.w.id, "before_human")?.executor_rejections,
      ).toBe(0);
      const snapshot = s.engine.get(s.w.id).snapshot_id;
      const delivery = s.engine.planSelfCheck.current(s.w.id);
      s.engine.runtime = undefined;
      await s.engine.retryReview(s.w.id);
      expect(s.engine.get(s.w.id)).toMatchObject({
        state: "REVIEW_QUEUED",
        stage: "quality_before_human",
        snapshot_id: snapshot,
        plan_revision: 1,
      });
      expect(s.engine.planSelfCheck.current(s.w.id)).toEqual(delivery);
      expect(s.store.get("acceptance", s.w.id)).toBeUndefined();
    } finally {
      await cleanup(s);
    }
  });

  it("用户在补全排队时暂停，不再次调用复核模型", async () => {
    const s = await fixture();
    let reviews = 0;
    s.engine.runtime = {
      ...runtime(s),
      async review(w, r) {
        reviews++;
        return { ...failReview(s, w, r), verdict: "incomplete", quality: null };
      },
    };
    let stopping: Promise<unknown> | undefined;
    s.store.on("event", (event) => {
      if (event.type === "ReviewCompletionQueued")
        stopping = s.engine.stop(s.w.id);
    });
    try {
      await until(s, ["STOPPED", "BLOCKED"]);
      await stopping;
      expect(s.engine.get(s.w.id).state).toBe("STOPPED");
      expect(reviews).toBe(1);
      expect(s.store.get("queue", s.w.id)).toBeUndefined();
    } finally {
      await cleanup(s);
    }
  });

  it("两关首次发现问题均不计数，三次完整整改仍被拒绝才接管，通过后清零并真实提交", async () => {
    const s = await fixture();
    const counts = { before_human: 0, after_human: 0 };
    const base = runtime(s);
    const ownership: Array<[string, string, string]> = [];
    s.engine.runtime = {
      ...base,
      async execute(w, r, t) {
        ownership.push([r.stage, r.adapter, r.purpose!]);
        if (r.purpose === "planner_takeover") {
          const phase = s.store.must<any>("repair_assignment", w.id).phase as
            | "before_human"
            | "after_human";
          expect(counts[phase]).toBe(4); // Initial finding plus three completed repairs.
          expect(s.engine.quality.canTakeOver(w.id, phase)).toBe(true);
        }
        await base.execute(w, r, t);
      },
      async review(w, r) {
        s.stages.push(r.stage);
        const phase =
          w.stage === "quality_before_human" ? "before_human" : "after_human";
        counts[phase]++;
        expect(s.engine.quality.getOrCreateGate(w.id, phase).executor_rejections)
          .toBe(Math.max(0, Math.min(3, counts[phase] - 2)));
        return counts[phase] <= 4 ? failReview(s, w, r) : passReview(w);
      },
    };
    try {
      await until(
        s,
        ["HUMAN_PENDING", "BLOCKED", "REPAIR_PLAN_PENDING"],
        660000,
      );
      expect(s.engine.get(s.w.id).blocker).toBeUndefined();
      expect(s.engine.get(s.w.id).state).toBe("HUMAN_PENDING");
      expect(counts.before_human).toBe(5);
      expect(s.engine.quality.getGate(s.w.id, "before_human")).toMatchObject({
        executor_rejections: 0,
        takeover: false,
        status: "passed",
      });
      expect(
        s.engine.quality.getOrCreateGate(s.w.id, "after_human")
          .executor_rejections,
      ).toBe(0);
      const p = proof(s.engine, s.w.id, "accept");
      await s.engine.accept(s.w.id, p.proof, p.binding);
      await until(
        s,
        ["COMMITTED", "BLOCKED", "REPAIR_PLAN_PENDING", "COMMIT_PARTIAL"],
        660000,
      );
      expect(s.engine.get(s.w.id).blocker).toBeUndefined();
      expect(s.engine.get(s.w.id).state).toBe("COMMITTED");
      expect(counts.after_human).toBe(5);
      expect(s.engine.quality.getGate(s.w.id, "after_human")).toMatchObject({
        executor_rejections: 0,
        takeover: false,
        status: "passed",
      });
      expect(
        ownership.filter(([stage]) => stage === "planner_takeover"),
      ).toHaveLength(2);
      expect(
        ownership
          .filter(([stage]) => stage === "planner_takeover")
          .every(([, adapter]) => adapter === "codex"),
      ).toBe(true);
      for (const phase of ["before_human", "after_human"])
        expect(
          s.store.list<any>("quality_review", s.w.id).filter(
            (review) => review.phase === phase && review.executor_repair_run_id,
          ),
        ).toHaveLength(3);
      expect(s.store.list("commit_result", s.w.id)).toHaveLength(1);
    } finally {
      await cleanup(s);
    }
  });
  it("伪造通过、旧轮次和 incomplete 不得增加计数或进入人工", async () => {
    const s = await fixture();
    try {
      const invalid = {
        workflow_id: s.w.id,
        run_id: "fake",
        phase: "before_human",
        cycle: 1,
        verdict: "passed",
        plan_revision: 1,
        reviewed_at: now(),
      };
      expect(
        s.engine.quality.evaluateReviewResult(s.w.id, invalid).action,
      ).toBe("retry_incomplete");
      expect(
        s.engine.quality.evaluateReviewResult(s.w.id, {
          ...invalid,
          verdict: "incomplete",
        }).action,
      ).toBe("retry_incomplete");
      expect(s.engine.quality.getGate(s.w.id, "before_human")).toBeUndefined();
      expect(s.engine.get(s.w.id).state).toBe("QUEUED");
    } finally {
      await cleanup(s);
    }
  });
});
